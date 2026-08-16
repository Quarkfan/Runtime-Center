import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRuntime } from "../src/adapters.js";
import type { PlatformClients } from "../src/clients.js";
import { MemoryRuntimeRepository } from "../src/repository.js";
import { RuntimeService } from "../src/service.js";
describe("Runtime Center", () => {
  const roots: string[] = [];
  afterEach(async () =>
    Promise.all(
      roots.splice(0).map((x) => rm(x, { recursive: true, force: true })),
    ),
  );
  async function setup(approval = false) {
    const root = await mkdtemp(join(tmpdir(), "qft-rt-"));
    roots.push(root);
    const calls: string[] = [];
    const observed: Array<{
      workspace: string;
      history: Array<{ role: string; content: string }>;
      capabilities: any[];
    }> = [];
    const transcripts: any[] = [];
    const clients: PlatformClients = {
      policy: async (input: any) => ({
        id: "d1",
        allow: true,
        obligations:
          approval && !input.context?.approvalId ? [{ type: "approval" }] : [],
      }),
      approval: async () => (calls.push("approval"), { id: "a1" }),
      approvalStatus: async () => ({ id: "a1", status: "approved" }),
      context: async () => (
        calls.push("context"),
        { items: [{ content: "known fact" }], traceId: "tr1" }
      ),
      transcript: async (input) => {
        transcripts.push(input);
        return input;
      },
      capabilities: async () => (calls.push("capabilities"), { items: [] }),
      command: async () => ({ matched: false }),
      workflow: async () => {
        throw new Error("Workflow not configured");
      },
      continuation: async () => {
        throw new Error("Continuation not configured");
      },
      invokeCapability: async (input) => input,
      model: async (input: any) => {
        calls.push("model");
        const text = String(input.messages?.at(-1)?.content ?? "");
        return {
          output: JSON.stringify({
            reply: text.includes("relevant"),
            reason: text.includes("relevant") ? "in scope" : "out of scope",
          }),
        };
      },
      delivery: async (input) => (calls.push("delivery"), input),
    };
    const adapter: AgentRuntime = {
      kind: "model-tool-loop",
      run: async (v) => {
        calls.push("runtime");
        observed.push({
          workspace: v.workspace,
          history: v.history,
          capabilities: v.capabilities,
        });
        expect(v.contextItems[0].content).toBe("known fact");
        return { response: "done", sessionId: v.execution.sessionId };
      },
    };
    const repo = new MemoryRuntimeRepository();
    const service = new RuntimeService(
      repo,
      clients,
      new Map([["model-tool-loop", adapter]]),
      root,
    );
    for (const id of ["b1", "b2"])
      await service.saveBot({
        id,
        tenantId: "t1",
        name: id,
        enabled: true,
        runtime: "model-tool-loop",
        maxConcurrentExecutions: 1,
        autonomousReplyBeta: false,
        historyBackfillBeta: false,
        maxBackfillMessages: 100,
      });
    return { repo, service, clients, calls, observed, transcripts };
  }
  it("runs policy, context and capability resolution before adapter", async () => {
    const { repo, service, calls, transcripts } = await setup();
    const execution = await service.create({
      tenantId: "t1",
      botId: "b1",
      prompt: "hello",
    });
    await service.run(execution.id);
    expect(calls).toEqual(["context", "capabilities", "runtime"]);
    expect((await repo.execution(execution.id))?.status).toBe("succeeded");
    expect((await repo.events(execution.id)).map((x) => x.type)).toContain(
      "result",
    );
    expect(transcripts[0]).toMatchObject({
      executionId: execution.id,
      prompt: "hello",
      response: "done",
    });
  });
  it("updates ordinary bots and protects the system assistant from deletion", async () => {
    const { repo, service } = await setup();
    const current = await service.bot("b1");
    const { createdAt: _createdAt, updatedAt: _updatedAt, ...input } = current;
    await service.saveBot({ ...input, name: "Updated bot", enabled: false });
    expect(await service.bot("b1")).toMatchObject({
      name: "Updated bot",
      enabled: false,
    });
    await expect(service.removeBot("b1")).resolves.toEqual({ removed: true });
    expect(await repo.bot("b1")).toBeUndefined();
    const system = await service.bot("b2");
    const {
      createdAt: _systemCreatedAt,
      updatedAt: _systemUpdatedAt,
      ...systemInput
    } = system;
    await service.saveBot({ ...systemInput, purpose: "system-assistant" });
    await expect(service.removeBot("b2")).rejects.toThrow(
      "System assistant cannot be deleted",
    );
  });
  it("enforces read-only executions with no resolved capabilities or outbound effects", async () => {
    const { repo, service, clients, calls, observed } = await setup();
    const current = (await repo.bot("b1"))!;
    const { createdAt: _createdAt, updatedAt: _updatedAt, ...input } = current;
    await service.saveBot({
      ...input,
      purpose: "system-assistant",
      effectMode: "read-only",
      capabilityPolicy: "none",
    });
    clients.command = async () => {
      calls.push("command");
      return { matched: false };
    };
    const execution = await service.create({
      tenantId: "t1",
      botId: "b1",
      prompt: "/continue 30m do something",
      conversationId: "console",
      source: {
        type: "console-system-assistant",
        workflowId: "dangerous-workflow",
        channelAccountId: "channel-1",
        providerMessageId: "message-1",
      },
    });
    await service.run(execution.id);
    expect(calls).toEqual(["context", "runtime"]);
    expect(observed[0]?.capabilities).toEqual([]);
    expect(await repo.execution(execution.id)).toMatchObject({
      status: "succeeded",
      effectMode: "read-only",
      capabilityPolicy: "none",
    });
    expect(
      (await repo.events(execution.id)).map((event) => event.type),
    ).not.toContain("delivery");
  });
  it("delivers gateway results once with an execution idempotency key", async () => {
    const { repo, service, calls } = await setup();
    const execution = await service.create({
      tenantId: "t1",
      botId: "b1",
      prompt: "hello",
      conversationId: "chat-1",
      source: {
        channelAccountId: "00000000-0000-4000-8000-000000000010",
        providerMessageId: "om_1",
        correlationId: "corr-1",
      },
    });
    await service.run(execution.id);
    expect(calls).toContain("delivery");
    expect((await repo.events(execution.id)).at(-1)?.type).toBe("delivery");
  });
  it("executes template commands without invoking context, tools, or a model", async () => {
    const { repo, service, clients, calls } = await setup();
    clients.command = async () => ({
      matched: true,
      type: "command",
      manifest: { id: "command.greet" },
      arguments: "Dean",
      action: { type: "template", template: "你好，{args}" },
    });
    const execution = await service.create({
      tenantId: "t1",
      botId: "b1",
      prompt: "/hello Dean",
    });
    await service.run(execution.id);
    expect((await repo.execution(execution.id))?.response).toBe("你好，Dean");
    expect(calls).toEqual([]);
    expect((await repo.events(execution.id)).at(-1)?.data.command).toBe(true);
  });
  it("executes capability commands through the governed registry path", async () => {
    const { repo, service, clients, calls } = await setup();
    let invocation: any;
    clients.command = async () => ({
      matched: true,
      type: "command",
      manifest: { id: "command.snapshot" },
      arguments: "morning",
      action: {
        type: "capability",
        capabilityId: "tool.snapshot",
        input: { scope: "stores" },
      },
    });
    clients.invokeCapability = async (input) => {
      invocation = input;
      return { output: { text: "已保存 42 条记录" } };
    };
    const execution = await service.create({
      tenantId: "t1",
      botId: "b1",
      prompt: "/snapshot morning",
    });
    await service.run(execution.id);
    expect(invocation).toMatchObject({
      capabilityId: "tool.snapshot",
      trigger: "command",
      input: {
        scope: "stores",
        arguments: "morning",
        text: "/snapshot morning",
      },
    });
    expect((await repo.execution(execution.id))?.response).toBe(
      "已保存 42 条记录",
    );
    expect(calls).toEqual([]);
  });
  it("creates a durable delayed continuation without sending it to a model", async () => {
    const { repo, service, clients, calls } = await setup();
    let request: any;
    clients.continuation = async (input) => {
      request = input;
      return {
        id: "00000000-0000-4000-8000-000000000099",
        nextRunAt: "2026-08-16T01:00:00.000Z",
      };
    };
    const execution = await service.create({
      tenantId: "t1",
      botId: "b1",
      conversationId: "chat-continue",
      prompt: "/continue 30m 继续生成报告",
      source: {
        channelAccountId: "channel-1",
        providerMessageId: "message-1",
        conversationType: "dm",
        replyDecisionRequired: false,
      },
    });
    await service.run(execution.id);
    expect(request).toMatchObject({
      tenantId: "t1",
      botId: "b1",
      prompt: "继续生成报告",
      delaySeconds: 1800,
      conversationId: "chat-continue",
      source: {
        channelAccountId: "channel-1",
        providerMessageId: "message-1",
      },
    });
    expect(request.source).not.toHaveProperty("replyDecisionRequired");
    expect((await repo.execution(execution.id))?.response).toContain(
      "2026-08-16T01:00:00.000Z",
    );
    expect(calls).toEqual(["delivery"]);
  });
  it("pauses for approval before accessing context or tools", async () => {
    const { repo, service, calls } = await setup(true);
    const execution = await service.create({
      tenantId: "t1",
      botId: "b1",
      prompt: "sensitive",
    });
    await service.run(execution.id);
    expect(calls).toEqual(["approval"]);
    expect((await repo.execution(execution.id))?.status).toBe(
      "waiting_approval",
    );
    expect((await repo.execution(execution.id))?.approvalId).toBe("a1");
    await service.resume(execution.id);
    await service.run(execution.id);
    expect((await repo.execution(execution.id))?.status).toBe("succeeded");
    expect(calls.filter((item) => item === "approval")).toHaveLength(1);
  });
  it("isolates execution workspaces by tenant and bot", async () => {
    const { repo, service } = await setup();
    const a = await service.create({
      tenantId: "t1",
      botId: "b1",
      prompt: "a",
    });
    const b = await service.create({
      tenantId: "t1",
      botId: "b2",
      prompt: "b",
    });
    await service.run(a.id);
    await service.run(b.id);
    expect((await repo.execution(a.id))?.workspaceId).not.toBe(
      (await repo.execution(b.id))?.workspaceId,
    );
  });
  it("inherits registered bot runtime policy and blocks disabled bots", async () => {
    const { repo, service } = await setup();
    await service.saveBot({
      id: "configured-bot",
      tenantId: "t1",
      name: "Configured",
      enabled: true,
      runtime: "model-tool-loop",
      modelPolicyId: "00000000-0000-4000-8000-000000000020",
      systemPrompt: "Be precise",
      maxConcurrentExecutions: 1,
      autonomousReplyBeta: true,
      historyBackfillBeta: true,
      maxBackfillMessages: 50,
    });
    const execution = await service.create({
      tenantId: "t1",
      botId: "configured-bot",
      prompt: "hello",
    });
    expect(execution.systemPrompt).toBe("Be precise");
    expect(execution.modelPolicyId).toBe(
      "00000000-0000-4000-8000-000000000020",
    );
    const bot = (await repo.bot("configured-bot"))!;
    await service.saveBot({ ...bot, enabled: false });
    await expect(
      service.create({ tenantId: "t1", botId: "configured-bot", prompt: "x" }),
    ).rejects.toThrow("disabled");
  });
  it("persists 24-hour conversation continuity and isolates group senders", async () => {
    const { service, observed } = await setup();
    const first = await service.create({
      tenantId: "t1",
      botId: "b1",
      conversationId: "chat-1",
      source: { conversationType: "dm", senderId: "u1" },
      prompt: "first",
    });
    await service.run(first.id);
    const second = await service.create({
      tenantId: "t1",
      botId: "b1",
      conversationId: "chat-1",
      source: { conversationType: "dm", senderId: "u1" },
      prompt: "second",
    });
    await service.run(second.id);
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.workspaceId).toBe(first.workspaceId);
    expect(observed[1]?.history.map((item) => item.content)).toEqual([
      "first",
      "done",
    ]);

    const groupA = await service.create({
      tenantId: "t1",
      botId: "b1",
      conversationId: "group-1",
      source: { conversationType: "group", senderId: "u1" },
      prompt: "group a",
    });
    const groupB = await service.create({
      tenantId: "t1",
      botId: "b1",
      conversationId: "group-1",
      source: { conversationType: "group", senderId: "u2" },
      prompt: "group b",
    });
    expect(groupA.sessionId).not.toBe(groupB.sessionId);
    expect(groupA.workspaceId).not.toBe(groupB.workspaceId);

    const reset = await service.create({
      tenantId: "t1",
      botId: "b1",
      conversationId: "chat-1",
      source: { conversationType: "dm", senderId: "u1" },
      prompt: "/new",
    });
    await service.run(reset.id);
    expect(reset.sessionId).not.toBe(first.sessionId);
    expect(reset.workspaceId).not.toBe(first.workspaceId);
    const resetSession = (await service.sessions({ botId: "b1" })).find(
      (item) => item.conversationKey === "chat-1",
    );
    expect(resetSession?.messages).toEqual([]);
  });
  it("cancels a running adapter through its abort controller", async () => {
    const root = await mkdtemp(join(tmpdir(), "qft-rt-cancel-"));
    roots.push(root);
    const repo = new MemoryRuntimeRepository();
    const clients: PlatformClients = {
      policy: async () => ({ id: "d1", allow: true, obligations: [] }),
      approval: async () => ({}),
      approvalStatus: async () => ({ status: "approved" }),
      context: async () => ({ items: [] }),
      transcript: async () => ({}),
      capabilities: async () => ({ items: [] }),
      command: async () => ({ matched: false }),
      workflow: async () => {
        throw new Error("Workflow not configured");
      },
      continuation: async () => {
        throw new Error("Continuation not configured");
      },
      invokeCapability: async () => ({}),
      model: async () => ({}),
      delivery: async () => ({}),
    };
    const adapter: AgentRuntime = {
      kind: "model-tool-loop",
      run: async ({ abortController }) =>
        new Promise((_resolve, reject) =>
          abortController.signal.addEventListener(
            "abort",
            () =>
              reject(
                Object.assign(new Error("cancelled"), { name: "AbortError" }),
              ),
            { once: true },
          ),
        ),
    };
    const service = new RuntimeService(
      repo,
      clients,
      new Map([["model-tool-loop", adapter]]),
      root,
    );
    await service.saveBot({
      id: "cancel-bot",
      tenantId: "t1",
      name: "Cancel",
      enabled: true,
      runtime: "model-tool-loop",
      maxConcurrentExecutions: 1,
      autonomousReplyBeta: false,
      historyBackfillBeta: false,
      maxBackfillMessages: 100,
    });
    const execution = await service.create({
      tenantId: "t1",
      botId: "cancel-bot",
      prompt: "long task",
    });
    const running = service.run(execution.id);
    await until(
      async () => (await repo.execution(execution.id))?.status === "running",
    );
    await service.cancel(execution.id);
    await running;
    expect((await repo.execution(execution.id))?.status).toBe("cancelled");
    expect(
      (await repo.events(execution.id)).filter(
        (event) => event.type === "cancelled",
      ),
    ).toHaveLength(1);
  });
  it("uses the bot duties to suppress or accept unmentioned group messages", async () => {
    const { repo, service, calls } = await setup();
    const bot = (await repo.bot("b1"))!;
    await service.saveBot({
      ...bot,
      description: "Handles relevant requests",
      autonomousReplyBeta: true,
    });
    const ignored = await service.create({
      tenantId: "t1",
      botId: "b1",
      conversationId: "group-auto",
      prompt: "casual chat",
      source: {
        type: "message",
        conversationType: "group",
        senderId: "u1",
        replyDecisionRequired: true,
      },
    });
    await service.run(ignored.id);
    expect((await repo.execution(ignored.id))?.status).toBe("succeeded");
    expect(calls).toEqual(["model"]);
    expect((await repo.events(ignored.id)).at(-1)?.data.suppressed).toBe(true);

    calls.length = 0;
    const accepted = await service.create({
      tenantId: "t1",
      botId: "b1",
      conversationId: "group-auto",
      prompt: "relevant request",
      source: {
        type: "message",
        conversationType: "group",
        senderId: "u1",
        replyDecisionRequired: true,
      },
    });
    await service.run(accepted.id);
    expect(calls).toEqual(["model", "context", "capabilities", "runtime"]);
    expect((await repo.execution(accepted.id))?.response).toBe("done");
  });
});

async function until(check: () => Promise<boolean>, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition not reached");
}
