# Cordis Adoption Decision

Status: recommended for controlled adoption; the first isolated kernel adapter and contract tests are implemented, but no production execution path has switched yet.

## Decision summary

Adopt `@deepseek-ai/cordis` Core as the internal composition kernel of Runtime Center, pinned to an exact reviewed version and hidden behind the QuarkfanTools Plugin SDK. Do not adopt the Cordis loader/HMR path in production initially. Do not run third-party code in the Runtime service process. Treat the complete DeepSeek Harness as a future optional Runtime Provider running in an isolated process or container.

This gives QuarkfanTools real plugin lifecycle, scoped dependency injection and reversible composition without letting an upstream framework define cross-center contracts.

## Why it fits

| Dimension | Assessment | Notes |
| --- | --- | --- |
| Dependency injection and extension composition | Strong | Providers and consumers can declare services; missing dependencies keep consumers pending. |
| Lifecycle ownership | Strong | Fibers own effects, listeners and services; async disposal is awaited in reverse order. |
| Logical scope isolation | Strong | Service labels isolate profile/Bot/session compositions in one process. |
| Dynamic reconfiguration | Promising | Fiber update, loader and rollback mechanics exist, but production rollout should use profile canary/drain first. |
| Test and defensive discipline | Strong | DeepSeek Harness carries 821 test/spec/e2e files and extensive lifecycle, replay and invariant gates. |
| Package size | Strong | Core 4.0.1 is 32 files and about 239 KB unpacked with two direct runtime dependencies. |
| Security isolation | Insufficient alone | Cordis scope is dependency isolation, not a sandbox. Plugin code retains ambient Node authority. |
| Distributed-center fit | Partial | It is an in-process framework; Platform Contracts and RPC remain the only cross-center boundary. |
| API stability | Weak today | Both DeepSeek Harness and upstream Cordis warn that compatibility-breaking changes may occur. |
| Supply-chain traceability | Mixed | MIT, npm integrity/signature, verified pack/install release workflow and two maintainers; no public GitHub tags/releases, no package `gitHead`/provenance attestation, and the repository only became public on 2026-08-13. |

The DeepSeek organization and engineering quality are positive trust signals. The repository history reports many contributors and thousands of commits, so this is not a three-day implementation; however, the public release and ecosystem are only days old. Organizational trust justifies an incubation dependency, not an unbounded upgrade policy.

## Why use DeepSeek's package

The inspected `@deepseek-ai/cordis 4.0.1` is the exact implementation exercised by DeepSeek Harness. Compared with the same-date upstream Cordis `4.0.0-rc.8`, DeepSeek's vendored core changes all nine source files with roughly 984 additions and 139 removals, including stronger effect disposal, dispatch containment, diagnostics and documentation. Mixing the official and rescoped package families would create two context brands and incompatible peer ecosystems, so Runtime will use only the DeepSeek-scoped family.

## Integration boundary

Application and plugin code imports QuarkfanTools contracts, not Cordis directly:

```text
Platform plugin
  -> @quarkfantools/plugin-sdk
  -> PluginKernel port
  -> CordisPluginKernel adapter
  -> @deepseek-ai/cordis (exact pin)
```

`PluginKernel` owns mount, declared service/event access, scope creation, status, effect diagnostics and asynchronous disposal. This keeps replacement possible and prevents Cordis-specific types from leaking into Bot, profile, session, event or cross-center DTOs.

Mount is asynchronous in meaning even when it returns a handle immediately. Callers must await `handle.ready()` and inspect the stable state before canary traffic or teardown; a provider waiting for dependencies may legitimately remain `pending`.

The initial adapter is `src/plugin-kernel.ts`. Its tests prove:

- services are isolated between Bot/profile scopes;
- consumers wait when dependencies are missing and unload when providers disappear;
- async cleanup is awaited and listeners are lifecycle-owned;
- undeclared service access fails inside the stable facade.
- a scope disposes plugins sequentially in reverse mount order.

The spike also found a real package edge: `FiberState` is declared as a `const enum` but has no runtime export. The adapter contains and tests the numeric mapping. This is exactly why direct imports from business code are prohibited.

## Trust and isolation classes

| Class | Where code runs | Cordis role |
| --- | --- | --- |
| Built-in reviewed plugin | Runtime/worker process | May run directly in a scoped context. |
| Signed Quarkfan plugin | Dedicated worker or process by policy | Trusted host adapter is mounted; executable code stays isolated. |
| Third-party or user plugin | Container/process with sandbox and resource limits | Only an RPC proxy/facade is mounted. |
| Cross-center provider | Owning center over authenticated RPC | Cordis mounts a typed client adapter, never the remote implementation. |

No Cordis context, service object or event bus crosses HTTP/RPC. No Cordis isolation label is accepted as a tenant security boundary.

## Production rules

1. Pin exact versions in `package.json` and lockfile; no caret range.
2. Upgrade only through an explicit PR with source diff, license/SBOM review, package integrity check and the full PluginKernel contract suite.
3. Canary a new kernel/provider version in a separate Runtime worker or profile revision, then drain the old version.
4. Keep the previous package tarball and compatible container image for rollback.
5. Do not enable arbitrary loader paths, npm install at runtime or production HMR.
6. Plugin manifests declare services, events, configuration schema, trust class and isolation requirement.
7. Dispose must reach quiescence; timeout becomes a visible failed-drain state and the worker is terminated by its owner.
8. Cordis events are process-local extension points. Durable facts still append to the Session Event Ledger.

## Full DeepSeek Harness option

The complete harness should be evaluated as a `deepseek-harness` Runtime Provider after Runtime Provider contracts stabilize. It would run in a process/container and communicate through a versioned adapter, exposing only negotiated capabilities such as continuation, tools, session import/export and streaming. This path can reuse its agent loop, session engine and plugin ecosystem without making its 219-package graph the QuarkfanTools platform core.

## Promotion gates

Cordis Core may move from incubation to production composition when:

- current adapters run through PluginKernel wrappers with no behavior regression;
- provider/profile and Session Event Ledger contracts are implemented;
- fault tests cover failed setup, dependency churn, hanging disposal, reentrant disposal and worker crash;
- upgrade and rollback are proven between two reviewed Cordis versions or patched builds;
- production diagnostics expose plugin scope, state and effect tree;
- a security test proves untrusted packages cannot enter the in-process trust class.

Until these gates pass, the dependency and adapter remain present but production execution continues through the existing adapter map.
