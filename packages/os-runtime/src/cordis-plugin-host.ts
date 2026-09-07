import { Context } from "@deepseek-ai/cordis";
import type { Fiber, Plugin } from "@deepseek-ai/cordis";
import type { AgentPluginManifest } from "@xiling/os-domain";
import type { PluginLifecycleHost } from "./plugin-lifecycle.js";

export interface LoadedCordisPlugin {
  plugin: Plugin;
  config?: unknown;
}

/**
 * Cordis 生命周期桥。模块解析/签名校验由调用方 loader 负责；本类不会根据 manifest
 * 中的字符串直接 import 任意代码，避免把安装动作变成隐式代码执行。
 */
export class CordisPluginLifecycleHost implements PluginLifecycleHost {
  private readonly context = new Context();
  private readonly prepared = new Map<string, LoadedCordisPlugin>();
  private readonly active = new Map<string, { version: string; fiber: Fiber }>();

  constructor(private readonly loader: (manifest: AgentPluginManifest) => Promise<LoadedCordisPlugin>) {}

  async prepare(manifest: AgentPluginManifest): Promise<void> {
    const loaded = await this.loader(manifest);
    if (loaded === null || typeof loaded !== "object" || loaded.plugin === undefined) {
      throw new Error(`plugin loader returned no Cordis plugin for ${manifest.id}@${manifest.version}`);
    }
    this.prepared.set(key(manifest), loaded);
  }

  async activate(manifest: AgentPluginManifest): Promise<void> {
    const existing = this.active.get(manifest.id);
    if (existing?.version === manifest.version) return;
    if (existing !== undefined) throw new Error(`plugin ${manifest.id}@${existing.version} is still active`);
    const loaded = this.prepared.get(key(manifest));
    if (loaded === undefined) throw new Error(`plugin ${manifest.id}@${manifest.version} was not prepared`);
    const pending = this.context.plugin(loaded.plugin, loaded.config);
    try {
      await pending;
    } catch (error) {
      await pending.dispose();
      throw error;
    }
    this.active.set(manifest.id, { version: manifest.version, fiber: pending });
  }

  async deactivate(pluginId: string): Promise<void> {
    const existing = this.active.get(pluginId);
    if (existing === undefined) return;
    await existing.fiber.dispose();
    this.active.delete(pluginId);
  }

  async remove(pluginId: string): Promise<void> {
    await this.deactivate(pluginId);
    for (const preparedKey of [...this.prepared.keys()]) {
      if (preparedKey.startsWith(`${pluginId}@`)) this.prepared.delete(preparedKey);
    }
  }

  isActive(pluginId: string): boolean {
    return this.active.has(pluginId);
  }

  async shutdown(): Promise<void> {
    for (const pluginId of [...this.active.keys()]) await this.deactivate(pluginId);
  }
}

function key(manifest: AgentPluginManifest): string {
  return `${manifest.id}@${manifest.version}`;
}
