import { describe, expect, it } from "vitest";
import {
  requireBrowserStateKey,
  requireInternalServiceToken,
} from "../src/config.js";

describe("service configuration", () => {
  it("requires a strong internal token", () => {
    expect(() => requireInternalServiceToken({})).toThrow(
      "at least 32 characters",
    );
    expect(
      requireInternalServiceToken({ INTERNAL_SERVICE_TOKEN: "x".repeat(32) }),
    ).toHaveLength(32);
  });

  it("requires an exact 32-byte browser state key", () => {
    expect(() => requireBrowserStateKey({})).toThrow("is required");
    expect(() =>
      requireBrowserStateKey({
        BROWSER_STATE_KEY_BASE64: Buffer.alloc(16).toString("base64"),
      }),
    ).toThrow("32 bytes");
    expect(
      requireBrowserStateKey({
        BROWSER_STATE_KEY_BASE64: Buffer.alloc(32, 7).toString("base64"),
      }),
    ).toHaveLength(32);
  });
});
