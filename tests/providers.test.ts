import { describe, expect, it } from "vitest";
import type { PlatformClients } from "../src/clients.js";
import {
  builtInRuntimeProvider,
  RuntimeProviderRegistry,
} from "../src/providers.js";
import { MemoryRuntimeRepository } from "../src/repository.js";
import { RuntimeService } from "../src/service.js";

const clients = {
  policy: async () => ({ id: "decision", allow: true, obligations: [] }),
  approval: async () => ({ id: "approval" }),
  approvalStatus: async () => ({ id: "approval", status: "approved" }),
  context: async () => ({
    items: [{ id: "ctx", content: "visible context" }],
    traceId: "trace",
  }),
  transcript: async (input: unknown) => input,
  capabilities: async () => ({ items: [] }),
  command: async () => ({ matched: false }),
  workflow: async () => {
    throw new Error("unused");
  },
  continuation: async () => {
    throw new Error("unused");
  },
  invokeCapability: async (input: unknown) => input,
  model: async () => ({ output: "unused" }),
  delivery: async (input: unknown) => input,
} as PlatformClients;

describe("runtime provider composition", () => {
  it("mounts providers, persists lifecycle, resolves profiles and writes a replayable ledger", async () => {
    const repo = new MemoryRuntimeRepository();
    const registry = new RuntimeProviderRegistry(repo);
    registry.mount(
      builtInRuntimeProvider({
        kind: "test-runtime",
        run: async () => ({ response: "complete" }),
      }),
    );
    await registry.initialize();
    expect(registry.list()[0]).toMatchObject({
      lifecycleState: "active",
      descriptor: { providerId: "runtime.test-runtime" },
    });
    expect((await registry.probe("runtime.test-runtime")).status).toBe("ready");

    const service = new RuntimeService(
      repo,
      clients,
      registry,
      "/tmp/qft-runtime-provider-test",
    );
    await service.saveProfile({
      id: "00000000-0000-4000-8000-000000000101",
      tenantId: "tenant",
      name: "Production profile",
      enabled: true,
      runtimeProviderId: "runtime.test-runtime",
      promptSectionRefs: [],
      limits: {},
      fallbackProviderIds: [],
    });
    await service.saveBot({
      id: "bot",
      tenantId: "tenant",
      name: "Bot",
      enabled: true,
      runtime: "model-tool-loop",
      runtimeProfileId: "00000000-0000-4000-8000-000000000101",
      maxConcurrentExecutions: 1,
      autonomousReplyBeta: false,
      historyBackfillBeta: false,
      maxBackfillMessages: 100,
    });
    const execution = await service.create({
      tenantId: "tenant",
      botId: "bot",
      prompt: "hello",
    });
    expect(execution.runtimeProviderId).toBe("runtime.test-runtime");
    expect(execution.runtimeProfileSnapshot).toMatchObject({
      profileRevision: 1,
      compatibility: false,
    });
    await service.run(execution.id);
    const events = await service.sessionEvents(execution.runtimeSessionId!);
    expect(events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        "input/accepted",
        "context/materialized",
        "turn/ended",
      ]),
    );
    expect(
      events.find((event) => event.eventType === "context/materialized")
        ?.payload,
    ).toMatchObject({
      materializedItems: [{ content: "visible context" }],
    });
    await service.shutdown();
  });

  it("enforces provider lifecycle transitions", async () => {
    const repo = new MemoryRuntimeRepository();
    const registry = new RuntimeProviderRegistry(repo);
    registry.mount(
      builtInRuntimeProvider({
        kind: "lifecycle",
        run: async () => ({ response: "ok" }),
      }),
    );
    await registry.initialize();
    await registry.transition("runtime.lifecycle", "draining");
    await registry.transition("runtime.lifecycle", "disabled");
    await expect(
      registry.transition("runtime.lifecycle", "canary"),
    ).rejects.toThrow("Cannot move provider");
    expect(
      registry
        .logsFor("runtime.lifecycle")
        .some((entry) => entry.action === "lifecycle"),
    ).toBe(true);
    await registry.dispose();
  });
});
