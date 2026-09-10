import { agentId, newId, OsError, isTerminalTaskState } from "@xiling/os-domain";
import type { AppPackage, AppInstance, AgentDefinition, OSOperationContext, SessionId, AgentId, TaskId } from "@xiling/os-domain";
import type { OSKernel } from "./kernel.js";

/** Durable local App lifecycle. Never owns a process or a second application database. */
export class AppService {
  constructor(private readonly kernel: OSKernel) {}

  install(manifest: AppPackage, approvedActions: string[], ctx: OSOperationContext): AppInstance {
    this.requireUser(ctx);
    this.validate(manifest);
    if (manifest.requestedActions.some((action) => !approvedActions.includes(action)) || approvedActions.some((action) => !manifest.requestedActions.includes(action))) {
      throw new OsError("permission_denied", "安装权限必须匹配声明，不自动提权");
    }
    const now = new Date().toISOString();
    const agent: AgentDefinition = {
      id: agentId(newId("agent")), name: manifest.name, isMainAgent: false,
      modelPolicy: structuredClone(manifest.defaultModel), pluginBindings: [],
      memoryPolicy: {}, workspacePolicy: {}, permissionPolicy: { allowedActions: [...approvedActions] },
      runtimeName: manifest.runtimeName, systemInstructions: manifest.instructions, createdAt: now, version: 1,
    };
    const instance: AppInstance = {
      id: newId("app"), agentId: agent.id, package: structuredClone(manifest), state: "enabled",
      approvedActions: [...approvedActions], installedAt: now, updatedAt: now,
    };
    this.kernel.emit("app.installed", { instance, agent }, { agentId: agent.id }, ctx);
    return this.get(instance.id);
  }

  get(id: string): AppInstance {
    const value = this.kernel.projection.apps.get(id);
    if (!value) throw new OsError("entity_not_found", `App ${id} 不存在`);
    return structuredClone(value);
  }
  list(): AppInstance[] { return [...this.kernel.projection.apps.values()].map((app) => structuredClone(app)); }
  discover(capability: string): AppInstance[] {
    return this.list().filter((app) => app.state === "enabled" && app.package.capabilities.includes(capability));
  }
  open(id: string, ctx: OSOperationContext, sessionId?: SessionId) {
    this.requireUser(ctx);
    const app = this.get(id);
    if (app.state !== "enabled") throw new OsError("illegal_transition", "App 已停用");
    if (sessionId !== undefined) {
      const session = this.kernel.sessions.get(sessionId);
      if (session.agentId !== app.agentId) throw new OsError("permission_denied", "会话不属于该 App");
      if (session.state !== "active") throw new OsError("illegal_transition", "会话已结束");
      return { app, session: structuredClone(session) };
    }
    return { app, session: this.kernel.sessions.open({ agentId: app.agentId, title: app.package.name, ctx }) };
  }
  setEnabled(id: string, enabled: boolean, ctx: OSOperationContext): AppInstance {
    this.requireUser(ctx);
    const app = this.get(id);
    if (app.state === "removed") throw new OsError("illegal_transition", "已卸载实例不可重新启用，请重新安装");
    if (!enabled && [...this.kernel.projection.tasks.values()].some((task) => task.assignedAgentId === app.agentId && !isTerminalTaskState(task.state))) {
      throw new OsError("illegal_transition", "先结束该 App 的未完成任务");
    }
    app.state = enabled ? "enabled" : "disabled";
    app.updatedAt = new Date().toISOString();
    this.kernel.emit("app.updated", { instance: app }, { agentId: app.agentId }, ctx);
    return this.get(id);
  }

  async submit(id: string, sessionId: SessionId, goal: string, ctx: OSOperationContext, artifactIds: string[] = []) {
    const { app, session } = this.open(id, ctx, sessionId);
    if (artifactIds.length > 20) throw new Error("Too many input artifacts");
    const inputArtifacts = artifactIds.map((id) => { const artifact = this.kernel.artifacts.get(id); return { artifactId: artifact.artifactId, version: artifact.version }; });
    return this.kernel.tasks.create({ goal, sessionId: session.id, inputArtifacts, ownerAgentId: app.agentId, assignedAgentId: app.agentId, ctx });
  }

  async invoke(id: string, input: { fromAgentId: AgentId; parentTaskId: TaskId; goal: string; inputArtifactIds: string[] }, ctx: OSOperationContext) {
    const app = this.get(id);
    const parent = this.kernel.tasks.get(input.parentTaskId);
    const caller = this.kernel.agents.get(input.fromAgentId);
    if (ctx.actor !== "agent" || ctx.actorAgentId !== input.fromAgentId || parent.assignedAgentId !== input.fromAgentId || parent.state !== "running" || !caller.permissionPolicy.allowedActions.includes("task.delegate")) throw new OsError("permission_denied", "无效 App 委托权限");
    if (app.state !== "enabled" || app.agentId === input.fromAgentId) throw new OsError("permission_denied", "目标 App 不可调用");
    let ancestor = parent; let depth = 0;
    while (ancestor.parentTaskId) { ancestor = this.kernel.tasks.get(ancestor.parentTaskId); if (++depth >= 3 || ancestor.assignedAgentId === app.agentId) throw new OsError("invalid_command", "拒绝循环或过深委托"); }
    if ([...this.kernel.projection.tasks.values()].filter((task) => task.parentTaskId === parent.id).length >= 8) throw new OsError("invalid_command", "当前任务的委托次数达到上限");
    const accessible = new Set([...parent.inputArtifacts, ...parent.outputArtifacts, ...parent.dependsOnTaskIds.flatMap((id) => this.kernel.tasks.get(id).outputArtifacts)].map((ref) => ref.artifactId));
    if (input.inputArtifactIds.some((id) => !accessible.has(id))) throw new OsError("permission_denied", "不能委托未显式分享的产物");
    return this.kernel.a2a.delegate({ ...input, toAgentId: app.agentId, context: { summary: input.goal }, ctx });
  }

  view(id: string, sessionId: SessionId, ctx: OSOperationContext) {
    this.requireUser(ctx);
    const app = this.get(id);
    const session = this.kernel.sessions.get(sessionId);
    if (session.agentId !== app.agentId) throw new OsError("permission_denied", "会话不属于该应用");
    const tasks = [...this.kernel.projection.tasks.values()].filter((task) => task.sessionId === session.id && task.ownerAgentId === app.agentId);
    const taskIds = new Set(tasks.map((task) => task.id));
    const messages = this.kernel.projection.messages.filter((message) => taskIds.has(message.taskId)).slice(-100);
    const surfaces = this.kernel.ui.openSurfaces().filter((surface) => surface.taskId && taskIds.has(surface.taskId));
    return structuredClone({ app, session, tasks, messages, surfaces });
  }

  upgrade(id: string, manifest: AppPackage, ctx: OSOperationContext): AppInstance {
    this.requireUser(ctx);
    this.validate(manifest);
    const app = this.get(id);
    if (app.state !== "disabled") throw new OsError("illegal_transition", "升级前请停用 App");
    this.assertNoWork(app);
    if (manifest.id !== app.package.id || manifest.runtimeName !== app.package.runtimeName ||
        [...new Set(manifest.requestedActions)].sort().join("\n") !== [...new Set(app.approvedActions)].sort().join("\n")) {
      throw new OsError("permission_denied", "原位升级不得变更包身份、执行引擎或权限；请独立审查后重新安装");
    }
    const next = manifest.version.split(".").map(Number);
    const old = app.package.version.split(".").map(Number);
    const different = next.findIndex((part, index) => part !== old[index]);
    if (different < 0 || next[different]! < old[different]!) throw new OsError("invalid_command", "升级版本必须递增");
    app.history = [...(app.history ?? []), app.package];
    app.package = structuredClone(manifest);
    app.updatedAt = new Date().toISOString();
    const agent = structuredClone(this.kernel.agents.get(app.agentId));
    agent.name = manifest.name;
    agent.systemInstructions = manifest.instructions;
    agent.version += 1;
    // User model/memory/workspace policy and private data intentionally survive package defaults.
    this.kernel.emit("app.upgraded", { instance: app, agent }, { agentId: app.agentId }, ctx);
    return this.get(id);
  }

  remove(id: string, ctx: OSOperationContext): AppInstance {
    this.requireUser(ctx);
    const app = this.get(id);
    if (app.state !== "disabled") throw new OsError("illegal_transition", "卸载前请停用 App");
    this.assertNoWork(app);
    // Tombstone retains sessions, memory and artifacts; uninstall is not user-data deletion.
    app.state = "removed";
    app.updatedAt = new Date().toISOString();
    this.kernel.emit("app.updated", { instance: app }, { agentId: app.agentId }, ctx);
    return this.get(id);
  }

  private assertNoWork(app: AppInstance): void {
    if ([...this.kernel.projection.tasks.values()].some((task) =>
      (task.assignedAgentId === app.agentId || task.ownerAgentId === app.agentId) && !isTerminalTaskState(task.state))) {
      throw new OsError("illegal_transition", "先结束该 App 的未完成任务");
    }
  }
  private requireUser(ctx: OSOperationContext): void {
    if (ctx.actor !== "user") throw new OsError("permission_denied", "App 管理仅接受用户命令；Agent 使用委托接口");
  }
  private validate(value: AppPackage): void {
    if (!value || typeof value.id !== "string" || typeof value.version !== "string" || !/^[a-z][a-z0-9.-]+$/.test(value.id) || !/^\d+\.\d+\.\d+$/.test(value.version) ||
        typeof value.name !== "string" || !value.name.trim() || typeof value.description !== "string" ||
        typeof value.instructions !== "string" || typeof value.runtimeName !== "string" || !value.runtimeName.trim() ||
        !Array.isArray(value.capabilities) || !Array.isArray(value.requestedActions) ||
        [...value.capabilities, ...value.requestedActions].some((item) => typeof item !== "string" || !item.trim()) ||
        value.ui?.kind !== "agent-chat" || !value.defaultModel || typeof value.defaultModel !== "object") {
      throw new OsError("invalid_command", "无效声明式 App 包");
    }
    const allowed = ["id", "version", "name", "description", "runtimeName", "instructions", "capabilities", "requestedActions", "defaultModel", "ui"];
    const modelKeys = ["primary", "preferred", "fallbacks", "allowedProviders", "maxCostPerRun", "privacyZone", "windowTokens"];
    const model = value.defaultModel;
    const address = (item: unknown): boolean => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      const record = item as Record<string, unknown>;
      return Object.keys(record).every((key) => key === "providerId" || key === "modelId") && [record.providerId, record.modelId].every((text) => typeof text === "string" && text.trim().length > 0 && text.length <= 200);
    };
    if (Array.isArray(model) || (model.primary !== undefined && (typeof model.primary !== "string" || model.primary.length > 400)) ||
        (model.preferred !== undefined && !address(model.preferred)) ||
        (model.fallbacks !== undefined && (!Array.isArray(model.fallbacks) || model.fallbacks.length > 10 || !model.fallbacks.every(address))) ||
        (model.allowedProviders !== undefined && (!Array.isArray(model.allowedProviders) || model.allowedProviders.some((id) => typeof id !== "string" || !id.trim()))) ||
        (model.windowTokens !== undefined && (!Number.isSafeInteger(model.windowTokens) || model.windowTokens < 1024)) ||
        (model.maxCostPerRun !== undefined && (typeof model.maxCostPerRun !== "number" || !Number.isFinite(model.maxCostPerRun) || model.maxCostPerRun < 0)) ||
        (model.privacyZone !== undefined && typeof model.privacyZone !== "boolean")) throw new OsError("invalid_command", "无效模型策略；包中不允许嵌入凭据");
    if (Object.keys(value.defaultModel).some((key) => !modelKeys.includes(key)) || Object.keys(value.ui).some((key) => key !== "kind")) {
      throw new OsError("invalid_command", "App 模型配置和 UI 包含不支持字段；凭据不得写入应用包");
    }
    if (Object.keys(value).some((key) => !allowed.includes(key)) || JSON.stringify(value).length > 64_000) {
      throw new OsError("invalid_command", "App 清单包含不支持字段或过大；暂不支持可执行插件安装");
    }
  }
}
