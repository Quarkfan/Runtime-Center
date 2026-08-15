import type { PlatformClients } from "./clients.js";

interface WorkflowStepBase {
  id: string;
  name?: string;
  when?: { path: string; exists?: boolean; equals?: unknown };
  retry?: { maxAttempts: number; delayMs: number };
  timeoutMs: number;
}
type WorkflowStep = WorkflowStepBase &
  (
    | { type: "template"; template: string }
    | {
        type: "capability";
        capabilityId: string;
        input: Record<string, unknown>;
      }
    | {
        type: "model";
        prompt: string;
        systemPrompt?: string;
        modelPolicyId?: string;
      }
  );
export interface WorkflowDefinition {
  version: 1;
  timeoutMs: number;
  steps: WorkflowStep[];
  output?: string;
}

export class WorkflowRunner {
  constructor(readonly clients: PlatformClients) {}

  async run(input: {
    tenantId: string;
    botId: string;
    executionId: string;
    approvalId?: string;
    modelPolicyId?: string;
    prompt: string;
    arguments?: string;
    workflowInput: Record<string, unknown>;
    definition: WorkflowDefinition;
    completed?: Record<string, unknown>;
    signal: AbortSignal;
    emit: (type: string, data: Record<string, unknown>) => Promise<void>;
    checkpoint: (outputs: Record<string, unknown>) => Promise<void>;
  }) {
    const signal = AbortSignal.any([
      input.signal,
      AbortSignal.timeout(input.definition.timeoutMs),
    ]);
    const outputs = { ...(input.completed ?? {}) };
    const state = {
      input: input.workflowInput,
      args: input.arguments ?? "",
      text: input.prompt,
      steps: outputs,
    };
    for (const [index, step] of input.definition.steps.entries()) {
      signal.throwIfAborted();
      if (Object.hasOwn(outputs, step.id)) continue;
      if (!conditionMatches(step.when, state)) {
        outputs[step.id] = { skipped: true };
        await input.checkpoint(outputs);
        await input.emit("progress", {
          message: "Workflow step skipped",
          stepId: step.id,
          index,
        });
        continue;
      }
      const maxAttempts = step.retry?.maxAttempts ?? 1;
      let lastError: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        await input.emit("progress", {
          message: "Workflow step started",
          stepId: step.id,
          stepType: step.type,
          index,
          attempt,
        });
        try {
          const result = await this.executeStep(step, input, state, signal);
          outputs[step.id] = result;
          await input.checkpoint(outputs);
          await input.emit("tool_result", {
            toolCallId: `workflow:${step.id}`,
            capabilityId:
              step.type === "capability" ? step.capabilityId : step.type,
            status: "succeeded",
            output: result,
          });
          lastError = undefined;
          break;
        } catch (error) {
          if (isApprovalRequired(error)) throw error;
          lastError = error;
          await input.emit("tool_result", {
            toolCallId: `workflow:${step.id}`,
            capabilityId:
              step.type === "capability" ? step.capabilityId : step.type,
            status: "failed",
            attempt,
            error: error instanceof Error ? error.message : String(error),
          });
          if (attempt < maxAttempts)
            await sleep(step.retry?.delayMs ?? 0, signal);
        }
      }
      if (lastError) throw lastError;
    }
    return input.definition.output
      ? outputText(renderString(input.definition.output, state))
      : outputText(outputs[input.definition.steps.at(-1)!.id]);
  }

  private async executeStep(
    step: WorkflowStep,
    input: Parameters<WorkflowRunner["run"]>[0],
    state: Record<string, unknown>,
    workflowSignal: AbortSignal,
  ) {
    const signal = AbortSignal.any([
      workflowSignal,
      AbortSignal.timeout(step.timeoutMs),
    ]);
    if (step.type === "template") return renderString(step.template, state);
    if (step.type === "capability") {
      const rendered = renderValue(step.input, state) as Record<
        string,
        unknown
      >;
      await input.emit("tool_call", {
        toolCallId: `workflow:${step.id}`,
        capabilityId: step.capabilityId,
        input: rendered,
      });
      const result = await this.clients.invokeCapability(
        {
          tenantId: input.tenantId,
          botId: input.botId,
          capabilityId: step.capabilityId,
          input: rendered,
          trigger: "workflow",
          correlationId: `${input.executionId}:workflow:${step.id}`,
          approvalId: input.approvalId,
        },
        signal,
      );
      return result.output;
    }
    const messages = [
      ...(step.systemPrompt
        ? [{ role: "system", content: renderString(step.systemPrompt, state) }]
        : []),
      { role: "user", content: renderString(step.prompt, state) },
    ];
    const result = await this.clients.model(
      {
        policyId: step.modelPolicyId ?? input.modelPolicyId,
        kind: "chat",
        messages,
        correlationId: `${input.executionId}:workflow:${step.id}`,
      },
      signal,
    );
    return result.output;
  }
}

function conditionMatches(
  condition: WorkflowStepBase["when"],
  state: Record<string, unknown>,
) {
  if (!condition) return true;
  const value = getPath(state, condition.path);
  if (condition.exists !== undefined)
    return condition.exists === (value !== undefined && value !== null);
  return Object.is(value, condition.equals);
}

function renderValue(value: unknown, state: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    const exact = value.match(/^\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}$/);
    if (exact) return getPath(state, exact[1]!);
    return renderString(value, state);
  }
  if (Array.isArray(value))
    return value.map((item) => renderValue(item, state));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        renderValue(item, state),
      ]),
    );
  return value;
}

function renderString(value: string, state: Record<string, unknown>) {
  return value
    .replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_match, path: string) =>
      outputText(getPath(state, path)),
    )
    .slice(0, 100_000);
}

function getPath(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current))
      return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value.map(outputText).filter(Boolean).join("\n");
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return outputText(
      object.content ?? object.text ?? object.message ?? JSON.stringify(value),
    );
  }
  return String(value ?? "");
}

function isApprovalRequired(error: unknown) {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "APPROVAL_REQUIRED"
  );
}

function sleep(ms: number, signal: AbortSignal) {
  if (!ms) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(
          Object.assign(new Error("Workflow cancelled"), {
            name: "AbortError",
          }),
        );
      },
      { once: true },
    );
  });
}
