// A2ARouter（指南 §10/§11/§24）：
// delegate() 的管道：Authentication → Permission Check → Capability Attenuation
// → Task Registration（子任务）→ Audit（事件）→ Agent B Inbox。
// ContextBundle 是发送方显式构造的最小信息包——路由器不传递任何私有会话。

import { delegationId as makeDelegationId, newId, correlationFor, entityNotFound, OsError, artifactId as makeArtifactId, isTerminalTaskState, runId as makeRunId } from "@xiling/os-domain";
import type {
  A2AStatusEvent, AgentId, ContextBundle, DelegationRequest, OSOperationContext, TaskId,
} from "@xiling/os-domain";
import type { KernelServices } from "./kernel-services.js";
import type { OSKernel } from "./kernel.js";
import type { AttenuationRequest } from "@xiling/os-domain";

/**
 * 外部 A2A 传输的内核端口。HTTP、WebSocket 或标准 A2A SDK 由组合根注入，
 * 内核只消费经过适配器校验的领域回执。
 */
export interface A2AOutboundPort {
  execute(input: {
    delegation: DelegationRequest;
    task: ReturnType<KernelServices["tasks"]["get"]>;
    signal?: AbortSignal | undefined;
    onStatus(status: Omit<A2AStatusEvent, "at">): void | Promise<void>;
  }): Promise<unknown>;
  cancel(input: { delegation: DelegationRequest; reason: string }): Promise<void>;
}

export interface DelegateInput {
  fromAgentId: AgentId;
  toAgentId: AgentId;
  parentTaskId?: TaskId | undefined;
  goal: string;
  context: ContextBundle;
  inputArtifactIds?: string[] | undefined;
  /** 委托方愿意衰减给受托方的权限 */
  attenuations?: AttenuationRequest[] | undefined;
  outputContract?: DelegationRequest["outputContract"] | undefined;
  budget?: DelegationRequest["budget"] | undefined;
  ctx?: OSOperationContext | undefined;
}

export class A2ARouter {
  private readonly outbound = new Map<AgentId, A2AOutboundPort>();

  constructor(
    private readonly kernel: OSKernel,
    private readonly services: KernelServices,
  ) {}

  registerOutbound(agentId: AgentId, port: A2AOutboundPort): () => void {
    if (this.services.agents.get(agentId) === undefined) throw entityNotFound("agent", agentId);
    this.outbound.set(agentId, port);
    return () => { if (this.outbound.get(agentId) === port) this.outbound.delete(agentId); };
  }

  /** 将已登记的委托交给外部端口；本地 Worker 仍由 Scheduler/RuntimeManager 执行。 */
  async dispatch(delegationId: string, signal?: AbortSignal | undefined, ctx?: OSOperationContext | undefined): Promise<void> {
    const entry = this.services.projection.inbox.get(makeDelegationId(delegationId));
    if (!entry) throw entityNotFound("delegation", delegationId);
    const port = this.outbound.get(entry.toAgentId);
    if (!port) throw new OsError("runtime_not_found", `no A2A outbound port registered for agent ${entry.toAgentId}`);
    await port.execute({
      delegation: entry.delegation,
      task: this.services.tasks.get(entry.taskId),
      signal,
      onStatus: (status) => this.reportStatus(status, ctx),
    });
  }

  /**
   * 委派任务：
   * 1. 双方身份存在（Authentication/Registry check）
   * 2. 建立子任务（Task Registration），挂在 parentTaskId 下
   * 3. 授权衰减（delegated ⊆ owned，任何越界即拒绝）
   * 4. 指派 + a2a.delegated 事件 = Audit + Agent B Inbox
   */
  async delegate(input: DelegateInput): Promise<{ delegationId: string; taskId: TaskId; grants: string[] }> {
    const fromDefinition = this.services.agents.get(input.fromAgentId);
    const toDefinition = this.services.agents.get(input.toAgentId);
    if (fromDefinition === undefined || toDefinition === undefined) {
      throw entityNotFound("agent", fromDefinition === undefined ? input.fromAgentId : input.toAgentId);
    }

    const subTask = await this.services.tasks.create({
      goal: input.goal,
      ownerAgentId: input.fromAgentId,
      assignedAgentId: input.toAgentId,
      parentTaskId: input.parentTaskId,
      inputArtifacts: (input.inputArtifactIds ?? []).map((artifactId) => {
        const artifact = this.services.artifacts.get(artifactId);
        return { artifactId: artifact.artifactId, version: artifact.version };
      }),
      outputContract: input.outputContract,
      constraints: input.budget === undefined ? {} : { budgetTokens: input.budget.tokens, budgetCost: input.budget.cost, deadline: input.budget.deadline },
      ctx: input.ctx,
    });

    // 权限衰减在子任务上下文内签发：每个 request 自动携带 taskId
    const attenuations = (input.attenuations ?? []).map((request) => ({ ...request, taskId: subTask.id }));
    const grants = await this.services.capabilities.attenuateForDelegation({
      fromAgentId: input.fromAgentId,
      toAgentId: input.toAgentId,
      taskId: subTask.id,
      requests: attenuations,
      ctx: input.ctx,
    });

    const delegation: DelegationRequest = {
      delegationId: makeDelegationId(newId("dlg")),
      fromAgentId: input.fromAgentId,
      toAgentId: input.toAgentId,
      taskId: subTask.id,
      goal: input.goal,
      context: input.context,
      inputArtifacts: subTask.inputArtifacts,
      capabilityGrantIds: grants.map((grant) => grant.id),
      outputContract: input.outputContract,
      budget: input.budget,
    };
    this.kernel.emit("a2a.delegated", { delegation }, correlationFor({ agentId: input.toAgentId, taskId: subTask.id }), input.ctx);

    // 有父任务且父任务尚可推进 → 父任务转为等待（跨 Agent 等待由任务完成事件驱动）
    if (input.parentTaskId !== undefined) {
      const parent = this.services.tasks.get(input.parentTaskId);
      if (parent.state === "created" || parent.state === "queued" || parent.state === "running") {
        this.services.tasks.transition(input.parentTaskId, {
          type: "task.waiting_dependency",
          payload: { taskId: input.parentTaskId, dependsOnTaskIds: [subTask.id] },
        }, input.ctx);
      }
    }

    return { delegationId: delegation.delegationId, taskId: subTask.id, grants: delegation.capabilityGrantIds };
  }

  /** 受托方回执：状态 + 产物沿 Router → Task Coordinator → 委托方（指南 §11 返回路径） */
  async reportStatus(status: Omit<A2AStatusEvent, "at">, ctx?: OSOperationContext | undefined): Promise<void> {
    const entry = this.services.projection.inbox.get(status.delegationId);
    if (!entry) throw entityNotFound("delegation", status.delegationId);
    if (entry.taskId !== status.taskId || entry.toAgentId !== status.fromAgentId) {
      throw new OsError("invalid_command", `A2A receipt correlation mismatch for delegation ${status.delegationId}`);
    }
    for (const ref of status.outputArtifacts) {
      const artifact = this.services.projection.artifacts.get(ref.artifactId);
      if (artifact === undefined || artifact.version !== ref.version) {
        throw new OsError("invalid_command", `A2A receipt references unavailable artifact ${ref.artifactId}@${ref.version}`);
      }
    }
    const full: A2AStatusEvent = { ...status, at: new Date().toISOString() };
    this.kernel.emit("a2a.status", { status: full }, correlationFor({ taskId: status.taskId, agentId: status.fromAgentId }), ctx);

    const task = this.services.tasks.get(status.taskId);
    if (status.state === "accepted") {
      if (task.state === "created" || task.state === "queued" || task.state === "waiting_input") {
        this.services.tasks.transition(status.taskId, {
          type: "task.started",
          payload: { taskId: status.taskId, runId: makeRunId(newId("a2a_run")) },
        }, ctx);
      }
    } else if (status.state === "pending") {
      if (!isTerminalTaskState(task.state) && task.state !== "waiting_input") {
        this.services.tasks.transition(status.taskId, {
          type: "task.waiting_input",
          payload: { taskId: status.taskId, reason: status.reason },
        }, ctx);
      }
    } else if (status.state === "completed") {
      // 仅挂上任务尚未记录的产物（Run Loop 已挂过的不重复）
      const known = new Set(task.outputArtifacts.map((ref) => ref.artifactId));
      for (const artifactRef of status.outputArtifacts) {
        if (known.has(artifactRef.artifactId)) continue;
        this.kernel.emit("task.artifact_added", {
          taskId: status.taskId,
          artifactId: makeArtifactId(artifactRef.artifactId),
          version: artifactRef.version,
        }, correlationFor({ taskId: status.taskId }), ctx);
      }
      // Run Loop 可能已把任务推进到终态；此时回执只负责唤醒父任务
      if (!isTerminalTaskState(task.state)) {
        await this.services.tasks.complete(status.taskId, ctx);
      }
      // 父任务在等待本子任务 → 父任务回队，Scheduler 决定下一步
      if (task.parentTaskId !== undefined) this.wakeParentIfWaiting(task.parentTaskId, ctx);
    } else if (status.state === "failed") {
      if (!isTerminalTaskState(task.state)) {
        await this.services.tasks.fail(status.taskId, status.reason ?? "delegation failed", ctx);
      }
      if (task.parentTaskId !== undefined) {
        const parent = this.services.tasks.get(task.parentTaskId);
        if (parent.state === "waiting_dependency") {
          await this.services.tasks.fail(task.parentTaskId, `dependency ${status.taskId} failed`, ctx);
        }
      }
    } else if (status.state === "cancelled") {
      if (!isTerminalTaskState(task.state)) {
        await this.services.tasks.cancel(status.taskId, status.reason ?? "delegation cancelled", ctx);
      }
      if (task.parentTaskId !== undefined) {
        this.wakeParentIfWaiting(task.parentTaskId, ctx, "delegated subtask cancelled; replanning required");
      }
    }
  }

  /** 显式取消委托：只允许委托双方发起；子任务授权随取消自动回收。 */
  async cancelDelegation(delegationId: string, requestedBy: AgentId, reason = "delegation cancelled", ctx?: OSOperationContext | undefined): Promise<void> {
    const entry = this.services.projection.inbox.get(makeDelegationId(delegationId));
    if (!entry) throw entityNotFound("delegation", delegationId);
    if (requestedBy !== entry.fromAgentId && requestedBy !== entry.toAgentId) {
      throw new OsError("permission_denied", `agent ${requestedBy} cannot cancel delegation ${delegationId}`);
    }
    if (entry.state === "completed" || entry.state === "failed" || entry.state === "cancelled") return;
    const port = this.outbound.get(entry.toAgentId);
    if (port !== undefined) await port.cancel({ delegation: entry.delegation, reason });
    await this.reportStatus({
      delegationId: entry.delegationId,
      taskId: entry.taskId,
      fromAgentId: entry.toAgentId,
      state: "cancelled",
      outputArtifacts: [],
      reason,
    }, ctx);
  }

  inboxFor(agentId: AgentId): Array<{ delegationId: string; state: string; fromAgentId: AgentId; goal: string }> {
    return [...this.services.projection.inbox.values()]
      .filter((entry) => entry.toAgentId === agentId)
      .map((entry) => ({ delegationId: entry.delegationId, state: entry.state, fromAgentId: entry.fromAgentId, goal: entry.delegation.goal }));
  }

  private wakeParentIfWaiting(parentTaskId: TaskId, ctx?: OSOperationContext | undefined, reason = "delegated subtask completed"): void {
    const parent = this.services.tasks.get(parentTaskId);
    if (parent.state === "waiting_dependency") {
      this.kernel.emit("task.requeued", { taskId: parentTaskId, reason }, correlationFor({ taskId: parentTaskId }), ctx);
    }
  }
}
