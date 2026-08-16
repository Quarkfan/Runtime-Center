import { buildApp } from "./app.js";
import {
  ClaudeCodeRuntime,
  ModelToolLoopRuntime,
  OpenAIAgentsRuntime,
} from "./adapters.js";
import {
  builtInRuntimeProvider,
  RuntimeProviderRegistry,
} from "./providers.js";
import { HttpPlatformClients } from "./clients.js";
import { PgRuntimeRepository } from "./pg-repository.js";
import { MemoryRuntimeRepository } from "./repository.js";
import { RuntimeService } from "./service.js";
import { requireInternalServiceToken } from "./config.js";
const url = process.env.DATABASE_URL;
const repository = url
  ? new PgRuntimeRepository(url)
  : new MemoryRuntimeRepository();
await repository.migrate();
const token = requireInternalServiceToken();
const clients = new HttpPlatformClients(
  {
    model: process.env.MODEL_HUB_URL ?? "http://127.0.0.1:4103",
    context: process.env.CONTEXT_HUB_URL ?? "http://127.0.0.1:4102",
    capabilities:
      process.env.CAPABILITY_REGISTRY_URL ?? "http://127.0.0.1:4104",
    governance: process.env.GOVERNANCE_URL ?? "http://127.0.0.1:4108",
    message: process.env.MESSAGE_GATEWAY_URL ?? "http://127.0.0.1:4101",
    scheduler: process.env.SCHEDULER_URL ?? "http://127.0.0.1:4106",
  },
  token,
);
const claudeEnabled = process.env.CLAUDE_RUNTIME_ENABLED === "true";
const providers = new RuntimeProviderRegistry(repository);
providers.mount(
  builtInRuntimeProvider(new ModelToolLoopRuntime(clients), {
    displayName: "Model Tool Loop",
    description: "QuarkfanTools native model and governed capability loop",
  }),
);
providers.mount(
  builtInRuntimeProvider(new OpenAIAgentsRuntime(clients), {
    displayName: "OpenAI Agents SDK",
    description: "OpenAI Agents SDK bridged through Model Hub",
  }),
);
providers.mount(
  builtInRuntimeProvider(
    new ClaudeCodeRuntime({
      enabled: process.env.CLAUDE_RUNTIME_ENABLED === "true",
      baseUrl: process.env.CLAUDE_RUNTIME_BASE_URL,
      authToken: process.env.CLAUDE_RUNTIME_AUTH_TOKEN,
      model: process.env.CLAUDE_RUNTIME_MODEL,
      maxTurns: Number(process.env.CLAUDE_RUNTIME_MAX_TURNS ?? 60),
    }),
    {
      displayName: "Claude Code SDK",
      description: "Claude Code runtime with workspace and MCP support",
      enabled: () => claudeEnabled,
      capabilities: { externalSessionImport: true, mcp: true },
    },
  ),
);
await providers.initialize();
const service = new RuntimeService(
  repository,
  clients,
  providers,
  process.env.RUNTIME_WORKSPACE_ROOT ?? "./workspaces",
);
await service.recover();
await buildApp({ service, repository, internalToken: token }).listen({
  host: process.env.HOST ?? "0.0.0.0",
  port: Number(process.env.PORT ?? 4105),
});
