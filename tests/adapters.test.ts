import { describe, expect, it } from "vitest";
import {
  ModelToolLoopRuntime,
  OpenAIAgentsRuntime,
} from "../src/adapters.js";
import type { PlatformClients } from "../src/clients.js";

describe("Model tool loop runtime", () => {
  it("executes only resolved capabilities and feeds results back to the model", async () => {
    const invoked: any[] = [];
    const modelInputs: any[] = [];
    const events: any[] = [];
    const clients: PlatformClients = {
      policy: async () => ({ allow: true }),
      approval: async () => ({}),
      approvalStatus: async () => ({ status: "approved" }),
      context: async () => ({ items: [] }),
      transcript: async () => ({}),
      capabilities: async () => ({ items: [] }),
      command: async () => ({ matched: false }),
      workflow: async () => ({}),
      continuation: async () => ({}),
      delivery: async () => ({}),
      invokeCapability: async (input) => {
        invoked.push(input);
        return { output: { title: "Example" } };
      },
      model: async (input: any) => {
        modelInputs.push(input);
        if (modelInputs.length === 1)
          return {
            output: {
              type: "assistant",
              text: "",
              toolCalls: [
                {
                  id: "call-1",
                  name: input.tools[0].function.name,
                  input: {
                    sessionKey: "web",
                    allowedDomains: ["example.com"],
                    actions: [],
                  },
                },
              ],
            },
          };
        return { output: "The page title is Example." };
      },
    };
    const runtime = new ModelToolLoopRuntime(clients);
    const result = await runtime.run({
      execution: {
        id: "execution-1",
        tenantId: "tenant-1",
        botId: "bot-1",
        runtime: "model-tool-loop",
        prompt: "Read the page",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        source: {},
        status: "running",
        createdAt: new Date().toISOString(),
      },
      workspace: "/tmp/runtime-test",
      history: [],
      abortController: new AbortController(),
      contextItems: [],
      capabilities: [
        {
          manifest: {
            id: "builtin.browser.playwright-workflow",
            description: "Browser",
            inputSchema: { type: "object" },
          },
          binding: { id: "binding-1" },
        },
      ],
      emit: async (type, data) => {
        events.push({ type, data });
      },
    });
    expect(result.response).toBe("The page title is Example.");
    expect(invoked[0]).toMatchObject({
      tenantId: "tenant-1",
      botId: "bot-1",
      capabilityId: "builtin.browser.playwright-workflow",
    });
    expect(modelInputs[1].messages.at(-1)).toMatchObject({
      role: "tool",
      toolCallId: "call-1",
    });
    expect(events.map((event) => event.type)).toContain("tool_call");
    expect(events.map((event) => event.type)).toContain("tool_result");
  });
  it("injects prompt Skills as instructions without exposing them as callable tools", async () => {
    let modelInput: any;
    const clients: PlatformClients = {
      policy: async () => ({ allow: true }),
      approval: async () => ({}),
      approvalStatus: async () => ({ status: "approved" }),
      context: async () => ({ items: [] }),
      transcript: async () => ({}),
      capabilities: async () => ({ items: [] }),
      command: async () => ({ matched: false }),
      workflow: async () => ({}),
      continuation: async () => ({}),
      delivery: async () => ({}),
      invokeCapability: async () => {
        throw new Error("Skill must not be invoked as a tool");
      },
      model: async (input) => {
        modelInput = input;
        return { output: "followed" };
      },
    };
    const runtime = new ModelToolLoopRuntime(clients);
    const result = await runtime.run({
      execution: {
        id: "execution-skill",
        tenantId: "tenant-1",
        botId: "bot-1",
        runtime: "model-tool-loop",
        prompt: "Use the Skill",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        source: {},
        status: "running",
        createdAt: new Date().toISOString(),
      },
      workspace: "/tmp/runtime-skill-test",
      history: [],
      abortController: new AbortController(),
      contextItems: [],
      capabilities: [
        {
          manifest: {
            id: "skill.example",
            name: "Example",
            description: "Example Skill",
            kind: "skill",
            runtime: { type: "prompt" },
            raw: {
              skill: {
                files: [{ path: "SKILL.md", content: "Always cite evidence." }],
              },
            },
          },
          binding: { id: "binding-skill" },
        },
      ],
      emit: async () => undefined,
    });
    expect(result.response).toBe("followed");
    expect(modelInput.tools).toEqual([]);
    expect(
      modelInput.messages.some(
        (message: any) =>
          message.role === "system" &&
          message.content.includes("Always cite evidence."),
      ),
    ).toBe(true);
  });
});

describe("OpenAI Agents runtime", () => {
  it("uses the official SDK loop while delegating models and tools to platform centers", async () => {
    const modelInputs: any[] = [],
      invocations: any[] = [],
      events: any[] = [];
    const clients: PlatformClients = {
      policy: async () => ({ allow: true }),
      approval: async () => ({}),
      approvalStatus: async () => ({ status: "approved" }),
      context: async () => ({ items: [] }),
      transcript: async () => ({}),
      capabilities: async () => ({ items: [] }),
      command: async () => ({ matched: false }),
      workflow: async () => ({}),
      continuation: async () => ({}),
      delivery: async () => ({}),
      invokeCapability: async (input) => {
        invocations.push(input);
        return { output: { title: "Platform page" } };
      },
      model: async (input: any) => {
        modelInputs.push(input);
        if (modelInputs.length === 1)
          return {
            invocationId: "model-call-1",
            output: {
              type: "assistant",
              text: "",
              toolCalls: [
                {
                  id: "tool-call-1",
                  name: input.tools[0].function.name,
                  input: { url: "https://example.com" },
                },
              ],
            },
            usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
          };
        return {
          invocationId: "model-call-2",
          output: "The title is Platform page.",
          usage: { inputTokens: 20, outputTokens: 7, totalTokens: 27 },
        };
      },
    };
    const runtime = new OpenAIAgentsRuntime(clients);
    const result = await runtime.run({
      execution: {
        id: "execution-openai-agents",
        tenantId: "tenant-1",
        botId: "bot-1",
        runtime: "openai-agents",
        prompt: "Read the page title",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        source: {},
        status: "running",
        createdAt: new Date().toISOString(),
      },
      workspace: "/tmp/runtime-openai-agents-test",
      history: [],
      abortController: new AbortController(),
      contextItems: [],
      capabilities: [
        {
          manifest: {
            id: "builtin.browser.read",
            name: "Browser read",
            description: "Read a web page",
            kind: "tool",
            runtime: { type: "builtin" },
            inputSchema: {
              type: "object",
              properties: { url: { type: "string" } },
              required: ["url"],
              additionalProperties: false,
            },
          },
          binding: { id: "binding-1", config: {} },
        },
      ],
      emit: async (type, data) => {
        events.push({ type, data });
      },
    });
    expect(result.response).toBe("The title is Platform page.");
    expect(modelInputs).toHaveLength(2);
    expect(modelInputs[1].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          toolCallId: "tool-call-1",
        }),
      ]),
    );
    expect(invocations[0]).toMatchObject({
      tenantId: "tenant-1",
      botId: "bot-1",
      capabilityId: "builtin.browser.read",
    });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["tool_call", "tool_result"]),
    );
  });
});
