// PluginService：OS 持久化安装/版本/启停事实，实际 Fiber 生命周期委托给 Runtime Port。

import { correlationFor, OsError, entityNotFound, permissionDenied } from "@xiling/os-domain";
import type { AgentId, AgentPluginManifest, OSOperationContext, PluginInstallation } from "@xiling/os-domain";
import type { PluginLifecycleHost } from "@xiling/os-runtime";
import type { KernelServices } from "./kernel-services.js";
import type { OSKernel } from "./kernel.js";

export class PluginService {
  private readonly manifests = new Map<string, AgentPluginManifest>();
  private lifecycleHost?: PluginLifecycleHost | undefined;

  constructor(private readonly kernel: OSKernel, private readonly services: KernelServices) {}

  setLifecycleHost(host: PluginLifecycleHost): void {
    this.lifecycleHost = host;
  }

  /** 注册可用清单；内置插件可直接注册，受管第三方插件使用 install()。 */
  register(manifest: AgentPluginManifest): void {
    validateManifest(manifest);
    const existing = this.manifests.get(manifest.id);
    if (existing !== undefined && existing.version === manifest.version) {
      if (JSON.stringify(existing) === JSON.stringify(manifest)) return;
      throw new OsError("invalid_command", `conflicting manifest for plugin ${manifest.id}@${manifest.version}`);
    }
    this.replaceManifest(manifest);
  }

  /** 重启 hydrate 后恢复受管插件目录；不会激活任何运行时代码。 */
  restoreInstalledCatalog(): void {
    for (const installation of this.services.projection.pluginInstallations.values()) this.replaceManifest(installation.manifest);
  }

  get(pluginId: string): AgentPluginManifest {
    const manifest = this.manifests.get(pluginId) ?? this.services.projection.pluginInstallations.get(pluginId)?.manifest;
    if (!manifest) throw entityNotFound("plugin", pluginId);
    return manifest;
  }

  list(): AgentPluginManifest[] {
    return [...this.manifests.values()];
  }

  listInstallations(): PluginInstallation[] {
    return [...this.services.projection.pluginInstallations.values()].map((item) => structuredClone(item));
  }

  /** 未受管的内置清单默认可用；受管插件必须明确 enabled。 */
  isEnabled(pluginId: string): boolean {
    const installation = this.services.projection.pluginInstallations.get(pluginId);
    return installation?.state === "enabled" || installation === undefined && this.manifests.has(pluginId);
  }

  async install(manifest: AgentPluginManifest, options: { enable?: boolean; ctx?: OSOperationContext } = {}): Promise<PluginInstallation> {
    validateManifest(manifest);
    if (this.services.projection.pluginInstallations.has(manifest.id)) throw new OsError("invalid_command", `plugin ${manifest.id} is already installed`);
    this.assertDependenciesAvailable(manifest);
    await this.lifecycleHost?.prepare(manifest);
    this.replaceManifest(manifest);
    const now = new Date().toISOString();
    const installation: PluginInstallation = {
      pluginId: manifest.id,
      manifest: structuredClone(manifest),
      state: "disabled",
      history: [],
      installedAt: now,
      updatedAt: now,
    };
    this.kernel.emit("plugin.installed", { installation }, {}, options.ctx);
    if (options.enable === true) await this.enable(manifest.id, options.ctx);
    return structuredClone(this.services.projection.pluginInstallations.get(manifest.id)!);
  }

  async enable(pluginId: string, ctx?: OSOperationContext | undefined): Promise<void> {
    const installation = this.installation(pluginId);
    if (installation.state === "enabled") return;
    this.assertDependenciesEnabled(installation.manifest);
    try {
      await this.requireLifecycleHost().activate(installation.manifest);
      this.kernel.emit("plugin.enabled", { pluginId }, {}, ctx);
    } catch (error) {
      this.recordFailure(pluginId, "enable", error, ctx);
      throw error;
    }
  }

  async disable(pluginId: string, reason = "disabled by user", ctx?: OSOperationContext | undefined): Promise<void> {
    const installation = this.installation(pluginId);
    if (installation.state === "disabled") return;
    try {
      await this.requireLifecycleHost().deactivate(pluginId);
      this.kernel.emit("plugin.disabled", { pluginId, reason }, {}, ctx);
    } catch (error) {
      this.recordFailure(pluginId, "disable", error, ctx);
      throw error;
    }
  }

  async upgrade(manifest: AgentPluginManifest, ctx?: OSOperationContext | undefined): Promise<void> {
    validateManifest(manifest);
    const current = this.installation(manifest.id);
    if (current.manifest.version === manifest.version) throw new OsError("invalid_command", `plugin ${manifest.id} already uses version ${manifest.version}`);
    this.assertDependenciesAvailable(manifest);
    const host = this.lifecycleHost;
    try {
      await host?.prepare(manifest);
      if (current.state === "enabled") {
        if (host === undefined) throw new OsError("runtime_not_found", "plugin lifecycle host is unavailable");
        await host.deactivate(manifest.id);
        try { await host.activate(manifest); }
        catch (error) { await host.activate(current.manifest); throw error; }
      }
      const fromVersion = current.manifest.version;
      this.replaceManifest(manifest);
      this.kernel.emit("plugin.upgraded", { pluginId: manifest.id, fromVersion, manifest: structuredClone(manifest) }, {}, ctx);
    } catch (error) {
      this.recordFailure(manifest.id, "upgrade", error, ctx);
      throw error;
    }
  }

  async rollback(pluginId: string, ctx?: OSOperationContext | undefined): Promise<void> {
    const current = this.installation(pluginId);
    const target = current.history.at(-1);
    if (target === undefined) throw new OsError("invalid_command", `plugin ${pluginId} has no rollback version`);
    const host = this.lifecycleHost;
    try {
      await host?.prepare(target);
      if (current.state === "enabled") {
        if (host === undefined) throw new OsError("runtime_not_found", "plugin lifecycle host is unavailable");
        await host.deactivate(pluginId);
        try { await host.activate(target); }
        catch (error) { await host.activate(current.manifest); throw error; }
      }
      const fromVersion = current.manifest.version;
      this.replaceManifest(target);
      this.kernel.emit("plugin.rolled_back", { pluginId, fromVersion, manifest: structuredClone(target) }, {}, ctx);
    } catch (error) {
      this.recordFailure(pluginId, "rollback", error, ctx);
      throw error;
    }
  }

  async remove(pluginId: string, ctx?: OSOperationContext | undefined): Promise<void> {
    this.installation(pluginId);
    const bound = this.services.agents.list().some((agent) => agent.pluginBindings.some((binding) => binding.pluginId === pluginId));
    if (bound) throw new OsError("invalid_command", `plugin ${pluginId} is still bound to an agent`);
    await this.lifecycleHost?.remove(pluginId);
    const previous = this.get(pluginId);
    this.manifests.delete(pluginId);
    for (const provided of previous.provides) this.services.capabilities.unregister(provided.action);
    this.kernel.emit("plugin.removed", { pluginId }, {}, ctx);
  }

  async bindToAgent(agentId: AgentId, pluginId: string, ctx?: OSOperationContext | undefined): Promise<void> {
    const manifest = this.get(pluginId);
    if (!this.isEnabled(pluginId)) throw new OsError("invalid_command", `plugin ${pluginId} is disabled`);
    const definition = this.services.agents.get(agentId);
    for (const requested of manifest.permissions ?? []) {
      const allowed = definition.permissionPolicy.allowedActions.some(
        (owned) => owned === requested || owned.endsWith(":*") && requested.startsWith(owned.slice(0, -2)),
      );
      if (!allowed) throw permissionDenied(`agent ${agentId} policy does not allow plugin ${pluginId} permission "${requested}"`);
    }
    if (manifest.memory?.write === true && definition.memoryPolicy.readOnly === true) {
      throw permissionDenied(`agent ${agentId} memory is read-only; plugin ${pluginId} requests memory.write`);
    }
    for (const required of manifest.requires ?? []) {
      if (!this.manifests.has(required)) throw entityNotFound("plugin", required);
      if (!this.isEnabled(required)) throw new OsError("invalid_command", `required plugin ${required} is disabled`);
    }
    await this.services.agents.bindPlugin(agentId, pluginId, manifest.version, ctx);
  }

  async unbindFromAgent(agentId: AgentId, pluginId: string, ctx?: OSOperationContext | undefined): Promise<void> {
    const definition = this.services.agents.get(agentId);
    if (!definition.pluginBindings.some((binding) => binding.pluginId === pluginId)) throw entityNotFound("plugin binding", `${agentId}/${pluginId}`);
    this.kernel.emit("agent.plugin_unbound", { agentId, pluginId }, correlationFor({ agentId }), ctx);
  }

  private installation(pluginId: string): PluginInstallation {
    const installation = this.services.projection.pluginInstallations.get(pluginId);
    if (!installation) throw entityNotFound("plugin installation", pluginId);
    return installation;
  }

  private replaceManifest(manifest: AgentPluginManifest): void {
    const previous = this.manifests.get(manifest.id);
    if (previous !== undefined) for (const provided of previous.provides) this.services.capabilities.unregister(provided.action);
    this.manifests.set(manifest.id, structuredClone(manifest));
    for (const provided of manifest.provides) this.services.capabilities.register(provided.action, { action: provided.action, description: provided.description });
  }

  private assertDependenciesAvailable(manifest: AgentPluginManifest): void {
    for (const required of manifest.requires ?? []) {
      if (!this.manifests.has(required) && !this.services.projection.pluginInstallations.has(required)) throw entityNotFound("plugin", required);
    }
  }

  private assertDependenciesEnabled(manifest: AgentPluginManifest): void {
    for (const required of manifest.requires ?? []) {
      if (!this.isEnabled(required)) throw new OsError("invalid_command", `required plugin ${required} is disabled`);
    }
  }

  private requireLifecycleHost(): PluginLifecycleHost {
    if (this.lifecycleHost === undefined) throw new OsError("runtime_not_found", "plugin lifecycle host is unavailable");
    return this.lifecycleHost;
  }

  private recordFailure(pluginId: string, operation: string, error: unknown, ctx?: OSOperationContext | undefined): void {
    const reason = error instanceof Error ? error.message : String(error);
    this.kernel.emit("plugin.operation_failed", { pluginId, operation, reason }, {}, ctx);
  }
}

function validateManifest(manifest: AgentPluginManifest): void {
  if (manifest.id.trim() === "") throw new OsError("invalid_command", "plugin id must not be empty");
  if (manifest.version.trim() === "") throw new OsError("invalid_command", `plugin ${manifest.id} version must not be empty`);
  if (manifest.runtime.entry.trim() === "") throw new OsError("invalid_command", `plugin ${manifest.id} runtime entry must not be empty`);
  if (new Set(manifest.provides.map((item) => item.action)).size !== manifest.provides.length) {
    throw new OsError("invalid_command", `plugin ${manifest.id} declares duplicate capabilities`);
  }
}
