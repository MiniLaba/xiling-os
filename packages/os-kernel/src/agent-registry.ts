// AgentRegistry + RuntimeManager（指南 §5/§6/§9/§53）：
// Agent Identity（长期实体）与 Agent Activation（类进程运行体）分离。
// Main Agent 没有特殊 Runtime，只有 OS 级权限与 default_entry_agent 标记。

import {
  SYSTEM_CONTEXT, activationId, agentId as makeAgentId, newId, OsError, entityNotFound,
  assertTransition, correlationFor, isTerminalTaskState,
} from "@xiling/os-domain";
import type { ActivationId, AgentActivation, AgentDefinition, AgentId, AgentState, ModelPolicy, OSOperationContext, PluginBinding } from "@xiling/os-domain";
import type { AgentRuntime, ActivationSpec } from "@xiling/os-runtime";
import type { KernelServices } from "./kernel-services.js";
import type { OSKernel } from "./kernel.js";

const AGENT_TRANSITIONS: Readonly<Record<AgentState, readonly AgentState[]>> = {
  starting: ["idle", "running", "failed", "stopped"],
  idle: ["running", "suspended", "stopped"],
  running: ["idle", "waiting_user", "waiting_agent", "suspended", "failed", "stopped"],
  waiting_user: ["running", "suspended", "stopped"],
  waiting_agent: ["running", "suspended", "stopped"],
  suspended: ["idle", "running", "stopped"],
  failed: ["stopped"],
  stopped: [],
};

export class AgentRegistry {
  constructor(
    private readonly kernel: OSKernel,
    private readonly services: KernelServices,
  ) {}

  /** 创建长期 Agent 身份（数据实体，停止运行也不消失） */
  async create(input: {
    name: string;
    isMainAgent?: boolean | undefined;
    runtimeName: string;
    pluginBindings?: PluginBinding[] | undefined;
    allowedActions: string[];
    systemInstructions?: string | undefined;
    modelPolicy?: AgentDefinition["modelPolicy"] | undefined;
    memoryPolicy?: AgentDefinition["memoryPolicy"] | undefined;
    workspacePolicy?: AgentDefinition["workspacePolicy"] | undefined;
    ctx?: OSOperationContext | undefined;
  }): Promise<AgentDefinition> {
    const definition: AgentDefinition = {
      id: makeAgentId(newId("agent")),
      name: input.name,
      isMainAgent: input.isMainAgent ?? false,
      modelPolicy: input.modelPolicy ?? {},
      pluginBindings: input.pluginBindings ?? [],
      memoryPolicy: input.memoryPolicy ?? {},
      workspacePolicy: input.workspacePolicy ?? {},
      permissionPolicy: { allowedActions: [...input.allowedActions] },
      runtimeName: input.runtimeName,
      systemInstructions: input.systemInstructions,
      createdAt: new Date().toISOString(),
      version: 1,
    };
    this.kernel.emit("agent.created", { definition }, correlationFor({ agentId: definition.id }), input.ctx);
    return definition;
  }

  get(agentId: AgentId): AgentDefinition {
    const definition = this.services.projection.agents.get(agentId);
    if (!definition) throw entityNotFound("agent", agentId);
    return definition;
  }

  list(): AgentDefinition[] {
    return [...this.services.projection.agents.values()];
  }

  findMainAgent(): AgentDefinition | undefined {
    return this.list().find((definition) => definition.isMainAgent);
  }

  enableNativeMain(runtimeName: string, ctx: OSOperationContext): AgentDefinition {
    const main = this.findMainAgent();
    if (ctx.actor !== "user" || !main) throw new Error("真实 Main 运行时不可用");
    return this.setRuntime(main.id, runtimeName, ctx);
  }

  updateModelPolicy(agentId: AgentId, modelPolicy: ModelPolicy, ctx?: OSOperationContext | undefined): AgentDefinition {
    this.get(agentId);
    this.kernel.emit("agent.model_policy_updated", { agentId, modelPolicy: structuredClone(modelPolicy) }, correlationFor({ agentId }), ctx);
    return this.get(agentId);
  }

  /**
   * 把长期 Agent 指向一个已注册的真实运行时（Pi 科研路线为默认目标）。
   * 运行时未注册、或该 Agent 仍有未完成任务时拒绝：运行中切换引擎等于用另一套引擎
   * 冒充原有运行，必须由调用方先收敛任务。
   */
  setRuntime(agentId: AgentId, runtimeName: string, ctx: OSOperationContext): AgentDefinition {
    const definition = this.get(agentId);
    if (!this.services.runtimes.get(runtimeName)) {
      throw new OsError("runtime_not_found", `运行时 ${runtimeName} 未注册`);
    }
    const busy = [...this.services.projection.tasks.values()].some(
      (task) => (task.ownerAgentId === agentId || task.assignedAgentId === agentId) && !isTerminalTaskState(task.state),
    );
    if (busy) throw new OsError("illegal_transition", "请先结束该 Agent 的未完成任务再切换运行时");
    if (definition.runtimeName !== runtimeName) {
      this.kernel.emit("agent.runtime_updated", { agentId, runtimeName }, correlationFor({ agentId }), ctx);
    }
    return this.get(agentId);
  }

  async bindPlugin(agentId: AgentId, pluginId: string, version: string | undefined, ctx?: OSOperationContext | undefined): Promise<void> {
    const definition = this.get(agentId);
    if (definition.pluginBindings.some((binding) => binding.pluginId === pluginId)) return;
    const binding: PluginBinding = version === undefined ? { pluginId } : { pluginId, version };
    // 不直接改投影对象：绑定事实由事件驱动（Replay 一致性）
    this.kernel.emit("agent.plugin_bound", { agentId, pluginId, binding }, correlationFor({ agentId }), ctx);
  }

  /**
   * 激活 Agent：把身份装进 Runtime（≈ fork/exec）。
   * runtimeName 解析失败时直接抛错——不允许静默用错引擎。
   */
  async activate(agentId: AgentId, ctx?: OSOperationContext | undefined): Promise<AgentActivation> {
    this.assertEnabled(agentId);
    const definition = this.get(agentId);
    const runtime = this.services.runtimes.get(definition.runtimeName);
    if (!runtime) {
      throw new OsError("runtime_not_found", `runtime "${definition.runtimeName}" is not registered`);
    }
    const activation: AgentActivation = {
      activationId: activationId(newId("act")),
      agentId,
      state: "starting",
      hostId: "local",
      activeSessionIds: [],
      currentTaskIds: [],
      activatedAt: new Date().toISOString(),
    };
    this.kernel.emit("agent.activated", { activation }, correlationFor({ agentId, activationId: activation.activationId }), ctx);
    await runtime.activate({
      activationId: activation.activationId,
      agentId,
      systemInstructions: definition.systemInstructions,
      // 工具 schema 不在 Agent 激活时常驻；RuntimeManager 会按具体 Task 命中后投递。
      tools: [],
    } satisfies ActivationSpec);
    this.setActivationState(activation.activationId, "idle", ctx);
    return this.services.projection.activations.get(activation.activationId)!;
  }

  setActivationState(activationIdValue: ActivationId, next: AgentState, ctx?: OSOperationContext | undefined): void {
    const activation = this.services.projection.activations.get(activationIdValue);
    if (!activation) throw entityNotFound("activation", activationIdValue);
    assertTransition("activation", AGENT_TRANSITIONS, activation.state, next);
    activation.state = next;
    this.kernel.emit(
      "agent.state_changed",
      { activationId: activationIdValue, agentId: activation.agentId, state: next },
      correlationFor({ agentId: activation.agentId, activationId: activationIdValue }),
      ctx,
    );
  }

  async suspend(agentId: AgentId, ctx?: OSOperationContext | undefined): Promise<void> {
    const definition = this.get(agentId);
    await this.services.runtimes.get(definition.runtimeName)?.suspend(agentId);
    const activation = this.findActiveActivation(agentId);
    if (activation) this.setActivationState(activation.activationId, "suspended", ctx);
  }

  async resume(agentId: AgentId, ctx?: OSOperationContext | undefined): Promise<void> {
    const definition = this.get(agentId);
    const runtime = this.services.runtimes.get(definition.runtimeName);
    if (!runtime) throw new OsError("runtime_not_found", `runtime "${definition.runtimeName}" is not registered`);
    await runtime.resume(agentId);
    const activation = this.findActiveActivation(agentId);
    if (activation) this.setActivationState(activation.activationId, "idle", ctx);
  }

  findActiveActivation(agentId: AgentId): AgentActivation | undefined {
    for (const activation of this.services.projection.activations.values()) {
      if (activation.agentId === agentId && activation.state !== "stopped" && activation.state !== "failed") {
        return activation;
      }
    }
    return undefined;
  }

  /** 便捷取用：Main Agent 的 activation（没有则激活一次） */
  async ensureActivation(agentId: AgentId, ctx: OSOperationContext = SYSTEM_CONTEXT): Promise<AgentActivation> {
    this.assertEnabled(agentId);
    const existing = this.findActiveActivation(agentId);
    if (existing) return existing;
    return this.activate(agentId, ctx);
  }

  private assertEnabled(agentId: AgentId): void {
    if ([...this.services.projection.apps.values()].some((app) => app.agentId === agentId && app.state !== "enabled")) {
      throw new OsError("permission_denied", "App 已停用，不能绕过 App 入口激活 Agent");
    }
  }
}
