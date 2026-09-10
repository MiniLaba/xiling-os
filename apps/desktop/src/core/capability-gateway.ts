import { assertCapability } from "./app-registry.js";
import { SystemStore } from "./system-store.js";
import type { AppCapability, AppManifest } from "./types.js";

const SAFE_BUILT_IN_DEFAULTS = new Set<AppCapability>([
  "workspace.read",
  "workspace.write",
  "artifact.read",
  "artifact.write",
]);

export class CapabilityGateway {
  constructor(private readonly store: SystemStore) {}

  authorize(appId: string, capability: AppCapability): AppManifest {
    const manifest = this.store.listApps().find((app) => app.id === appId);
    if (!manifest) throw new Error("Unknown application");
    assertCapability(manifest, capability);

    const decision = this.store.getPermission(appId, capability);
    if (decision === "deny") throw new Error(`${capability} was denied for ${appId}`);
    if (decision === "allow") return manifest;
    if (manifest.builtIn && SAFE_BUILT_IN_DEFAULTS.has(capability)) return manifest;
    throw new Error(`${capability} requires an explicit permission decision`);
  }

  decide(appId: string, capability: AppCapability, decision: "allow" | "deny"): void {
    const manifest = this.store.listApps().find((app) => app.id === appId);
    if (!manifest) throw new Error("Unknown application");
    assertCapability(manifest, capability);
    this.store.setPermission(appId, capability, decision);
  }
}
