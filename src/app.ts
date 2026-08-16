import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { RuntimeService } from "./service.js";
const ok = (data: unknown, requestId: string) => ({
  ok: true,
  data,
  requestId,
});
export function buildApp(o: {
  service: RuntimeService;
  internalToken: string;
  repository: RuntimeService["repo"];
}) {
  const app = Fastify({ logger: false, genReqId: () => randomUUID() });
  app.addHook("onRequest", async (req, reply) => {
    if (["/healthz", "/readyz", "/version"].includes(req.url)) return;
    if (req.headers.authorization !== `Bearer ${o.internalToken}`)
      return reply.code(401).send({
        ok: false,
        error: { code: "UNAUTHORIZED", message: "Invalid service token" },
        requestId: req.id,
      });
  });
  app.setErrorHandler((e: any, req, reply) =>
    reply.code(e.statusCode ?? 400).send({
      ok: false,
      error: { code: "REQUEST_FAILED", message: e.message },
      requestId: req.id,
    }),
  );
  app.get("/healthz", async (req) =>
    ok({ service: "runtime-center", status: "ok" }, req.id),
  );
  app.get("/readyz", async (req, reply) => {
    const ready = await o.repository.ping();
    return reply.code(ready ? 200 : 503).send(ok({ ready }, req.id));
  });
  app.get("/version", async (req) => ok({ version: "0.1.0" }, req.id));
  const botBody = z.object({
    id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,99}$/),
    tenantId: z.string().min(1),
    name: z.string().min(1).max(100),
    description: z.string().max(500).optional(),
    enabled: z.boolean().default(true),
    runtime: z
      .enum(["model-tool-loop", "openai-agents", "claude-code"])
      .default("model-tool-loop"),
    modelPolicyId: z.string().uuid().optional(),
    systemPrompt: z.string().max(30000).optional(),
    purpose: z.enum(["general", "system-assistant"]).default("general"),
    effectMode: z.enum(["standard", "read-only"]).default("standard"),
    capabilityPolicy: z.enum(["resolved", "none"]).default("resolved"),
    maxConcurrentExecutions: z.number().int().min(1).max(20).default(1),
    autonomousReplyBeta: z.boolean().default(false),
    historyBackfillBeta: z.boolean().default(false),
    maxBackfillMessages: z.number().int().min(0).max(1000).default(100),
  });
  app.get("/v1/bots", async (req) => {
    const query = z
      .object({ tenantId: z.string().optional() })
      .parse(req.query);
    return ok(await o.repository.bots(query.tenantId), req.id);
  });
  app.post("/v1/bots", async (req, reply) =>
    reply
      .code(201)
      .send(ok(await o.service.saveBot(botBody.parse(req.body)), req.id)),
  );
  app.get("/v1/bots/:id", async (req) =>
    ok(
      await o.service.bot(
        z.object({ id: z.string() }).parse(req.params).id,
      ),
      req.id,
    ),
  );
  app.put("/v1/bots/:id", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await o.service.bot(id);
    return ok(
      await o.service.saveBot(botBody.parse({ ...(req.body as object), id })),
      req.id,
    );
  });
  app.delete("/v1/bots/:id", async (req) =>
    ok(
      await o.service.removeBot(
        z.object({ id: z.string() }).parse(req.params).id,
      ),
      req.id,
    ),
  );
  app.post("/v1/executions", async (req, reply) => {
    const input = z
      .object({
        tenantId: z.string(),
        botId: z.string(),
        runtime: z
          .enum(["model-tool-loop", "openai-agents", "claude-code"])
          .optional(),
        prompt: z.string().min(1),
        systemPrompt: z.string().optional(),
        conversationId: z.string().optional(),
        sessionId: z.string().uuid().optional(),
        modelPolicyId: z.string().uuid().optional(),
        source: z.record(z.string(), z.unknown()).optional(),
        contextQuery: z.string().optional(),
      })
      .parse(req.body);
    const execution = await o.service.create(input);
    setImmediate(() =>
      o.service.run(execution.id, input.contextQuery).catch(() => undefined),
    );
    return reply.code(202).send(ok(execution, req.id));
  });
  app.get("/v1/executions", async (req) => {
    const q = z.object({ tenantId: z.string().optional() }).parse(req.query);
    return ok(await o.repository.executions(q.tenantId), req.id);
  });
  app.get("/v1/executions/:id", async (req, reply) => {
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id;
    const execution = await o.repository.execution(id);
    return execution
      ? ok(execution, req.id)
      : reply.code(404).send({ ok: false, error: { code: "NOT_FOUND" } });
  });
  app.get("/v1/executions/:id/events", async (req) => {
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id;
    return ok(await o.repository.events(id), req.id);
  });
  app.post("/v1/executions/:id/resume", async (req) => {
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id;
    const execution = await o.service.resume(id);
    setImmediate(() => o.service.run(id).catch(() => undefined));
    return ok(execution, req.id);
  });
  app.post("/v1/executions/:id/cancel", async (req) =>
    ok(
      await o.service.cancel(
        z.object({ id: z.string().uuid() }).parse(req.params).id,
      ),
      req.id,
    ),
  );
  app.get("/v1/sessions", async (req) => {
    const query = z
      .object({ tenantId: z.string().optional(), botId: z.string().optional() })
      .parse(req.query);
    return ok(await o.service.sessions(query), req.id);
  });
  app.get("/v1/sessions/:id", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { tenantId } = z
      .object({ tenantId: z.string().optional() })
      .parse(req.query);
    return ok(await o.service.getSession(id, tenantId), req.id);
  });
  app.delete("/v1/sessions/:id", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { tenantId } = z
      .object({ tenantId: z.string().optional() })
      .parse(req.query);
    return ok({ removed: await o.service.removeSession(id, tenantId) }, req.id);
  });
  app.addHook("onClose", async () => {
    await o.service.shutdown();
    await o.repository.close();
  });
  return app;
}
