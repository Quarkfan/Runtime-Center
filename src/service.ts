import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { AgentRuntime } from "./adapters.js";
import type { PlatformClients } from "./clients.js";
import type { RuntimeRepository } from "./repository.js";
import type {
  BotDefinition,
  Execution,
  RuntimeEvent,
  RuntimeInput,
  RuntimeSession,
} from "./types.js";
import { WorkflowRunner } from "./workflow.js";
const now = () => new Date().toISOString();
export class RuntimeService {
  private running = new Set<string>();
  private activeByBot = new Map<string, number>();
  private controllers = new Map<string, AbortController>();
  private readonly workflowRunner: WorkflowRunner;
  constructor(
    readonly repo: RuntimeRepository,
    readonly clients: PlatformClients,
    readonly adapters: Map<Execution["runtime"], AgentRuntime>,
    readonly root: string,
    readonly sessionTtlMs = 24 * 60 * 60 * 1000,
  ) {
    this.workflowRunner = new WorkflowRunner(clients);
  }
  async saveBot(input: Omit<BotDefinition, "createdAt" | "updatedAt">) {
    const old = await this.repo.bot(input.id);
    const timestamp = now();
    return this.repo.saveBot({
      ...input,
      createdAt: old?.createdAt ?? timestamp,
      updatedAt: timestamp,
    });
  }
  async create(i: RuntimeInput) {
    const bot = await this.repo.bot(i.botId);
    if (!bot)
      throw Object.assign(new Error("Bot is not registered"), {
        statusCode: 404,
      });
    if (bot.tenantId !== i.tenantId)
      throw Object.assign(new Error("Bot does not belong to tenant"), {
        statusCode: 403,
      });
    if (!bot.enabled)
      throw Object.assign(new Error("Bot is disabled"), { statusCode: 409 });
    const n = now(),
      executionId = randomUUID(),
      conversationKey = this.conversationKey(i, executionId),
      reset = isResetPrompt(i.prompt);
    let session = await this.repo.sessionByConversation(
      i.tenantId,
      i.botId,
      conversationKey,
    );
    if (!session || session.expiresAt <= n || reset) {
      session = await this.repo.saveSession({
        id: session?.id ?? randomUUID(),
        tenantId: i.tenantId,
        botId: i.botId,
        conversationKey,
        workspaceId: randomUUID(),
        modelSessionId: i.sessionId ?? randomUUID(),
        messages: [],
        createdAt: n,
        lastActiveAt: n,
        expiresAt: new Date(Date.now() + this.sessionTtlMs).toISOString(),
      });
    } else if (i.sessionId) {
      session.modelSessionId = i.sessionId;
      session = await this.repo.saveSession(session);
    }
    const v: Execution = {
      id: executionId,
      tenantId: i.tenantId,
      botId: i.botId,
      runtime: i.runtime ?? bot?.runtime ?? "model-tool-loop",
      prompt: i.prompt,
      systemPrompt: i.systemPrompt ?? bot?.systemPrompt,
      conversationId: i.conversationId,
      conversationKey,
      workspaceId: session.workspaceId,
      sessionId: session.modelSessionId,
      modelPolicyId: i.modelPolicyId ?? bot?.modelPolicyId,
      effectMode: bot.effectMode ?? "standard",
      capabilityPolicy: bot.capabilityPolicy ?? "resolved",
      source: i.source ?? {},
      status: "queued",
      createdAt: n,
    };
    await this.repo.saveExecution(v);
    await this.emit(v, "progress", { message: "Execution queued" });
    return v;
  }
  async emit(
    e: Execution,
    type: RuntimeEvent["type"],
    data: Record<string, unknown>,
  ) {
    const sequence = (await this.repo.events(e.id)).length + 1,
      v: RuntimeEvent = {
        id: randomUUID(),
        executionId: e.id,
        sequence,
        type,
        data,
        createdAt: now(),
      };
    await this.repo.append(v);
  }
  async run(id: string, contextQuery?: string) {
    if (this.running.has(id)) return;
    const e = await this.repo.execution(id);
    if (!e || e.status !== "queued") return;
    const bot = await this.repo.bot(e.botId);
    const active = this.activeByBot.get(e.botId) ?? 0;
    if (active >= (bot?.maxConcurrentExecutions ?? 1)) return;
    this.running.add(id);
    this.activeByBot.set(e.botId, active + 1);
    const controller = new AbortController();
    this.controllers.set(id, controller);
    try {
      const decision = await this.clients.policy(
        {
          tenantId: e.tenantId,
          actor: { type: "bot", id: e.botId, roles: [] },
          action: "runtime.execute",
          resource: {
            type: "execution",
            id: e.id,
            ownerId: e.botId,
            classification: "internal",
          },
          context: {
            botId: e.botId,
            workspaceId: e.workspaceId,
            risk: e.effectMode === "read-only" ? "low" : "medium",
            interactive: !["scheduled", "continuation"].includes(
              String(e.source.type ?? ""),
            ),
            approvalId: e.approvalId,
          },
          correlationId: e.id,
        },
        controller.signal,
      );
      controller.signal.throwIfAborted();
      if (!decision.allow) throw new Error(`Policy denied: ${decision.reason}`);
      if (decision.obligations?.some((x: any) => x.type === "approval")) {
        const approval = await this.clients.approval(
          {
            decisionId: decision.id,
            tenantId: e.tenantId,
            requesterId: e.botId,
            action: "runtime.execute",
            resource: { executionId: e.id },
          },
          controller.signal,
        );
        e.approvalId = approval.id;
        e.status = "waiting_approval";
        await this.repo.saveExecution(e);
        await this.emit(e, "progress", {
          message: "Waiting for approval",
          decisionId: decision.id,
          approvalId: approval.id,
        });
        return;
      }
      e.status = "running";
      e.startedAt = now();
      await this.repo.saveExecution(e);
      await this.emit(e, "started", {
        runtime: e.runtime,
        workspaceId: e.workspaceId,
      });
      if (e.source.replyDecisionRequired === true) {
        const decision = bot?.autonomousReplyBeta
          ? await this.autonomousReplyDecision(e, bot, controller.signal)
          : {
              reply: false,
              reason: "Autonomous reply is disabled for this bot",
            };
        await this.emit(e, "progress", {
          message: "Autonomous reply decision completed",
          reply: decision.reply,
          reason: decision.reason,
        });
        if (!decision.reply) {
          e.status = "succeeded";
          e.finishedAt = now();
          await this.repo.saveExecution(e);
          await this.emit(e, "result", {
            suppressed: true,
            reason: decision.reason,
          });
          await this.touchSession(e, false);
          return;
        }
      }
      if (isResetPrompt(e.prompt)) {
        e.response = "已开始新对话。";
        e.status = "succeeded";
        e.finishedAt = now();
        await this.repo.saveExecution(e);
        await this.emit(e, "session", { sessionId: e.sessionId, reset: true });
        await this.emit(e, "result", { response: e.response });
        await this.touchSession(e, false);
        await this.deliverResult(e);
        return;
      }
      const continuation =
        e.effectMode === "standard" ? parseContinuation(e.prompt) : undefined;
      if (continuation) {
        const task = await this.clients.continuation(
          {
            tenantId: e.tenantId,
            botId: e.botId,
            prompt: continuation.prompt,
            delaySeconds: continuation.delaySeconds,
            conversationId: e.conversationId,
            sessionId: e.sessionId,
            source: continuationSource(e.source),
          },
          controller.signal,
        );
        e.response = `已安排延后执行，将在 ${String(task.nextRunAt)} 继续。`;
        e.status = "succeeded";
        e.finishedAt = now();
        await this.repo.saveExecution(e);
        await this.emit(e, "result", {
          response: e.response,
          continuation: true,
          continuationToken: task.id,
          runAt: task.nextRunAt,
        });
        await this.touchSession(e, true);
        await this.deliverResult(e);
        return;
      }
      if (
        e.effectMode === "standard" &&
        typeof e.source.workflowId === "string"
      ) {
        await this.runWorkflow(e, e.source.workflowId, controller.signal);
        return;
      }
      if (
        e.effectMode === "standard" &&
        (await this.runCommand(e, controller.signal))
      )
        return;
      const [context, capabilities] = await Promise.all([
        this.clients.context(
          {
            botId: e.botId,
            query: contextQuery ?? e.prompt,
            conversationId: e.conversationId,
            limit: 20,
            includeMemory: true,
            correlationId: e.id,
          },
          controller.signal,
        ),
        e.capabilityPolicy === "none"
          ? Promise.resolve({ items: [] })
          : this.clients.capabilities(
              {
                botId: e.botId,
                trigger: capabilityTrigger(e.source),
              },
              controller.signal,
            ),
      ]);
      controller.signal.throwIfAborted();
      await this.emit(e, "context", {
        count: context.items?.length ?? 0,
        traceId: context.traceId,
      });
      await this.emit(e, "capabilities", {
        count: capabilities.items?.length ?? 0,
        ids: (capabilities.items ?? []).map((x: any) => x.manifest.id),
        policy: e.capabilityPolicy,
      });
      const workspace = join(this.root, e.tenantId, e.botId, e.workspaceId);
      await mkdir(workspace, { recursive: true });
      await this.materializeSkills(workspace, capabilities.items ?? []);
      const adapter = this.adapters.get(e.runtime);
      if (!adapter)
        throw new Error(`Runtime adapter unavailable: ${e.runtime}`);
      const result = await adapter.run({
        execution: e,
        workspace,
        history: (await this.sessionForExecution(e))?.messages ?? [],
        abortController: controller,
        contextItems: context.items ?? [],
        capabilities: capabilities.items ?? [],
        emit: (t, d) => this.emit(e, t, d),
      });
      controller.signal.throwIfAborted();
      e.response = result.response;
      e.sessionId = result.sessionId ?? e.sessionId;
      e.status = "succeeded";
      e.finishedAt = now();
      await this.repo.saveExecution(e);
      await this.emit(e, "session", { sessionId: e.sessionId });
      await this.emit(e, "result", { response: e.response });
      await this.touchSession(e, true);
      await this.deliverResult(e);
    } catch (err) {
      const approvalRequired =
        err &&
        typeof err === "object" &&
        "code" in err &&
        err.code === "APPROVAL_REQUIRED";
      if (approvalRequired) {
        const details =
          "details" in err && err.details && typeof err.details === "object"
            ? (err.details as Record<string, unknown>)
            : {};
        e.status = "waiting_approval";
        e.approvalId = String(details.approvalId ?? "") || undefined;
        e.error = undefined;
        e.finishedAt = undefined;
        await this.repo.saveExecution(e);
        await this.emit(e, "progress", {
          message: "Waiting for capability approval",
          approvalId: e.approvalId,
          decisionId: details.decisionId,
        });
        return;
      }
      const persisted = await this.repo.execution(e.id);
      const cancelled =
        controller.signal.aborted ||
        persisted?.status === "cancelled" ||
        (err instanceof Error && err.name === "AbortError");
      e.status = cancelled ? "cancelled" : "failed";
      e.cancelRequested = cancelled;
      e.error = cancelled
        ? "Execution cancelled"
        : err instanceof Error
          ? err.message
          : "Runtime failed";
      e.finishedAt = now();
      await this.repo.saveExecution(e);
      if (cancelled) {
        const events = await this.repo.events(e.id);
        if (!events.some((event) => event.type === "cancelled"))
          await this.emit(e, "cancelled", {});
      } else await this.emit(e, "error", { message: e.error });
    } finally {
      this.controllers.delete(id);
      this.running.delete(id);
      const remaining = Math.max(0, (this.activeByBot.get(e.botId) ?? 1) - 1);
      if (remaining) this.activeByBot.set(e.botId, remaining);
      else this.activeByBot.delete(e.botId);
      const next = (await this.repo.executions(e.tenantId))
        .filter(
          (candidate) =>
            candidate.botId === e.botId && candidate.status === "queued",
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (next) setImmediate(() => this.run(next.id).catch(() => undefined));
    }
  }
  async recover() {
    const values = await this.repo.executions();
    for (const execution of values) {
      if (execution.status === "running") {
        execution.status = "queued";
        execution.error = undefined;
        execution.startedAt = undefined;
        await this.repo.saveExecution(execution);
        await this.emit(execution, "progress", {
          message: "Execution recovered after runtime restart",
        });
      }
    }
    for (const execution of values.filter((item) =>
      ["queued", "running"].includes(item.status),
    ))
      setImmediate(() => this.run(execution.id).catch(() => undefined));
  }
  private async materializeSkills(workspace: string, capabilities: any[]) {
    for (const capability of capabilities) {
      if (capability.manifest?.kind !== "skill") continue;
      const files = capability.manifest?.raw?.skill?.files;
      if (!Array.isArray(files)) continue;
      const skillRoot = join(
        workspace,
        ".claude",
        "skills",
        String(capability.manifest.id).replace(/[^A-Za-z0-9._-]/g, "_"),
      );
      await mkdir(skillRoot, { recursive: true });
      for (const file of files) {
        if (
          !file ||
          typeof file.path !== "string" ||
          typeof file.content !== "string"
        )
          continue;
        const destination = resolve(skillRoot, file.path);
        if (!destination.startsWith(`${resolve(skillRoot)}${sep}`)) continue;
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, file.content, "utf8");
      }
    }
  }
  private async runCommand(execution: Execution, signal: AbortSignal) {
    const resolved = await this.clients.command(
      {
        botId: execution.botId,
        text: execution.prompt,
        conversationType: execution.source.conversationType,
        trigger:
          execution.source.type === "scheduled"
            ? "scheduled"
            : execution.source.type === "console"
              ? "manual"
              : "command",
      },
      signal,
    );
    if (!resolved.matched) return false;
    await this.emit(execution, "progress", {
      message: "Deterministic command matched",
      type: resolved.type,
      capabilityId: resolved.manifest?.id,
    });
    let response: string;
    if (resolved.type === "help") response = String(resolved.response ?? "");
    else {
      const action = resolved.action as Record<string, unknown>;
      if (action?.type === "template")
        response = interpolateTemplate(
          String(action.template ?? ""),
          String(resolved.arguments ?? ""),
        );
      else if (action?.type === "capability") {
        const capabilityId = String(action.capabilityId ?? "");
        if (!capabilityId)
          throw new Error("Command capability action is missing capabilityId");
        const invoked = await this.clients.invokeCapability(
          {
            tenantId: execution.tenantId,
            botId: execution.botId,
            capabilityId,
            input: {
              ...(action.input && typeof action.input === "object"
                ? action.input
                : {}),
              arguments: String(resolved.arguments ?? ""),
              text: execution.prompt,
            },
            trigger: "command",
            correlationId: `${execution.id}:command`,
            approvalId: execution.approvalId,
          },
          signal,
        );
        response = commandOutputText(invoked.output);
      } else if (action?.type === "workflow") {
        const workflowId = String(action.workflowId ?? "");
        if (!workflowId)
          throw new Error("Command workflow action is missing workflowId");
        response = await this.executeWorkflow(
          execution,
          workflowId,
          signal,
          {
            ...(action.input && typeof action.input === "object"
              ? action.input
              : {}),
            arguments: String(resolved.arguments ?? ""),
          },
          "command",
        );
      } else
        throw new Error(
          `Unsupported command action: ${String(action?.type ?? "unknown")}`,
        );
    }
    execution.response = response;
    execution.status = "succeeded";
    execution.finishedAt = now();
    await this.repo.saveExecution(execution);
    await this.emit(execution, "result", {
      response,
      command: true,
      capabilityId: resolved.manifest?.id,
    });
    await this.touchSession(execution, true);
    await this.deliverResult(execution);
    return true;
  }
  private async runWorkflow(
    execution: Execution,
    workflowId: string,
    signal: AbortSignal,
  ) {
    const workflowInput =
      execution.source.workflowInput &&
      typeof execution.source.workflowInput === "object" &&
      !Array.isArray(execution.source.workflowInput)
        ? (execution.source.workflowInput as Record<string, unknown>)
        : {};
    const response = await this.executeWorkflow(
      execution,
      workflowId,
      signal,
      workflowInput,
    );
    execution.response = response;
    execution.status = "succeeded";
    execution.finishedAt = now();
    await this.repo.saveExecution(execution);
    await this.emit(execution, "result", {
      response,
      workflow: true,
      workflowId,
    });
    await this.touchSession(execution, true);
    await this.deliverResult(execution);
  }
  private async executeWorkflow(
    execution: Execution,
    workflowId: string,
    signal: AbortSignal,
    workflowInput: Record<string, unknown>,
    triggerOverride?: "command" | "scheduled" | "manual" | "workflow",
  ) {
    const trigger =
      triggerOverride ??
      (execution.source.type === "scheduled" ||
      execution.source.type === "continuation"
        ? "scheduled"
        : execution.source.type === "console"
          ? "manual"
          : "workflow");
    const resolved = await this.clients.workflow(
      { botId: execution.botId, workflowId, trigger },
      signal,
    );
    const savedState =
      execution.source.workflowState &&
      typeof execution.source.workflowState === "object" &&
      !Array.isArray(execution.source.workflowState)
        ? (execution.source.workflowState as Record<string, unknown>)
        : undefined;
    const completed =
      savedState?.workflowId === workflowId &&
      savedState.outputs &&
      typeof savedState.outputs === "object" &&
      !Array.isArray(savedState.outputs)
        ? (savedState.outputs as Record<string, unknown>)
        : {};
    await this.emit(execution, "progress", {
      message: "Workflow resolved",
      workflowId,
      name: resolved.name,
      completedSteps: Object.keys(completed).length,
    });
    return this.workflowRunner.run({
      tenantId: execution.tenantId,
      botId: execution.botId,
      executionId: execution.id,
      approvalId: execution.approvalId,
      modelPolicyId: execution.modelPolicyId,
      prompt: execution.prompt,
      arguments: String(workflowInput.arguments ?? ""),
      workflowInput,
      definition: resolved.definition,
      completed,
      signal,
      emit: (type, data) => this.emit(execution, type as any, data),
      checkpoint: async (outputs) => {
        execution.source = {
          ...execution.source,
          workflowState: { workflowId, outputs },
        };
        await this.repo.saveExecution(execution);
      },
    });
  }
  private async deliverResult(e: Execution) {
    if (e.effectMode === "read-only") return;
    const direct =
      e.source.delivery && typeof e.source.delivery === "object"
        ? (e.source.delivery as Record<string, unknown>)
        : undefined;
    const channelAccountId = String(
      direct?.channelAccountId ?? e.source.channelAccountId ?? "",
    );
    const targetId = String(
      direct?.targetId ?? e.source.providerMessageId ?? e.conversationId ?? "",
    );
    if (!channelAccountId || !targetId || !e.response) return;
    const targetType =
      direct?.targetType === "chat" || direct?.targetType === "user"
        ? direct.targetType
        : "message";
    try {
      const delivery = await this.clients.delivery({
        idempotencyKey: `execution:${e.id}:result`,
        channelAccountId,
        botId: e.botId,
        targetId,
        targetType,
        text: e.response,
        replyToMessageId:
          targetType === "message"
            ? String(
                direct?.replyToMessageId ??
                  e.source.providerMessageId ??
                  targetId,
              )
            : undefined,
        correlationId: String(e.source.correlationId ?? e.id),
      });
      await this.emit(e, "delivery", {
        deliveryId: delivery.id,
        status: delivery.status,
      });
    } catch (error) {
      await this.emit(e, "delivery", {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  async resume(id: string) {
    const execution = await this.repo.execution(id);
    if (!execution)
      throw Object.assign(new Error("Execution not found"), {
        statusCode: 404,
      });
    if (
      execution.status !== "waiting_approval" &&
      execution.status !== "failed"
    )
      throw Object.assign(new Error("Execution cannot be resumed"), {
        statusCode: 409,
      });
    if (execution.status === "waiting_approval") {
      if (!execution.approvalId)
        throw Object.assign(new Error("Execution has no approval request"), {
          statusCode: 409,
        });
      const approval = await this.clients.approvalStatus(execution.approvalId);
      if (approval.status !== "approved")
        throw Object.assign(
          new Error(`Approval is ${String(approval.status)}`),
          { statusCode: 409 },
        );
    }
    execution.status = "queued";
    execution.error = undefined;
    execution.finishedAt = undefined;
    await this.repo.saveExecution(execution);
    await this.emit(execution, "progress", { message: "Execution resumed" });
    return execution;
  }
  async cancel(id: string) {
    const execution = await this.repo.execution(id);
    if (!execution)
      throw Object.assign(new Error("Execution not found"), {
        statusCode: 404,
      });
    if (["succeeded", "failed", "cancelled"].includes(execution.status))
      throw Object.assign(new Error("Finished execution cannot be cancelled"), {
        statusCode: 409,
      });
    execution.status = "cancelled";
    execution.cancelRequested = true;
    execution.finishedAt = now();
    await this.repo.saveExecution(execution);
    await this.emit(execution, "cancelled", {});
    this.controllers.get(id)?.abort();
    return execution;
  }
  async shutdown() {
    for (const controller of this.controllers.values()) controller.abort();
    const deadline = Date.now() + 30_000;
    while (this.controllers.size && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
  }
  async sessions(filter: { tenantId?: string; botId?: string }) {
    return this.repo.sessions(filter);
  }
  async getSession(id: string, tenantId?: string) {
    const session = await this.repo.session(id);
    if (!session || (tenantId && session.tenantId !== tenantId))
      throw Object.assign(new Error("Session not found"), { statusCode: 404 });
    return session;
  }
  async removeSession(id: string, tenantId?: string) {
    await this.getSession(id, tenantId);
    return this.repo.removeSession(id);
  }
  private conversationKey(input: RuntimeInput, executionId: string) {
    if (!input.conversationId) return `execution:${executionId}`;
    const source = input.source ?? {};
    const sender = String(source.senderId ?? "");
    const type = String(source.conversationType ?? "dm");
    return type === "dm" || !sender
      ? input.conversationId
      : `${input.conversationId}:${sender}`;
  }
  private async sessionForExecution(execution: Execution) {
    return execution.conversationKey
      ? this.repo.sessionByConversation(
          execution.tenantId,
          execution.botId,
          execution.conversationKey,
        )
      : undefined;
  }
  private async touchSession(execution: Execution, appendMessages: boolean) {
    const session = await this.sessionForExecution(execution);
    if (!session) return;
    session.modelSessionId = execution.sessionId;
    session.lastActiveAt = now();
    session.expiresAt = new Date(Date.now() + this.sessionTtlMs).toISOString();
    if (appendMessages && execution.response) {
      session.messages.push(
        { role: "user", content: execution.prompt, at: execution.createdAt },
        {
          role: "assistant",
          content: execution.response,
          at: execution.finishedAt ?? session.lastActiveAt,
        },
      );
      session.messages = session.messages.slice(-100);
    }
    await this.repo.saveSession(session);
    if (appendMessages && execution.response)
      await this.recordTranscript(execution).catch(async (error) => {
        await this.emit(execution, "progress", {
          message: "Transcript persistence failed",
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }
  private async recordTranscript(execution: Execution) {
    const events = await this.repo.events(execution.id),
      resourceRefs = new Set<string>();
    for (const event of events) collectResourceRefs(event.data, resourceRefs);
    await this.clients.transcript({
      tenantId: execution.tenantId,
      botId: execution.botId,
      executionId: execution.id,
      sessionId: execution.sessionId,
      workspaceId: execution.workspaceId,
      conversationId: execution.conversationId,
      userId:
        typeof execution.source.senderId === "string"
          ? execution.source.senderId
          : undefined,
      prompt: execution.prompt,
      response: execution.response,
      runtime: execution.runtime,
      status: execution.status,
      resourceRefs: [...resourceRefs],
      eventRefs: events.map((event) => `runtime-event:${event.id}`),
      createdAt: execution.createdAt,
      finishedAt: execution.finishedAt,
    });
  }
  private async autonomousReplyDecision(
    execution: Execution,
    bot: BotDefinition,
    signal: AbortSignal,
  ) {
    const result = await this.clients.model(
      {
        policyId: execution.modelPolicyId,
        kind: "chat",
        messages: [
          {
            role: "system",
            content: [
              "Decide whether this bot should answer an unmentioned group message.",
              `Bot name: ${bot.name}`,
              `Bot description: ${bot.description ?? ""}`,
              `Bot duties: ${bot.systemPrompt ?? ""}`,
              'Return JSON only: {"reply":boolean,"reason":"short explanation"}.',
              "Reply true only when the message clearly falls within the bot duties and a response is useful.",
            ].join("\n"),
          },
          { role: "user", content: execution.prompt },
        ],
        temperature: 0,
        maxTokens: 120,
        responseFormat: { type: "json_object" },
        correlationId: `${execution.id}:reply-decision`,
      },
      signal,
    );
    return parseReplyDecision(result.output);
  }
}

function isResetPrompt(prompt: string) {
  return ["/new", "新对话", "重置会话"].includes(prompt.trim().toLowerCase());
}

function parseContinuation(prompt: string) {
  const value = prompt.trim();
  if (!value.toLowerCase().startsWith("/continue")) return undefined;
  const match = value.match(/^\/continue\s+(\d+)(s|m|h|d)\s+([\s\S]+)$/i);
  if (!match)
    throw new Error(
      "用法：/continue <时间> <任务>，例如 /continue 30m 继续生成报告",
    );
  const factors = { s: 1, m: 60, h: 3600, d: 86400 } as const;
  const delaySeconds =
    Number(match[1]) * factors[match[2]!.toLowerCase() as keyof typeof factors];
  if (delaySeconds < 10 || delaySeconds > 30 * 86400)
    throw new Error("延后时间必须在 10 秒到 30 天之间");
  return { delaySeconds, prompt: match[3]!.trim() };
}

function continuationSource(source: Record<string, unknown>) {
  const allowed = [
    "channelAccountId",
    "providerMessageId",
    "senderId",
    "conversationType",
    "delivery",
    "correlationId",
  ];
  return Object.fromEntries(
    allowed.flatMap((key) =>
      source[key] === undefined ? [] : [[key, source[key]]],
    ),
  );
}

function capabilityTrigger(source: Record<string, unknown>) {
  return ["scheduled", "continuation"].includes(String(source.type ?? ""))
    ? "scheduled"
    : "agent";
}

function collectResourceRefs(value: unknown, refs: Set<string>) {
  if (Array.isArray(value)) {
    for (const item of value) collectResourceRefs(item, refs);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (
      typeof item === "string" &&
      /^(artifactId|resourceId|outputId)$/i.test(key)
    )
      refs.add(`resource:${item}`);
    else collectResourceRefs(item, refs);
  }
}

function interpolateTemplate(template: string, args: string) {
  return template
    .replaceAll("{args}", args)
    .replaceAll("{arguments}", args)
    .slice(0, 100_000);
}

function commandOutputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value.map(commandOutputText).filter(Boolean).join("\n");
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return commandOutputText(
      object.content ?? object.text ?? object.message ?? JSON.stringify(value),
    );
  }
  return String(value ?? "");
}

function parseReplyDecision(output: unknown): {
  reply: boolean;
  reason: string;
} {
  let value = output;
  if (typeof output === "string") {
    try {
      value = JSON.parse(output);
    } catch {
      const match = output.match(/\{[\s\S]*\}/);
      if (match)
        try {
          value = JSON.parse(match[0]);
        } catch {
          value = undefined;
        }
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    return {
      reply: object.reply === true,
      reason:
        typeof object.reason === "string"
          ? object.reason.slice(0, 500)
          : object.reply === true
            ? "Message matches bot duties"
            : "Message does not match bot duties",
    };
  }
  return { reply: false, reason: "Model returned an invalid reply decision" };
}
