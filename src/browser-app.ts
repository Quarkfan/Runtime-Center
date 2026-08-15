import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { BrowserWorkerService } from "./browser.js";
const action = z.discriminatedUnion("type", [
  z.object({ type: z.literal("navigate"), url: z.string().url() }),
  z.object({
    type: z.literal("click"),
    selector: z.string(),
    sensitive: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("fill"),
    selector: z.string(),
    value: z.string(),
    sensitive: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("select"),
    selector: z.string(),
    value: z.string(),
  }),
  z.object({
    type: z.literal("check"),
    selector: z.string(),
    checked: z.boolean(),
  }),
  z.object({ type: z.literal("press"), selector: z.string(), key: z.string() }),
  z.object({ type: z.literal("hover"), selector: z.string() }),
  z.object({
    type: z.literal("wait"),
    selector: z.string().optional(),
    milliseconds: z.number().int().min(0).max(30000).optional(),
  }),
  z.object({ type: z.literal("inspect") }),
  z.object({ type: z.literal("extract"), selector: z.string() }),
  z.object({
    type: z.literal("download"),
    selector: z.string(),
    name: z.string().min(1).max(200).optional(),
  }),
  z.object({
    type: z.literal("pdf"),
    name: z.string().min(1).max(200).optional(),
    format: z.enum(["A4", "Letter"]).optional(),
  }),
  z.object({
    type: z.literal("screenshot"),
    name: z.string().optional(),
    fullPage: z.boolean().optional(),
  }),
]);
export function buildBrowserApp(o: {
  service: BrowserWorkerService;
  internalToken: string;
  ready?: () => Promise<boolean>;
}) {
  const app = Fastify({ logger: false, genReqId: () => randomUUID() });
  app.addHook("onRequest", async (req, reply) => {
    if (["/healthz", "/readyz", "/version"].includes(req.url)) return;
    if (req.headers.authorization !== `Bearer ${o.internalToken}`)
      return reply
        .code(401)
        .send({ ok: false, error: { code: "UNAUTHORIZED" } });
  });
  app.get("/healthz", async () => ({
    ok: true,
    data: { service: "browser-worker", status: "ok" },
  }));
  app.get("/readyz", async (_req, reply) => {
    const ready = (await o.ready?.()) ?? true;
    return reply.code(ready ? 200 : 503).send({
      ok: ready,
      ...(ready
        ? { data: { service: "browser-worker", status: "ready" } }
        : {
            error: {
              code: "UNAVAILABLE",
              message: "Browser dependencies are unavailable",
            },
          }),
    });
  });
  app.get("/version", async () => ({ ok: true, data: { version: "0.1.0" } }));
  app.post("/v1/browser/workflows", async (req, reply) => {
    const input = z
      .object({
        tenantId: z.string(),
        botId: z.string(),
        sessionKey: z.string().min(1).max(200),
        startUrl: z.string().url().optional(),
        allowedDomains: z.array(z.string().min(1)).min(1).max(50),
        actions: z.array(action).max(50),
        keepAlive: z.boolean().default(false),
        recordVideo: z.boolean().default(false),
        approvalId: z.string().uuid().optional(),
        correlationId: z.string(),
      })
      .parse(req.body);
    return reply.code(202).send({ ok: true, data: await o.service.run(input) });
  });
  app.post("/v1/browser/agent-tasks", async (req, reply) => {
    const input = z
      .object({
        tenantId: z.string(),
        botId: z.string(),
        goal: z.string().min(1).max(20000),
        sessionKey: z.string().min(1).max(200),
        startUrl: z.string().url().optional(),
        allowedDomains: z.array(z.string().min(1)).min(1).max(50),
        modelPolicyId: z.string().uuid().optional(),
        authenticationFlow: z
          .enum([
            "external-wait",
            "credential-login",
            "captcha-assisted",
            "otp-assisted",
            "manual-input",
            "none",
            "custom",
          ])
          .default("none"),
        maxSteps: z.number().int().min(1).max(30).default(20),
        keepAlive: z.boolean().default(false),
        recordVideo: z.boolean().default(false),
        approvalId: z.string().uuid().optional(),
        correlationId: z.string(),
      })
      .parse(req.body);
    return reply
      .code(202)
      .send({ ok: true, data: await o.service.runAgent(input) });
  });
  app.get("/v1/browser/sessions", async (req) => {
    const query = z
      .object({ tenantId: z.string().optional(), botId: z.string().optional() })
      .parse(req.query);
    return { ok: true, data: o.service.listSessions(query) };
  });
  app.delete("/v1/browser/sessions/:sessionKey", async (req) => {
    const { sessionKey } = z
      .object({ sessionKey: z.string().min(1).max(200) })
      .parse(req.params);
    const query = z
      .object({ tenantId: z.string(), botId: z.string() })
      .parse(req.query);
    return {
      ok: true,
      data: await o.service.closeSession(
        query.tenantId,
        query.botId,
        sessionKey,
      ),
    };
  });
  return app;
}
