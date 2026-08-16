import {
  Context,
  type Disposable,
  type Fiber,
  type Plugin,
} from "@deepseek-ai/cordis";

export type PluginExecutionTrust = "trusted-in-process" | "isolated-adapter";

export interface PlatformPluginManifest {
  id: string;
  version: string;
  trust: PluginExecutionTrust;
  requires?: string[];
  provides?: string[];
  subscribes?: string[];
  emits?: string[];
}

export interface PlatformPluginContext {
  readonly scopeId: string;
  get<T>(service: string): T;
  provide<T>(service: string, value: T): Disposable;
  on(
    event: string,
    listener: (...args: unknown[]) => void | Promise<void>,
  ): Disposable;
  emit(event: string, ...args: unknown[]): void;
  effect(
    setup: () => Disposable | Promise<Disposable>,
    label?: string,
  ): Disposable<Promise<void>>;
}

export interface PlatformPluginModule {
  manifest: PlatformPluginManifest;
  setup(
    context: PlatformPluginContext,
  ): void | Disposable | Promise<void | Disposable>;
}

export type PlatformPluginState =
  "pending" | "loading" | "active" | "failed" | "unloading" | "disposed";

export interface PlatformPluginHandle {
  readonly id: string;
  readonly scopeId: string;
  readonly state: PlatformPluginState;
  ready(): Promise<PlatformPluginState>;
  effects(): ReturnType<Fiber["getEffects"]>;
  dispose(): Promise<void>;
}

interface ScopeState {
  context: Context;
  isolatedServices: Set<string>;
  handles: Map<string, PlatformPluginHandle>;
}

// Cordis 4.0.1 declares FiberState as a const enum but does not expose a
// runtime enum object. Keep that package quirk inside this adapter and lock the
// mapping with lifecycle contract tests.
const stateNames: Record<number, PlatformPluginState> = {
  0: "pending",
  1: "loading",
  2: "active",
  3: "failed",
  4: "disposed",
  5: "unloading",
};

function requireDeclaration(
  allowed: ReadonlySet<string>,
  operation: string,
  name: string,
) {
  if (!allowed.has(name)) {
    throw new Error(`${operation} "${name}" is not declared by the plugin`);
  }
}

/**
 * Stable QuarkfanTools facade over Cordis Core. Only trusted platform adapters
 * run in this process; third-party executable code remains in an isolated
 * worker, process or container and is represented here by a trusted adapter.
 */
export class CordisPluginKernel {
  private readonly root = new Context();
  private readonly scopes = new Map<string, ScopeState>();
  private disposed = false;

  mount(scopeId: string, module: PlatformPluginModule): PlatformPluginHandle {
    if (this.disposed) throw new Error("plugin kernel is disposed");
    this.validate(module.manifest);

    const services = [
      ...(module.manifest.requires ?? []),
      ...(module.manifest.provides ?? []),
    ];
    const scope = this.getScope(scopeId, services);
    if (scope.handles.has(module.manifest.id)) {
      throw new Error(
        `plugin "${module.manifest.id}" is already mounted in scope "${scopeId}"`,
      );
    }

    const requires = new Set(module.manifest.requires ?? []);
    const provides = new Set(module.manifest.provides ?? []);
    const subscribes = new Set(module.manifest.subscribes ?? []);
    const emits = new Set(module.manifest.emits ?? []);

    const runtime = {
      name: module.manifest.id,
      inject: [...requires],
      provide: [...provides],
      apply(ctx: Context) {
        const pluginContext: PlatformPluginContext = {
          scopeId,
          get<T>(service: string) {
            requireDeclaration(requires, "service read", service);
            const value = ctx.reflect.get(service);
            if (value === undefined) {
              throw new Error(`required service "${service}" is unavailable`);
            }
            return value as T;
          },
          provide<T>(service: string, value: T) {
            requireDeclaration(provides, "service provision", service);
            return ctx.provide(service, value);
          },
          on(event, listener) {
            requireDeclaration(subscribes, "event subscription", event);
            return (ctx.on as (...args: unknown[]) => Disposable)(
              event,
              listener,
            );
          },
          emit(event, ...args) {
            requireDeclaration(emits, "event emission", event);
            (ctx.emit as (...args: unknown[]) => void)(event, ...args);
          },
          effect(setup, label = `${module.manifest.id}:effect`) {
            return ctx.effect(setup, label);
          },
        };
        return module.setup(pluginContext);
      },
    } satisfies Plugin;

    const fiber = scope.context.plugin(runtime);
    const handle: PlatformPluginHandle = {
      id: module.manifest.id,
      scopeId,
      get state() {
        return stateNames[fiber.state];
      },
      ready: async () => {
        await fiber;
        return stateNames[fiber.state];
      },
      effects: () => fiber.getEffects(),
      dispose: async () => {
        await fiber.dispose();
        scope.handles.delete(module.manifest.id);
      },
    };
    scope.handles.set(module.manifest.id, handle);
    return handle;
  }

  async disposeScope(scopeId: string): Promise<void> {
    const scope = this.scopes.get(scopeId);
    if (!scope) return;
    const failures: unknown[] = [];
    for (const handle of [...scope.handles.values()].reverse()) {
      try {
        await handle.dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    this.scopes.delete(scopeId);
    if (failures.length) {
      throw new AggregateError(
        failures,
        `failed to dispose plugin scope "${scopeId}"`,
      );
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.root.fiber.dispose();
    this.scopes.clear();
  }

  private getScope(scopeId: string, services: string[]): ScopeState {
    let scope = this.scopes.get(scopeId);
    if (!scope) {
      scope = {
        context: this.root.extend({ platformScopeId: scopeId }),
        isolatedServices: new Set(),
        handles: new Map(),
      };
      this.scopes.set(scopeId, scope);
    }

    for (const service of services) {
      if (scope.isolatedServices.has(service)) continue;
      scope.context = scope.context.isolate(service);
      scope.isolatedServices.add(service);
    }
    return scope;
  }

  private validate(manifest: PlatformPluginManifest) {
    if (!manifest.id.trim()) throw new Error("plugin id is required");
    if (!manifest.version.trim()) throw new Error("plugin version is required");
    if (!manifest.trust)
      throw new Error("plugin trust classification is required");

    const duplicates = (values: string[] | undefined) =>
      values && new Set(values).size !== values.length;
    if (
      duplicates(manifest.requires) ||
      duplicates(manifest.provides) ||
      duplicates(manifest.subscribes) ||
      duplicates(manifest.emits)
    ) {
      throw new Error(`plugin "${manifest.id}" has duplicate declarations`);
    }
  }
}
