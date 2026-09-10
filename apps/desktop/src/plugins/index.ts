// 内置插件注册表（指南 §34 的 plugins/ 层，桌面内置形态）：
// AgentPluginManifest 是标准插件接口；桌面核心从 ui 段派生 AppManifest
// （dock 图标 / 窗口规格），OS 内核从 provides/permissions 派生能力目录。

import { validateManifest } from "../core/app-registry.js";
import type { AppCapability, AppManifest } from "../core/types.js";
import type { AgentPluginManifest, PluginUIComponentDescriptor } from "@xiling/os-domain";
import { LITERATURE_WORKBENCH_APP_ID, literatureWorkbenchPlugin } from "./literature-workbench.js";

export const BUILT_IN_PLUGINS: readonly AgentPluginManifest[] = [literatureWorkbenchPlugin];

/** 插件 APP 运行时的核心侧配置（能力映射到桌面 AppCapability 枚举） */
const PLUGIN_APP_CORE: Record<string, { entry: string; capabilities: readonly AppCapability[] }> = {
  [LITERATURE_WORKBENCH_APP_ID]: {
    entry: "builtin://literature",
    capabilities: ["workspace.read", "artifact.read", "artifact.write", "network.access"],
  },
};

export function findWindowDescriptor(plugin: AgentPluginManifest): PluginUIComponentDescriptor | undefined {
  return (plugin.ui ?? []).find((component) => component.kind === "window" && component.appId !== undefined);
}

/**
 * 从标准插件清单派生桌面 AppManifest：
 * 名称/图标/题眉/描述/窗口规格来自清单（单一天然来源），entry/能力由核心侧补齐。
 * id 不一致的插件与 APP 视为配置错误，直接抛出。
 */
export function appManifestFromPlugin(plugin: AgentPluginManifest): AppManifest {
  const descriptor = findWindowDescriptor(plugin);
  if (!descriptor?.appId) throw new Error(`plugin ${plugin.id} declares no desktop window app`);
  const core = PLUGIN_APP_CORE[descriptor.appId];
  if (!core) throw new Error(`plugin ${plugin.id} app ${descriptor.appId} has no desktop core mapping`);
  const appKey = descriptor.appId.replace(/^system\./, "");
  void appKey;
  return validateManifest({
    id: descriptor.appId,
    name: descriptor.title ?? plugin.id,
    version: plugin.version,
    entry: core.entry,
    capabilities: [...core.capabilities],
    builtIn: true,
    icon: descriptor.icon,
    eyebrow: descriptor.eyebrow,
    description: descriptor.description,
  });
}

export const PLUGIN_APPS: readonly AppManifest[] = BUILT_IN_PLUGINS.map(appManifestFromPlugin);
