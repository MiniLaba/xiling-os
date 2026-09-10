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
    id: "system.workspace",
    name: "工作台",
    version: "1.0.0",
    entry: "builtin://workspace",
    capabilities: ["workspace.read", "workspace.write", "artifact.read"],
    builtIn: true,
  },
  // 曾经的 system.files（"文件"）已移除：它没有窗口运行时 key，也没有 icon，
  // 因此既打不开也没有程序坞入口——一个不存在的应用不该在注册表里声明能力。
  // 真实文件夹浏览由 system.workspace（工作台）承担，它持有 workspace.read/write。
  {
    id: "system.tasks",
    name: "任务中心",
    version: "1.0.0",
    entry: "builtin://tasks",
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
  // system.literature（文献工作台）由标准插件清单注册：见 src/plugins/literature-workbench.ts
  // 科研主界面窗口：项目 / Wiki / 科研画布。它们各自从程序坞打开，作用域按窗口绑定。
  {
    id: "system.project",
    name: "项目",
    version: "1.0.0",
    entry: "builtin://project",
    capabilities: ["workspace.read", "artifact.read", "artifact.write"],
    builtIn: true,
    icon: "xiling-project",
    eyebrow: "科研项目",
    description: "项目事项看板：任务、里程碑与实验",
  },
  {
    id: "system.wiki",
    name: "Wiki",
    version: "1.0.0",
    entry: "builtin://wiki",
    capabilities: ["workspace.read", "artifact.read"],
    builtIn: true,
    icon: "xiling-wiki",
    eyebrow: "科研知识",
    description: "项目 Wiki：阅读、引用与版本历史",
  },
  {
    id: "system.canvas",
    name: "科研画布",
    version: "1.0.0",
    entry: "builtin://canvas",
    capabilities: ["workspace.read", "artifact.read"],
    builtIn: true,
    icon: "xiling-canvas",
    eyebrow: "科研关系",
    description: "科研图谱：来源、证据与结论版本的关系",
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
    ...(typeof manifest.icon === "string" && manifest.icon ? { icon: manifest.icon } : {}),
    ...(typeof manifest.eyebrow === "string" && manifest.eyebrow ? { eyebrow: manifest.eyebrow } : {}),
    ...(typeof manifest.description === "string" && manifest.description ? { description: manifest.description } : {}),
  };
}

export function assertCapability(manifest: AppManifest, capability: AppCapability): void {
  if (!manifest.capabilities.includes(capability)) {
    throw new Error(`${manifest.id} is not allowed to use ${capability}`);
  }
}
