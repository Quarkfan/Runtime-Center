import { mkdir, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type {
  BrowserDependencies,
  BrowserEngine,
  BrowserHandle,
} from "../src/browser.js";
import { BrowserWorkerService } from "../src/browser.js";
class FakeHandle implements BrowserHandle {
  current = "about:blank";
  clicks = 0;
  url() {
    return this.current;
  }
  async title() {
    return "Page";
  }
  async navigate(url: string) {
    this.current = url;
  }
  async click() {
    this.clicks++;
  }
  async fill() {}
  async select() {}
  async check() {}
  async press() {}
  async hover() {}
  async wait() {}
  async inspect() {
    return {
      url: this.current,
      title: "Page",
      text: "Dashboard content",
      elements: [
        { selector: "#read", tag: "button", name: "Read details" },
        { selector: "#submit", tag: "button", name: "Save changes" },
      ],
    };
  }
  async extract() {
    return "content";
  }
  async download(_selector: string, path: string) {
    await writeFile(path, "download");
    return "report.txt";
  }
  async pdf(path: string) {
    await writeFile(path, "pdf");
  }
  async screenshot(path: string) {
    await writeFile(path, "png");
  }
  async close(trace?: string) {
    if (trace) await writeFile(trace, "trace");
    return { videoPaths: [] };
  }
}
describe("Browser Worker", () => {
  const roots: string[] = [];
  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    await Promise.all(
      roots.splice(0).map((x) => rm(x, { recursive: true, force: true })),
    );
  });
  async function setup(approved = false, requireApproval = true) {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "qft-browser-"));
    roots.push(root);
    const handle = new FakeHandle();
    const artifacts: Array<{ name: string; mediaType: string }> = [];
    let opens = 0;
    let isApproved = approved;
    const modelDecisions: unknown[] = [];
    const engine: BrowserEngine = {
      open: async (dir) => {
        opens++;
        await mkdir(dir, { recursive: true });
        return handle;
      },
    };
    const deps: BrowserDependencies = {
      policy: async () => ({
        id: "decision",
        obligations: requireApproval ? [{ type: "approval" }] : [],
      }),
      requestApproval: async () => ({
        id: "00000000-0000-4000-8000-000000000001",
      }),
      approval: async () =>
        isApproved
          ? {
              id: "00000000-0000-4000-8000-000000000001",
              tenantId: "t1",
              requesterId: "b1",
              action: "browser.click",
              resource: { sessionKey: "crm", step: 1 },
              status: "approved",
              expiresAt: "2099-01-01T00:00:00.000Z",
            }
          : undefined,
      artifact: async (input) => {
        artifacts.push({ name: input.name, mediaType: input.mediaType });
        return { id: `artifact-${artifacts.length}` };
      },
      model: async () =>
        modelDecisions.shift() ?? {
          output: JSON.stringify({ state: "done", answer: "completed" }),
        },
    };
    return {
      service: new BrowserWorkerService(engine, deps, root),
      handle,
      getOpens: () => opens,
      artifacts,
      approve: () => {
        isApproved = true;
      },
      plan: (...decisions: unknown[]) => modelDecisions.push(...decisions),
    };
  }
  const base = {
    tenantId: "t1",
    botId: "b1",
    sessionKey: "crm",
    allowedDomains: ["example.com"],
    keepAlive: true,
    correlationId: "c1",
  };
  it("blocks loopback and private network navigation by default", async () => {
    const { service } = await setup(false, false);
    expect(service.allowed("https://example.com/path", ["example.com"])).toBe(
      true,
    );
    expect(service.allowed("http://127.0.0.1/admin", ["127.0.0.1"])).toBe(
      false,
    );
    expect(service.allowed("http://169.254.169.254/latest", ["169.254.169.254"])).toBe(
      false,
    );
    expect(service.allowed("http://10.0.0.8", ["10.0.0.8"])).toBe(false);
  });
  it("blocks navigation outside the allowlist", async () => {
    const { service } = await setup();
    const r = await service.run({
      ...base,
      actions: [{ type: "navigate", url: "https://evil.test" }],
    });
    expect(r.status).toBe("failed");
    expect(r.steps[0]?.error).toContain("not allowed");
  });
  it("stops before a sensitive action and returns an approval id", async () => {
    const { service, handle } = await setup();
    const r = await service.run({
      ...base,
      startUrl: "https://example.com",
      actions: [{ type: "click", selector: "#submit" }],
    });
    expect(r.status).toBe("waiting_approval");
    expect(handle.clicks).toBe(0);
    expect((r.steps.at(-1)?.output as any).approvalId).toBeTruthy();
  });
  it("continues an approved action and reuses the stable session", async () => {
    const { service, handle, getOpens, approve } = await setup();
    const request = {
      ...base,
      startUrl: "https://example.com",
      actions: [{ type: "click" as const, selector: "#submit" }],
    };
    expect((await service.run(request)).status).toBe("waiting_approval");
    approve();
    expect(
      (
        await service.run({
          ...request,
          approvalId: "00000000-0000-4000-8000-000000000001",
        })
      ).status,
    ).toBe("succeeded");
    expect(
      (
        await service.run({
          ...request,
          approvalId: undefined,
          actions: [{ type: "extract", selector: "body" }],
        })
      ).status,
    ).toBe("succeeded");
    expect(handle.clicks).toBe(1);
    expect(getOpens()).toBe(1);
  });
  it("captures governed download, PDF and close artifacts", async () => {
    const { service, artifacts } = await setup(false, false);
    const result = await service.run({
      ...base,
      actions: [
        { type: "download", selector: "#download", name: "report.txt" },
        { type: "pdf", name: "page.pdf", format: "A4" },
      ],
      keepAlive: false,
    });
    expect(result.status).toBe("succeeded");
    expect(result.steps.every((step) => step.artifactId)).toBe(true);
    expect(artifacts.map((artifact) => artifact.mediaType)).toEqual([
      "text/plain",
      "application/pdf",
      "application/zip",
    ]);
  });
  it("runs a natural-language browser goal through inspect and model planning", async () => {
    const { service, handle, plan } = await setup();
    plan(
      {
        output: JSON.stringify({
          state: "act",
          action: { type: "click", selector: "#read" },
          reason: "Open details",
        }),
      },
      {
        output: JSON.stringify({ state: "done", answer: "Details opened" }),
      },
    );
    const result = await service.runAgent({
      ...base,
      goal: "Open the details page",
      startUrl: "https://example.com",
      maxSteps: 4,
    });
    expect(result.status).toBe("succeeded");
    expect((result as any).answer).toBe("Details opened");
    expect(handle.clicks).toBe(1);
    expect(result.steps.some((step) => step.action === "inspect")).toBe(true);
  });
  it("keeps a browser session alive when external authentication is needed", async () => {
    const { service, plan, artifacts } = await setup();
    plan({
      output: JSON.stringify({
        state: "waiting_user",
        answer: "Complete the sign-in in the browser",
      }),
    });
    const result = await service.runAgent({
      ...base,
      goal: "Sign in and read the dashboard",
      startUrl: "https://example.com",
      authenticationFlow: "external-wait",
      maxSteps: 4,
    });
    expect(result.status).toBe("waiting_user");
    expect(
      artifacts.some((artifact) => artifact.mediaType === "image/png"),
    ).toBe(true);
    expect(service.listSessions({ tenantId: "t1" })).toHaveLength(1);
  });
});
