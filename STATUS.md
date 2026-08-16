# Runtime Center Status

Version `0.1.0` is deployed. Bot/session/workspace isolation, durable executions/events, model-tool-loop, OpenAI Agents, externally configured Claude runtime, workflows and governed capability calls are implemented. Bot definitions support explicit detail/update/delete APIs; the system assistant is protected and the Dashboard blocks deletion while a channel still references the Bot. Browser Worker supports deterministic Playwright and Model Hub-planned agent tasks, encrypted sessions, external-auth waiting, approvals and evidence. Explicit session deletion removes its encrypted persisted state. Private networks are blocked by default. Both processes require a strong internal token; browser state requires a base64 key that decodes to exactly 32 bytes.

## Extensibility redesign

The Runtime Provider, Runtime Profile, Session Event Ledger and governed capability pipeline blueprint is documented in `docs/runtime-extension-blueprint.md`. `@deepseek-ai/cordis` is exact-pinned at `4.0.1`; the production path now mounts all three built-in runtimes through `CordisPluginKernel` and `RuntimeProviderRegistry`. Provider lifecycle and Profile revisions are persisted, execution admission stores an immutable snapshot, legacy Bots receive compatibility Profiles, and session events are dual-written to an append-only ledger. Model Tool Loop and OpenAI Agents share one Capability Facade. Claude read-only executions no longer receive write/edit/shell tools.

The module now passes 35 tests, typecheck and production build. Management APIs cover Provider list/detail/probe/lifecycle/logs, Runtime Profile CRUD and Session Ledger cursor reads.

The full DeepSeek Harness remains a candidate isolated Runtime Provider, not a replacement for the platform centers.
