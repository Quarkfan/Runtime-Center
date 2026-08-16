import { randomUUID } from "node:crypto";
import type { AgentRuntime, RuntimeContext } from "./adapters.js";
import {
  CordisPluginKernel,
  type PlatformPluginHandle,
} from "./plugin-kernel.js";
import type { RuntimeRepository } from "./repository.js";
import type {
  ProviderLifecycleState,
  RuntimeKind,
  RuntimeProviderDescriptor,
  RuntimeProviderProbe,
  RuntimeProviderRecord,
} from "./types.js";

export const runtimeContractVersion = "1.0";
export const runtimePlatformApiVersion = "2026-08-16";

export interface RuntimeProvider extends AgentRuntime {
  descriptor: RuntimeProviderDescriptor;
  probe(): Promise<RuntimeProviderProbe>;
  dispose?(): Promise<void>;
}

export interface RuntimeProviderLog {
  id: string;
  providerId: string;
  level: "info" | "error";
  action: string;
  message: string;
  createdAt: string;
}

const now = () => new Date().toISOString();
const runnableStates = new Set<ProviderLifecycleState>(["active", "canary"]);
const transitions: Record<ProviderLifecycleState, ProviderLifecycleState[]> = {
  installed: ["verified", "disabled", "retired"],
  verified: ["canary", "active", "disabled", "retired"],
  canary: ["active", "draining", "disabled", "failed"],
  active: ["draining", "disabled", "failed"],
  draining: ["active", "disabled", "retired"],
  disabled: ["verified", "active", "retired"],
  failed: ["verified", "disabled", "retired"],
  retired: [],
};

export function builtInRuntimeProvider(
  adapter: AgentRuntime,
  options: {
    displayName?: string;
    description?: string;
    enabled?: () => boolean;
    capabilities?: Record<string, boolean | string | number>;
  } = {},
): RuntimeProvider {
  const providerId = adapter.kind.startsWith("runtime.")
    ? adapter.kind
    : `runtime.${adapter.kind}`;
  const descriptor: RuntimeProviderDescriptor = {
    providerId,
    family: "runtime",
    version: "1.0.0",
    contractVersion: runtimeContractVersion,
    displayName: options.displayName ?? adapter.kind,
    description: options.description,
    isolation: "in-process",
    capabilities: {
      cancellation: true,
      continuation: true,
      toolCalling: true,
      structuredOutput: adapter.kind !== "claude-code",
      streaming: false,
      ...options.capabilities,
    },
    configurationSchema: {},
    credentialKinds: [],
    compatibility: {
      platformApi: runtimePlatformApiVersion,
      operatingSystems: ["linux", "darwin"],
      architectures: ["x64", "arm64"],
    },
  };
  return {
    ...adapter,
    kind: providerId,
    descriptor,
    run: (context) => adapter.run(context),
    probe: async () => ({
      status: options.enabled?.() === false ? "unavailable" : "ready",
      observedCapabilities: descriptor.capabilities,
      checkedAt: now(),
      reason:
        options.enabled?.() === false
          ? "Provider is disabled by deployment configuration"
          : undefined,
    }),
  };
}

export class RuntimeProviderRegistry {
  private readonly kernel = new CordisPluginKernel();
  private readonly providers = new Map<string, RuntimeProvider>();
  private readonly handles = new Map<string, PlatformPluginHandle>();
  private readonly records = new Map<string, RuntimeProviderRecord>();
  private readonly logs: RuntimeProviderLog[] = [];

  constructor(readonly repo: RuntimeRepository) {}

  mount(provider: RuntimeProvider, builtIn = true) {
    const id = provider.descriptor.providerId;
    if (provider.descriptor.contractVersion !== runtimeContractVersion)
      throw new Error(
        `Runtime provider ${id} uses incompatible contract ${provider.descriptor.contractVersion}`,
      );
    const handle = this.kernel.mount("runtime:providers", {
      manifest: {
        id,
        version: provider.descriptor.version,
        trust:
          provider.descriptor.isolation === "in-process"
            ? "trusted-in-process"
            : "isolated-adapter",
        provides: [`runtime-provider:${id}`],
      },
      setup: (context) => {
        this.providers.set(id, provider);
        const provided = context.provide(`runtime-provider:${id}`, provider);
        return async () => {
          this.providers.delete(id);
          provided();
          await provider.dispose?.();
        };
      },
    });
    this.handles.set(id, handle);
    const timestamp = now();
    this.records.set(id, {
      descriptor: provider.descriptor,
      lifecycleState: "active",
      builtIn,
      generation: 1,
      installedAt: timestamp,
      updatedAt: timestamp,
    });
    this.log(id, "info", "mount", "Provider mounted through PluginKernel");
  }

  async initialize() {
    await Promise.all(
      [...this.handles.values()].map((handle) => handle.ready()),
    );
    for (const [id, candidate] of this.records) {
      const existing = await this.repo.runtimeProvider(id);
      const record: RuntimeProviderRecord = existing
        ? {
            ...existing,
            descriptor: candidate.descriptor,
            builtIn: candidate.builtIn,
            generation:
              existing.descriptor.version === candidate.descriptor.version
                ? existing.generation
                : existing.generation + 1,
            updatedAt: now(),
          }
        : candidate;
      this.records.set(id, record);
      await this.repo.saveRuntimeProvider(record);
    }
  }

  list() {
    return [...this.records.values()].sort((a, b) =>
      a.descriptor.displayName.localeCompare(b.descriptor.displayName),
    );
  }

  get(id: string) {
    const record = this.records.get(normalizeRuntimeProviderId(id));
    if (!record)
      throw Object.assign(new Error("Runtime provider not found"), {
        statusCode: 404,
      });
    return record;
  }

  async run(id: string, context: RuntimeContext) {
    const normalized = normalizeRuntimeProviderId(id);
    const handle = this.handles.get(normalized);
    if (!handle) throw new Error(`Runtime provider unavailable: ${normalized}`);
    await handle.ready();
    const record = this.get(normalized);
    if (!runnableStates.has(record.lifecycleState))
      throw new Error(
        `Runtime provider ${normalized} is ${record.lifecycleState}`,
      );
    const provider = this.providers.get(normalized);
    if (!provider)
      throw new Error(
        `Runtime provider ${normalized} is not active in PluginKernel`,
      );
    this.log(
      normalized,
      "info",
      "execute",
      `Execution ${context.execution.id} admitted`,
    );
    try {
      return await provider.run(context);
    } catch (error) {
      this.log(
        normalized,
        "error",
        "execute",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  async probe(id: string) {
    const normalized = normalizeRuntimeProviderId(id);
    const provider = this.providers.get(normalized);
    if (!provider)
      throw Object.assign(new Error("Runtime provider is not mounted"), {
        statusCode: 409,
      });
    const started = Date.now();
    let probe: RuntimeProviderProbe;
    try {
      probe = await provider.probe();
      probe.latencyMs ??= Date.now() - started;
    } catch (error) {
      probe = {
        status: "unavailable",
        observedCapabilities: {},
        checkedAt: now(),
        latencyMs: Date.now() - started,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    const record = this.get(normalized);
    record.lastProbe = probe;
    record.lastError = probe.status === "ready" ? undefined : probe.reason;
    record.updatedAt = now();
    await this.repo.saveRuntimeProvider(record);
    this.log(
      normalized,
      probe.status === "ready" ? "info" : "error",
      "probe",
      probe.reason ?? probe.status,
    );
    return probe;
  }

  async transition(id: string, state: ProviderLifecycleState) {
    const record = this.get(id);
    if (record.lifecycleState === state) return record;
    if (!transitions[record.lifecycleState].includes(state))
      throw Object.assign(
        new Error(
          `Cannot move provider from ${record.lifecycleState} to ${state}`,
        ),
        { statusCode: 409 },
      );
    if (["verified", "canary", "active"].includes(state)) {
      const probe = await this.probe(id);
      if (probe.status !== "ready")
        throw Object.assign(
          new Error(
            `Provider probe is ${probe.status}: ${probe.reason ?? "unknown reason"}`,
          ),
          { statusCode: 409 },
        );
    }
    record.lifecycleState = state;
    record.updatedAt = now();
    await this.repo.saveRuntimeProvider(record);
    this.log(
      record.descriptor.providerId,
      "info",
      "lifecycle",
      `Provider moved to ${state}`,
    );
    return record;
  }

  logsFor(id?: string) {
    return this.logs
      .filter(
        (item) => !id || item.providerId === normalizeRuntimeProviderId(id),
      )
      .slice(-200)
      .reverse();
  }

  async dispose() {
    await this.kernel.dispose();
  }

  private log(
    providerId: string,
    level: RuntimeProviderLog["level"],
    action: string,
    message: string,
  ) {
    this.logs.push({
      id: randomUUID(),
      providerId,
      level,
      action,
      message,
      createdAt: now(),
    });
    if (this.logs.length > 1000) this.logs.splice(0, this.logs.length - 1000);
  }
}

export function normalizeRuntimeProviderId(id: RuntimeKind) {
  return id.startsWith("runtime.") ? id : `runtime.${id}`;
}

export function legacyRuntimeName(providerId: string) {
  return providerId.startsWith("runtime.")
    ? providerId.slice("runtime.".length)
    : providerId;
}
