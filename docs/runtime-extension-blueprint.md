# Runtime Extensibility Blueprint

## 1. Purpose

Runtime Center must support multiple present and future execution engines without encoding their names into Bot, session or execution contracts. Existing `model-tool-loop`, OpenAI Agents and Claude Code paths become provider implementations, not union members in the domain model.

This blueprint is the executable migration target. It is informed by the source-level DeepSeek Harness evaluation recorded in the parent repository, while preserving QuarkfanTools center boundaries.

## 2. Current constraints to remove

- `RuntimeKind` is a closed string union.
- `AgentRuntime` only exposes `kind` and `run`, with no probe, capability negotiation, resume, cancel or disposal contract.
- Runtime adapters independently convert CR capabilities into tools.
- `RuntimeSession.messages` is mutable and truncated to the latest 100 entries.
- Execution events describe an attempt but cannot reconstruct all model-visible input across a session.

These are compatibility surfaces, not the target architecture.

## 3. Target modules

```text
src/
  providers/           # provider registry, descriptors and lifecycle
  profiles/            # declarative profile resolution and snapshots
  sessions/            # session aggregate and event ledger
  projections/         # model history, transcript, status and usage
  execution/           # admission, state machine and cancellation
  capabilities/        # single governed capability pipeline
  workspaces/          # allocations and isolation adapters
  compatibility/       # current Bot/runtime migration wrappers
```

Runtime uses an internal plugin kernel to compose these modules. The selected incubation implementation is DeepSeek's Cordis Core behind the QuarkfanTools Plugin SDK; see `docs/cordis-adoption.md`. Cordis types and contexts do not enter public DTOs or cross-center calls.

## 4. Runtime Provider contract

```ts
interface RuntimeProviderDescriptor {
  providerId: string;
  version: string;
  contractVersion: string;
  isolation: "in-process" | "worker" | "process" | "container" | "remote";
  capabilities: {
    streaming: boolean;
    toolCalling: boolean;
    structuredOutput: boolean;
    continuation: boolean;
    cancellation: boolean;
    fork: boolean;
    externalSessionImport: boolean;
  };
}

interface RuntimeProvider {
  describe(): RuntimeProviderDescriptor;
  probe(ctx: ProviderProbeContext): Promise<ProviderProbe>;
  start(request: RuntimeStartRequest): AsyncIterable<RuntimeProviderEvent>;
  resume?(request: RuntimeResumeRequest): AsyncIterable<RuntimeProviderEvent>;
  cancel?(request: RuntimeCancelRequest): Promise<void>;
  dispose(): Promise<void>;
}
```

The registry indexes `providerId + version`, supports multiple active versions during canary/drain, and rejects incompatible contract versions. Provider events are normalized before entering the ledger. Raw provider payloads are diagnostic resources, not public contracts.

## 5. Runtime Profile admission

Bot definitions reference a `runtimeProfileId`, not a runtime name. Admission resolves an immutable profile snapshot containing exact provider, model policy, context policy, capability binding set, governance policy, workspace policy and limits.

Admission fails before workspace allocation when:

- the provider is unavailable or incompatible;
- a requested profile feature is unsupported;
- required bindings or credential references are unresolved;
- governance denies the execution;
- capacity cannot be reserved.

Fallback to another runtime provider is a visible profile policy and emits a resolution event. It must never happen inside an adapter without audit.

## 6. Session Event Ledger

The ledger is append-only per session and uses contiguous sequence numbers plus optimistic revision checks. It stores versioned events and immutable references. `Execution` remains an operational attempt linked to a range of session events.

Minimum persistence behavior:

- append batches atomically;
- idempotency by event or request key;
- explicit `flush` before reporting durable completion;
- distinguish unsupported schema version from corruption;
- repair only safely recognizable partial writes;
- retain failed write-behind batches for retry;
- checkpoint projections without replacing source events;
- archive or redact under Governance/Resource retention policy.

Model history is a projection. Anything supplied to a provider as model-visible context must have a corresponding event or immutable cited resource. The mutable 100-message array is removed after dual-write equivalence passes.

## 7. Capability execution pipeline

All runtime providers receive one `CapabilityFacade`. They never call CR providers or Governance directly.

```text
resolve snapshot
  -> visibility filter
  -> input validation
  -> governance decision / approval
  -> concurrency and quota guard
  -> provider dispatch
  -> output normalization / resource materialization
  -> redaction and post-policy
  -> ledger event
```

The facade produces both the model-facing schemas and executable handles from the same `CapabilityResolutionSnapshot`. A handle is valid only for the admitted execution/profile revision. Exclusive capabilities serialize per declared key; parallel calls may execute concurrently but results are committed in original call order.

## 8. Lifecycle and isolation

Provider lifecycle states are `installed`, `verified`, `canary`, `active`, `draining`, `disabled`, `failed` and `retired`.

- Installation verifies manifest, contract version, license/SBOM policy and configuration schema.
- Canary sends only explicitly selected profiles or traffic percentage.
- Drain rejects new executions but lets owned work reach a bounded quiescent state.
- Rollback selects the previous verified provider/profile revision.
- Dispose awaits child processes, listeners, workspaces and write buffers; it does not merely signal cancellation.
- Native or untrusted providers run in a worker, process or container according to Governance policy.

Cordis service scopes provide logical composition isolation only. They do not grant filesystem, process, network or secret isolation. In-process mounting is restricted to reviewed built-ins; isolated plugins are represented by trusted RPC adapters.

## 9. Continuation and sub-runtime work

Runtime owns one execution/continuation state machine. A provider may supply creation or resume mechanics, but it does not create a second scheduler. Child executions have explicit parent lineage, depth limits, capability/profile restrictions and durable settlement events. Background work returns through the same admission and event paths as foreground work.

## 10. Management APIs

Required management surfaces:

- `GET /runtime-providers`
- `GET /runtime-providers/:id`
- `POST /runtime-providers/:id/probe`
- `POST /runtime-providers/:id/canary|activate|drain|rollback`
- CRUD for Runtime Profiles with dependency protection
- `GET /sessions/:id/events` with cursor pagination
- `GET /sessions/:id/projections/:name`
- `POST /sessions/:id/migrate-profile` with dry-run
- execution status, cancel, retry, logs and diagnostic resource references

Dashboard follows list/detail pages. Advanced settings expose provider capability matrices, profile revisions, rollout state and session migration preview without mixing runtime records into configuration forms.

## 11. Verification

Every runtime provider runs the same contract suite:

- descriptor and capability negotiation;
- stream normalization and terminal outcome uniqueness;
- cancellation and disposal quiescence;
- tool visibility/execution consistency;
- unsupported feature rejection;
- retry/idempotency and continuation;
- malformed output and provider disconnect;
- profile upgrade, canary, drain and rollback.

Ledger verification adds property tests for sequence/order, crash/failure injection, replay equivalence, projection checkpoints, unsupported versions and concurrent append ownership.

## 12. Migration increments

1. Introduce contracts, provider registry and wrappers for all current adapters.
2. Add profiles and migrate Bot references while retaining compatibility reads.
3. Add ledger dual-write and shadow projections.
4. Route all tool schema/execution through the common facade.
5. Switch reads to projections, import legacy sessions and remove truncation.
6. Add canary/drain/rollback APIs and Dashboard views.

No big-bang data migration is required, but each increment must be reversible and independently deployable.
