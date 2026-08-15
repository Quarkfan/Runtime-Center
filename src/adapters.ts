import { query, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import {
  Agent,
  Runner,
  Usage,
  tool,
  type Model,
  type AgentInputItem,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
} from "@openai/agents";
import { createHash } from "node:crypto";
import type { PlatformClients } from "./clients.js";
import type { Execution } from "./types.js";
export interface RuntimeContext {
  execution: Execution;
  workspace: string;
  history: Array<{ role: "user" | "assistant"; content: string; at: string }>;
  abortController: AbortController;
  contextItems: any[];
  capabilities: any[];
  emit: (type: any, data: Record<string, unknown>) => Promise<void>;
}
export interface AgentRuntime {
  kind: Execution["runtime"];
  run(v: RuntimeContext): Promise<{ response: string; sessionId?: string }>;
}
const outputText = (v: unknown): string => {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(outputText).filter(Boolean).join("\n");
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return outputText(o.content ?? o.text ?? o.message ?? JSON.stringify(v));
  }
  return String(v ?? "");
};
export class ModelToolLoopRuntime implements AgentRuntime {
  kind = "model-tool-loop" as const;
  constructor(
    readonly clients: PlatformClients,
    readonly maxToolTurns = 8,
  ) {}
  async run(v: RuntimeContext) {
    const context = v.contextItems.map((x) => x.content).join("\n\n"),
      skillInstructions = v.capabilities
        .filter((item) => item.manifest.kind === "skill")
        .map((item) => {
          const files = item.manifest.raw?.skill?.files;
          const skill = Array.isArray(files)
            ? files.find((file: any) => file.path === "SKILL.md")?.content
            : undefined;
          return skill
            ? `Skill ${item.manifest.name}:\n${skill}`
            : `Skill ${item.manifest.name}: ${item.manifest.description}`;
        })
        .join("\n\n"),
      toolMap = new Map<string, any>(),
      tools = v.capabilities
        .filter(
          (item) =>
            item.manifest.kind !== "skill" &&
            item.manifest.runtime?.type !== "prompt",
        )
        .map((x) => {
          const name = safeToolName(x.manifest.id);
          toolMap.set(name, x);
          return {
            type: "function",
            function: {
              name,
              description: x.manifest.description,
              parameters: x.manifest.inputSchema,
            },
          };
        }),
      messages: Array<Record<string, unknown>> = [
        ...(v.execution.systemPrompt
          ? [{ role: "system", content: v.execution.systemPrompt }]
          : []),
        ...(context
          ? [{ role: "system", content: `Authorized context:\n${context}` }]
          : []),
        ...(skillInstructions
          ? [
              {
                role: "system",
                content: `Authorized Skills:\n${skillInstructions}`,
              },
            ]
          : []),
        ...v.history.map(({ role, content }) => ({ role, content })),
        { role: "user", content: v.execution.prompt },
      ];
    for (let turn = 0; turn <= this.maxToolTurns; turn++) {
      v.abortController.signal.throwIfAborted();
      await v.emit("progress", {
        message: "Invoking Model Hub",
        turn,
      });
      const result = await this.clients.model(
        {
          policyId: v.execution.modelPolicyId,
          kind: "chat",
          messages,
          tools,
          correlationId: `${v.execution.id}:${turn}`,
        },
        v.abortController.signal,
      );
      v.abortController.signal.throwIfAborted();
      const toolCalls = normalizeToolCalls(result.output);
      if (!toolCalls.length) return { response: outputText(result.output) };
      if (turn === this.maxToolTurns)
        throw new Error(`Maximum tool turns exceeded (${this.maxToolTurns})`);
      const assistantText = outputText(
        (result.output as Record<string, unknown>)?.text ?? "",
      );
      messages.push({
        role: "assistant",
        content: assistantText,
        toolCalls,
      });
      for (const call of toolCalls) {
        const capability = toolMap.get(call.name);
        if (!capability)
          throw new Error(`Model requested an unavailable tool: ${call.name}`);
        await v.emit("tool_call", {
          toolCallId: call.id,
          capabilityId: capability.manifest.id,
          input: call.input,
        });
        try {
          const invoked = await this.clients.invokeCapability(
            {
              tenantId: v.execution.tenantId,
              botId: v.execution.botId,
              capabilityId: capability.manifest.id,
              input: call.input,
              trigger:
                v.execution.source.type === "scheduled" ||
                v.execution.source.type === "continuation"
                  ? "scheduled"
                  : "agent",
              correlationId: `${v.execution.id}:${call.id}`,
              approvalId: v.execution.approvalId,
            },
            v.abortController.signal,
          );
          await v.emit("tool_result", {
            toolCallId: call.id,
            capabilityId: capability.manifest.id,
            status: "succeeded",
            output: invoked.output,
          });
          messages.push({
            role: "tool",
            toolCallId: call.id,
            name: call.name,
            content: JSON.stringify(invoked.output ?? null),
          });
        } catch (error) {
          if (
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "APPROVAL_REQUIRED"
          )
            throw error;
          const message =
            error instanceof Error ? error.message : String(error);
          await v.emit("tool_result", {
            toolCallId: call.id,
            capabilityId: capability.manifest.id,
            status: "failed",
            error: message,
          });
          messages.push({
            role: "tool",
            toolCallId: call.id,
            name: call.name,
            content: JSON.stringify({ error: message }),
          });
        }
      }
    }
    throw new Error("Tool loop ended unexpectedly");
  }
}

const safeToolName = (id: string) => {
  const base = id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48);
  const suffix = createHash("sha256").update(id).digest("hex").slice(0, 8);
  return `${base}_${suffix}`;
};

const normalizeToolCalls = (
  output: unknown,
): Array<{ id: string; name: string; input: Record<string, unknown> }> => {
  if (!output || typeof output !== "object" || Array.isArray(output)) return [];
  const source = output as Record<string, unknown>;
  const raw = Array.isArray(source.toolCalls)
    ? source.toolCalls
    : Array.isArray(source.tool_calls)
      ? source.tool_calls
      : [];
  return raw.flatMap((value, index) => {
    if (!value || typeof value !== "object") return [];
    const call = value as Record<string, unknown>;
    const fn =
      call.function && typeof call.function === "object"
        ? (call.function as Record<string, unknown>)
        : call;
    const name = String(call.name ?? fn.name ?? "");
    if (!name) return [];
    let input: Record<string, unknown> = {};
    const candidate = call.input ?? fn.arguments;
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate))
      input = candidate as Record<string, unknown>;
    else if (typeof candidate === "string") {
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
          input = parsed;
      } catch {
        input = { _raw: candidate };
      }
    }
    return [
      {
        id: String(call.id ?? `tool-${index}`),
        name,
        input,
      },
    ];
  });
};

class ModelHubModel implements Model {
  constructor(
    readonly clients: PlatformClients,
    readonly execution: Execution,
    readonly emit: RuntimeContext["emit"],
  ) {}

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    await this.emit("progress", {
      message: "OpenAI Agents SDK invoking Model Hub",
    });
    const result = await this.clients.model(
      {
        policyId: this.execution.modelPolicyId,
        kind: "chat",
        messages: modelRequestMessages(request),
        tools: request.tools
          .filter((candidate) => candidate.type === "function")
          .map((candidate) => ({
            type: "function",
            function: {
              name: candidate.name,
              description: candidate.description,
              parameters: candidate.parameters,
              strict: candidate.strict,
            },
          })),
        temperature: request.modelSettings.temperature ?? undefined,
        maxTokens: request.modelSettings.maxTokens ?? undefined,
        correlationId: `${this.execution.id}:openai-agents`,
      },
      request.signal,
    );
    const calls = normalizeToolCalls(result.output),
      text = outputText(
        result.output && typeof result.output === "object"
          ? (result.output as Record<string, unknown>).text ?? ""
          : result.output,
      ),
      output: ModelResponse["output"] = [];
    if (text)
      output.push({
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text }],
      });
    output.push(
      ...calls.map((call) => ({
        type: "function_call" as const,
        callId: call.id,
        name: call.name,
        arguments: JSON.stringify(call.input),
        status: "completed" as const,
      })),
    );
    const usage = result.usage ?? {};
    return {
      output,
      responseId: result.invocationId,
      usage: new Usage({
        requests: 1,
        inputTokens: Number(usage.inputTokens ?? 0),
        outputTokens: Number(usage.outputTokens ?? 0),
        totalTokens: Number(usage.totalTokens ?? 0),
      }),
      providerData: {
        deploymentId: result.deploymentId,
        providerId: result.providerId,
        modelId: result.modelId,
      },
    };
  }

  async *getStreamedResponse(): AsyncIterable<never> {
    throw new Error("Streaming is not enabled for the Model Hub bridge");
  }
}

class ModelHubProvider implements ModelProvider {
  constructor(readonly model: ModelHubModel) {}
  getModel() {
    return this.model;
  }
}

export class OpenAIAgentsRuntime implements AgentRuntime {
  kind = "openai-agents" as const;
  constructor(
    readonly clients: PlatformClients,
    readonly maxTurns = 8,
  ) {}

  async run(v: RuntimeContext) {
    const sdkTools = v.capabilities
        .filter(
          (item) =>
            item.manifest.kind !== "skill" &&
            item.manifest.runtime?.type !== "prompt",
        )
        .map((capability) => {
          const name = safeToolName(capability.manifest.id);
          return tool({
            name,
            description: capability.manifest.description,
            parameters: capability.manifest.inputSchema ?? {
              type: "object",
              additionalProperties: true,
            },
            strict: false,
            errorFunction: null,
            execute: async (input, _runContext, details) => {
              const toolCallId =
                details?.toolCall?.callId ?? `${name}-${Date.now()}`;
              await v.emit("tool_call", {
                toolCallId,
                capabilityId: capability.manifest.id,
                input,
                runtime: this.kind,
              });
              try {
                const invoked = await this.clients.invokeCapability(
                  {
                    tenantId: v.execution.tenantId,
                    botId: v.execution.botId,
                    capabilityId: capability.manifest.id,
                    input,
                    trigger:
                      v.execution.source.type === "scheduled" ||
                      v.execution.source.type === "continuation"
                        ? "scheduled"
                        : "agent",
                    correlationId: `${v.execution.id}:${toolCallId}`,
                    approvalId: v.execution.approvalId,
                  },
                  details?.signal ?? v.abortController.signal,
                );
                await v.emit("tool_result", {
                  toolCallId,
                  capabilityId: capability.manifest.id,
                  status: "succeeded",
                  output: invoked.output,
                  runtime: this.kind,
                });
                return JSON.stringify(invoked.output ?? null);
              } catch (error) {
                await v.emit("tool_result", {
                  toolCallId,
                  capabilityId: capability.manifest.id,
                  status: "failed",
                  error: error instanceof Error ? error.message : String(error),
                  runtime: this.kind,
                });
                throw error;
              }
            },
          });
        }),
      context = v.contextItems.map((item) => item.content).join("\n\n"),
      skillInstructions = v.capabilities
        .filter((item) => item.manifest.kind === "skill")
        .map((item) => {
          const files = item.manifest.raw?.skill?.files,
            instructions = Array.isArray(files)
              ? files.find((file: any) => file.path === "SKILL.md")?.content
              : undefined;
          return instructions
            ? `Skill ${item.manifest.name}:\n${instructions}`
            : `Skill ${item.manifest.name}: ${item.manifest.description}`;
        })
        .join("\n\n"),
      instructions = [
        v.execution.systemPrompt ??
          "You are a QuarkfanTools managed Agent runtime.",
        context ? `Authorized context:\n${context}` : "",
        skillInstructions ? `Authorized Skills:\n${skillInstructions}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      model = new ModelHubModel(this.clients, v.execution, v.emit),
      runner = new Runner({
        modelProvider: new ModelHubProvider(model),
        tracingDisabled: true,
        traceIncludeSensitiveData: false,
        toolNameCollisionPolicy: "error",
      }),
      agent = new Agent({
        name: `QuarkfanTools ${v.execution.botId}`,
        instructions,
        model,
        tools: sdkTools,
      }),
      input: AgentInputItem[] = [
        ...v.history.map(({ role, content }) =>
          role === "user"
            ? ({ role: "user", content } as AgentInputItem)
            : ({
                type: "message",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: content }],
              } as AgentInputItem),
        ),
        { role: "user", content: v.execution.prompt },
      ];
    const result = await runner.run(agent, input, {
      maxTurns: this.maxTurns,
      signal: v.abortController.signal,
    });
    return {
      response:
        outputText(result.finalOutput).trim() ||
        "Completed without a text response.",
    };
  }
}

const modelRequestMessages = (
  request: ModelRequest,
): Array<Record<string, unknown>> => {
  const messages: Array<Record<string, unknown>> = request.systemInstructions
    ? [{ role: "system", content: request.systemInstructions }]
    : [];
  if (typeof request.input === "string") {
    messages.push({ role: "user", content: request.input });
    return messages;
  }
  for (const item of request.input as Array<Record<string, any>>) {
    if (item.type === "function_call") {
      messages.push({
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: item.callId,
            name: item.name,
            input: parseObject(item.arguments),
          },
        ],
      });
      continue;
    }
    if (item.type === "function_call_result") {
      messages.push({
        role: "tool",
        name: item.name,
        toolCallId: item.callId,
        content: outputText(item.output),
      });
      continue;
    }
    if (["system", "user", "assistant"].includes(item.role))
      messages.push({
        role: item.role,
        content: protocolContentText(item.content),
      });
  }
  return messages;
};

const protocolContentText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return outputText(content);
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return outputText(part);
      const value = part as Record<string, unknown>;
      return outputText(value.text ?? value.refusal ?? value.transcript ?? "");
    })
    .filter(Boolean)
    .join("\n");
};

const parseObject = (value: unknown): Record<string, unknown> => {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return { _raw: value };
  }
};

export class ClaudeCodeRuntime implements AgentRuntime {
  kind = "claude-code" as const;
  constructor(
    readonly config: {
      enabled: boolean;
      baseUrl?: string;
      authToken?: string;
      model?: string;
      maxTurns: number;
    },
  ) {}
  async run(v: RuntimeContext) {
    if (!this.config.enabled)
      throw new Error("Claude Code runtime is disabled");
    const mcp = Object.fromEntries(
      v.capabilities
        .filter(
          (x) => x.manifest.runtime.type === "mcp" && x.binding.config.command,
        )
        .map((x) => [
          x.manifest.id,
          {
            type: "stdio",
            command: String(x.binding.config.command),
            args: Array.isArray(x.binding.config.args)
              ? x.binding.config.args.map(String)
              : [],
            env: Object.fromEntries(
              Object.entries(x.binding.config.env ?? {}).map(([k, val]) => [
                k,
                String(val),
              ]),
            ),
          },
        ]),
    ) as Record<string, McpServerConfig>;
    const context = v.contextItems.map((x) => x.content).join("\n\n");
    let response = "",
      sessionId = v.execution.sessionId;
    for await (const item of query({
      prompt: [
        context ? `Authorized context:\n${context}` : "",
        v.execution.prompt,
      ]
        .filter(Boolean)
        .join("\n\n"),
      options: {
        abortController: v.abortController,
        cwd: v.workspace,
        env: {
          ...process.env,
          ANTHROPIC_BASE_URL: this.config.baseUrl,
          ANTHROPIC_AUTH_TOKEN: this.config.authToken,
          ANTHROPIC_API_KEY: this.config.authToken,
          ANTHROPIC_MODEL: this.config.model,
        },
        model: this.config.model,
        ...(sessionId ? { resume: sessionId } : {}),
        settingSources: [],
        skills: "all",
        tools: ["Skill", "Read", "Write", "Edit", "Glob", "Grep", "Bash"],
        allowedTools: [
          "Skill",
          "Read",
          "Write",
          "Edit",
          "Glob",
          "Grep",
          "Bash",
        ],
        mcpServers: mcp,
        strictMcpConfig: true,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        sandbox: {
          enabled: true,
          failIfUnavailable: true,
          autoAllowBashIfSandboxed: true,
          allowUnsandboxedCommands: false,
        },
        maxTurns: this.config.maxTurns,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append:
            v.execution.systemPrompt ??
            "You are a QuarkfanTools managed Agent runtime.",
        },
      },
    })) {
      sessionId = item.session_id || sessionId;
      if (item.type === "assistant")
        await v.emit("progress", { message: "assistant update" });
      if (item.type === "result") {
        if (item.subtype !== "success")
          throw new Error(item.errors.join("\n") || item.subtype);
        response = item.result;
      }
    }
    return {
      response: response.trim() || "Completed without a text response.",
      sessionId,
    };
  }
}
