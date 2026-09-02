import type { AppCapability, AppManifest } from "./types.js";

const CAPABILITIES = new Set<AppCapability>([
  "workspace.read",
  "workspace.write",
  "artifact.read",
  "artifact.write",
  "agent.invoke",
  "network.access",
]);

export const BUILT_IN_APPS: readonly AppManifest[] = [
  {
    id: "system.files",
    name: "文件",
    version: "1.0.0",
    entry: "builtin://files",
    capabilities: ["workspace.read", "workspace.write"],
    builtIn: true,
  },
  {
    id: "system.research",
    name: "科研工作台",
    version: "1.0.0",
    entry: "builtin://research",
    capabilities: ["workspace.read", "artifact.read", "artifact.write", "agent.invoke"],
    builtIn: true,
  },
  {
    id: "system.chat",
    name: "对话",
    version: "1.0.0",
    entry: "builtin://chat",
    capabilities: ["workspace.read", "artifact.read", "artifact.write", "agent.invoke"],
    builtIn: true,
  },
  {
    id: "system.literature",
    name: "文献",
    version: "1.0.0",
    entry: "builtin://literature",
    capabilities: ["workspace.read", "artifact.read", "artifact.write", "network.access"],
    builtIn: true,
  },
  {
    id: "system.data",
    name: "数据",
    version: "1.0.0",
    entry: "builtin://data",
    capabilities: ["workspace.read", "workspace.write", "artifact.read", "artifact.write", "network.access"],
    builtIn: true,
  },
  {
    id: "system.settings",
    name: "设置",
    version: "1.0.0",
    entry: "builtin://settings",
    capabilities: [],
    builtIn: true,
  },
];

export function validateManifest(value: unknown): AppManifest {
  if (!value || typeof value !== "object") throw new Error("App manifest must be an object");
  const manifest = value as Partial<AppManifest>;
  if (!manifest.id?.match(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/)) throw new Error("Invalid app id");
  if (!manifest.name?.trim()) throw new Error("App name is required");
  if (!manifest.version?.match(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)) {
    throw new Error("App version must be semantic");
  }
  if (!manifest.entry?.startsWith("builtin://")) {
    throw new Error("Only built-in declarative entries are enabled before sandbox support");
  }
  if (!Array.isArray(manifest.capabilities)) throw new Error("Capabilities must be an array");
  for (const capability of manifest.capabilities) {
    if (!CAPABILITIES.has(capability)) throw new Error(`Unknown capability: ${String(capability)}`);
  }
  return {
    id: manifest.id,
    name: manifest.name.trim(),
    version: manifest.version,
    entry: manifest.entry,
    capabilities: [...new Set(manifest.capabilities)],
    builtIn: manifest.builtIn === true,
  };
}

export function assertCapability(manifest: AppManifest, capability: AppCapability): void {
  if (!manifest.capabilities.includes(capability)) {
    throw new Error(`${manifest.id} is not allowed to use ${capability}`);
  }
}
