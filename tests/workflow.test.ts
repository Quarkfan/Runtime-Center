import { describe, expect, it } from "vitest";
import type { PlatformClients } from "../src/clients.js";
import { WorkflowRunner } from "../src/workflow.js";

function clients(overrides: Partial<PlatformClients> = {}): PlatformClients {
  return {
    policy: async () => ({}),
    approval: async () => ({}),
    approvalStatus: async () => ({}),
    context: async () => ({}),
    transcript: async () => ({}),
    capabilities: async () => ({}),
    command: async () => ({}),
    workflow: async () => ({}),
    continuation: async () => ({}),
    invokeCapability: async () => ({}),
    model: async () => ({}),
    delivery: async () => ({}),
    ...overrides,
  };
}

describe("Workflow runner", () => {
  it("runs deterministic steps, references outputs and checkpoints each step", async () => {
    const invoked: any[] = [];
    const checkpoints: Array<Record<string, unknown>> = [];
    const runner = new WorkflowRunner(
      clients({
        invokeCapability: async (input) => {
          invoked.push(input);
          return { output: { count: 42 } };
        },
      }),
    );
    const result = await runner.run({
      tenantId: "tenant-1",
      botId: "bot-1",
      executionId: "execution-1",
      prompt: "snapshot",
      workflowInput: { mode: "morning", enabled: true },
      definition: {
        version: 1,
        timeoutMs: 10_000,
        steps: [
          {
            id: "label",
            type: "template",
            template: "{{input.mode}} snapshot",
            timeoutMs: 1_000,
          },
          {
            id: "save",
            type: "capability",
            capabilityId: "tool.snapshot",
            input: { label: "{{steps.label}}", enabled: "{{input.enabled}}" },
            timeoutMs: 1_000,
          },
        ],
        output: "saved {{steps.save.count}} records",
      },
      signal: new AbortController().signal,
      emit: async () => undefined,
      checkpoint: async (outputs) => {
        checkpoints.push(structuredClone(outputs));
      },
    });
    expect(result).toBe("saved 42 records");
    expect(invoked[0]).toMatchObject({
      capabilityId: "tool.snapshot",
      trigger: "workflow",
      input: { label: "morning snapshot", enabled: true },
    });
    expect(checkpoints).toHaveLength(2);
  });

  it("skips durable completed steps when an approval resumes a workflow", async () => {
    let calls = 0;
    const runner = new WorkflowRunner(
      clients({
        invokeCapability: async () => {
          calls++;
          return { output: { text: "done" } };
        },
      }),
    );
    const result = await runner.run({
      tenantId: "tenant-1",
      botId: "bot-1",
      executionId: "execution-1",
      prompt: "resume",
      workflowInput: {},
      completed: { first: "already done" },
      definition: {
        version: 1,
        timeoutMs: 10_000,
        steps: [
          {
            id: "first",
            type: "template",
            template: "must not run",
            timeoutMs: 1_000,
          },
          {
            id: "second",
            type: "capability",
            capabilityId: "tool.finish",
            input: {},
            timeoutMs: 1_000,
          },
        ],
      },
      signal: new AbortController().signal,
      emit: async () => undefined,
      checkpoint: async () => undefined,
    });
    expect(result).toBe("done");
    expect(calls).toBe(1);
  });
});
