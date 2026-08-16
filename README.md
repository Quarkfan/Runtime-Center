# Runtime Center

Execution plane for QuarkfanTools 3.0. Initial adapters are direct Model Hub tool-loop and externally configured Claude/OpenAI agent runtimes. Every execution resolves context and capabilities, obtains a governance decision, allocates a workspace and emits durable events.

The next architecture replaces hard-coded runtime kinds with versioned Runtime Providers, declarative Runtime Profiles, a Session Event Ledger and one governed capability pipeline. DeepSeek's Cordis Core is being adopted behind a QuarkfanTools Plugin SDK as the internal composition kernel; it is not a security sandbox and does not cross center boundaries.

Design entry points:

- `docs/runtime-extension-blueprint.md`
- `docs/cordis-adoption.md`
