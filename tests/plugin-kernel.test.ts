import { describe, expect, it } from "vitest";
import {
  CordisPluginKernel,
  type PlatformPluginModule,
} from "../src/plugin-kernel.js";

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("CordisPluginKernel", () => {
  it("isolates services between scopes", async () => {
    const kernel = new CordisPluginKernel();
    const values: string[] = [];

    const provider = (value: string): PlatformPluginModule => ({
      manifest: {
        id: `provider-${value}`,
        version: "1.0.0",
        trust: "trusted-in-process",
        provides: ["clock"],
      },
      setup: (ctx) => ctx.provide("clock", { value }),
    });
    const consumer = (id: string): PlatformPluginModule => ({
      manifest: {
        id,
        version: "1.0.0",
        trust: "trusted-in-process",
        requires: ["clock"],
      },
      setup: (ctx) => {
        values.push(ctx.get<{ value: string }>("clock").value);
      },
    });

    kernel.mount("bot:a", provider("a"));
    kernel.mount("bot:b", provider("b"));
    kernel.mount("bot:a", consumer("consumer-a"));
    kernel.mount("bot:b", consumer("consumer-b"));
    await tick();

    expect(values).toEqual(["a", "b"]);
    await kernel.dispose();
  });

  it("waits for dependencies and returns to pending when they disappear", async () => {
    const kernel = new CordisPluginKernel();
    const lifecycle: string[] = [];
    const consumer = kernel.mount("profile:one", {
      manifest: {
        id: "consumer",
        version: "1.0.0",
        trust: "trusted-in-process",
        requires: ["model"],
      },
      setup: (ctx) => {
        lifecycle.push(ctx.get<{ id: string }>("model").id);
        return () => lifecycle.push("consumer-disposed");
      },
    });

    expect(consumer.state).toBe("pending");
    const provider = kernel.mount("profile:one", {
      manifest: {
        id: "provider",
        version: "1.0.0",
        trust: "trusted-in-process",
        provides: ["model"],
      },
      setup: (ctx) => ctx.provide("model", { id: "model-a" }),
    });
    await tick();
    expect(consumer.state).toBe("active");
    expect(lifecycle).toEqual(["model-a"]);

    await provider.dispose();
    await tick();
    expect(consumer.state).toBe("pending");
    expect(lifecycle).toEqual(["model-a", "consumer-disposed"]);
    await kernel.dispose();
  });

  it("awaits cleanup and removes lifecycle-owned listeners", async () => {
    const kernel = new CordisPluginKernel();
    const events: string[] = [];
    const observer = kernel.mount("session:one", {
      manifest: {
        id: "observer",
        version: "1.0.0",
        trust: "trusted-in-process",
        subscribes: ["runtime/ping"],
      },
      setup: (ctx) => {
        ctx.on("runtime/ping", async (value) => {
          events.push(String(value));
        });
        return async () => {
          await tick();
          events.push("disposed");
        };
      },
    });
    const emitter = kernel.mount("session:one", {
      manifest: {
        id: "emitter",
        version: "1.0.0",
        trust: "trusted-in-process",
        emits: ["runtime/ping"],
      },
      setup: (ctx) => ctx.emit("runtime/ping", "before"),
    });
    await tick();
    expect(events).toContain("before");

    await observer.dispose();
    expect(events.at(-1)).toBe("disposed");
    await emitter.dispose();
    await kernel.dispose();
  });

  it("rejects undeclared access at the stable facade", async () => {
    const kernel = new CordisPluginKernel();
    const invalid = kernel.mount("bot:a", {
      manifest: {
        id: "invalid",
        version: "1.0.0",
        trust: "trusted-in-process",
      },
      setup: (ctx) => ctx.provide("secret", "value"),
    });
    await tick();
    expect(invalid.state).toBe("failed");
    await expect(kernel.dispose()).resolves.toBeUndefined();
  });

  it("disposes a scope in reverse mount order", async () => {
    const kernel = new CordisPluginKernel();
    const disposed: string[] = [];
    const handles = [];
    for (const id of ["one", "two", "three"]) {
      handles.push(
        kernel.mount("profile:ordered", {
          manifest: {
            id,
            version: "1.0.0",
            trust: "trusted-in-process",
          },
          setup: () => () => {
            disposed.push(id);
          },
        }),
      );
    }

    await Promise.all(handles.map((handle) => handle.ready()));
    await kernel.disposeScope("profile:ordered");
    expect(disposed).toEqual(["three", "two", "one"]);
    await kernel.dispose();
  });
});
