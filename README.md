# Runtime Center

Execution plane for QuarkfanTools 3.0. Runtime engines are mounted as versioned Provider plugins through the exact-pinned Cordis-backed PluginKernel. Every execution resolves an immutable Runtime Profile snapshot, context and capability visibility, obtains a governance decision, allocates a workspace and appends operational plus session-ledger events.

The current production architecture replaces the startup adapter map with versioned Runtime Providers, declarative Runtime Profiles, a Session Event Ledger and a shared Capability Facade. Existing Bot runtime strings remain a compatibility input. Cordis is an internal composition kernel, not a security sandbox, and never crosses center boundaries.

Design entry points:

- `docs/runtime-extension-blueprint.md`
- `docs/cordis-adoption.md`
