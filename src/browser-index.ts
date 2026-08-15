import { buildBrowserApp } from "./browser-app.js";
import { createHash } from "node:crypto";
import { HttpBrowserDependencies } from "./browser-clients.js";
import { BrowserWorkerService, PlaywrightEngine } from "./browser.js";
const token = process.env.INTERNAL_SERVICE_TOKEN ?? "development-only";
const stateSecret = process.env.BROWSER_STATE_KEY_BASE64;
if (process.env.NODE_ENV === "production" && !stateSecret)
  throw new Error("BROWSER_STATE_KEY_BASE64 is required in production");
const stateKey = createHash("sha256")
  .update(Buffer.from(stateSecret ?? "development-browser-state"))
  .update("quarkfantools/browser-storage-state/v1")
  .digest();
const root = process.env.BROWSER_SESSION_ROOT ?? "./browser-sessions";
const allowPrivateNetworks =
  process.env.BROWSER_ALLOW_PRIVATE_NETWORKS === "true";
const engine = new PlaywrightEngine(
  stateKey,
  allowPrivateNetworks,
);
await engine.migrateRoot(root);
const dependencies = new HttpBrowserDependencies(
  process.env.GOVERNANCE_URL ?? "http://127.0.0.1:4108",
  process.env.RESOURCE_URL ?? "http://127.0.0.1:4107",
  process.env.MH_URL ?? "http://127.0.0.1:4103",
  token,
);
const service = new BrowserWorkerService(
  engine,
  dependencies,
  root,
  Number(process.env.BROWSER_SESSION_TTL_MS ?? 30 * 60 * 1000),
  allowPrivateNetworks,
);
await buildBrowserApp({
  service,
  internalToken: token,
  ready: () => dependencies.ready(),
}).listen({
  host: process.env.HOST ?? "0.0.0.0",
  port: Number(process.env.BROWSER_PORT ?? 4110),
});
