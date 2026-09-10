# Xi Ling OS — Research OS integration rules

The active product is Xi Ling OS, a local-first research operating system. The current integration authority is docs/research-desktop/INTEGRATION.md and DESIGN.md. The user approved reintegrating the research packages; they are no longer frozen.

- Develop only on codex/ branches. Never push to main or automatically merge a PR.
- Preserve one Electron BrowserWindow, internal windows, real-folder access, narrow IPC and lazy resource lifetimes.
- Research apps are callable domain services, not necessarily persistent Agents. Do not create a resident Agent for each view.
- Core domain/kernel must not import desktop UI, HTTP frameworks or science-specific packages. Science modules cannot import Electron or React.
- There must ultimately be one authority for each task/session/artifact/approval. Existing parallel paths are integration debt, not completed unification.
- Keep Agent execution graphs, Research Graph and literature discovery graphs distinct.
- Research Graph owns typed scientific relationships, not every tool event. All promoted claims require source/version references.
- Project scope is explicit per window/request. Never infer ownership from a mutable global selected project.
- Pi is the ONLY research Harness executor. DSH is removed from the product: do not register it, do not fall back to it, do not reintroduce a second model engine. Audio stays an adapter, not a second backend. A missing Pi runtime must fail explicitly, never degrade to another engine.
- The research application service (apps/desktop/src/core/research-service.ts) is the single entry for projects, items, wiki, evidence and research-graph reads. Project scope is bound per internal window by ProjectScopeRegistry; a projectId sent by the renderer is never authorisation.
- Science execution goes through ScienceService (packages/os-kernel/src/science-service.ts): plan → approval keyed by the plan hash → execution record with its own id → content-addressed artifacts. No verified sandbox means the task fails with that reason; never a fixture success and never a host bare run.
- No Docker/WSL dependency for installation or desktop startup. Do not replace isolation with unrestricted host execution.
- Do not delete user databases or third-party local assets. Do not upload credentials, recordings, generated output, layout adjusters or local-only companion assets.
- Update integration checklist and DESIGN.md with actual evidence. Never mark an entire stage complete from build success alone.
- Run pnpm boundary before tests. Native and scientific end-to-end acceptance must be reported separately from fixtures.
