# Runtime Center collaboration

Independent Runtime Center repository. It owns execution, runtime adapters, sessions, workspaces and runtime events. It does not own channel routing, model-provider policy, capability discovery, context authorization, resource deletion or governance policy. Dean makes final decisions; Codex must proactively recommend improvements.

Runtime extension work must read `docs/runtime-extension-blueprint.md` and `docs/cordis-adoption.md`. Platform plugins compile against QuarkfanTools contracts and the PluginKernel facade, not Cordis directly. Cordis scope is logical dependency isolation, never a tenant security sandbox; untrusted code belongs in a worker, process or container.
