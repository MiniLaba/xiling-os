# XiLing AI Native Virtual OS repository rules

The active product is the AI Native Virtual OS defined by `docs/ai-native-os/PRODUCT_SPEC.md`. `apps/desktop` is its current native host path, not the product definition.

- Treat `apps/web`, `apps/server`, and every `frozenLegacyPaths` entry as read-only reference code. Do not edit or import them unless the user explicitly requests a legacy change or a reviewed port.
- User → App and User → Main → App are equal entry paths. App = Persistent Agent; fixed App UI and task-generated UI are both valid. All callers use the same application logic. System utilities need not instantiate an Agent.
- Agent is a general persistent runtime identity, not a preset profession. Keep Agent, Session, Context, Memory, Workspace, Task, Plugin, Artifact, A2A, and Generative UI semantically distinct.
- Keep one Electron `BrowserWindow`; “multi-window” means windows inside the XiLing desktop.
- Keep the real-folder workspace, narrow preload, capability gateway, event-backed state, lazy resources, and container-free native control plane.
- Do not add Docker or WSL requirements. Do not execute generated code until a platform sandbox has passed its security gate.
- Update `DESIGN.md`, `docs/ai-native-os/DELIVERY_PLAN.md`, and relevant ADRs with architectural changes.
- Run `pnpm boundary` before tests. GitHub work must use a `codex/` feature branch and PR, never direct updates to the main branch.
