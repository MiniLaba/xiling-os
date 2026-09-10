// TaskService（指南 §8/§53）：Task 是 OS 的核心调度抽象。
// 状态迁移全部经过 assertTaskTransition + 事件；无直接 UPDATE。

import {
  OsError, assertTaskTransition, correlationFor, entityNotFound, isTerminalTaskState, newId, taskId as makeTaskId,
} from "@xiling/os-domain";
import type { AgentId, ArtifactRef, ModelRequirement, OSOperationContext, OutputContract, SessionId, Task, TaskConstraints, TaskId, UiSurfaceId } from "@xiling/os-domain";
import type { KernelServices } from "./kernel-services.js";
import type { OSKernel } from "./kernel.js";

export class TaskService {
  constructor(
    private readonly kernel: OSKernel,
    private readonly services: KernelServices,
  ) {}

  async create(input: {
    goal: string;
    sessionId?: SessionId | undefined;
    ownerAgentId: AgentId;
    assignedAgentId?: AgentId | undefined;
    parentTaskId?: TaskId | undefined;
    retryOfTaskId?: TaskId | undefined;
    dependsOnTaskIds?: TaskId[] | undefined;
    inputArtifacts?: ArtifactRef[] | undefined;
    constraints?: TaskConstraints | undefined;
    modelRequirements?: ModelRequirement | undefined;
    outputContract?: OutputContract | undefined;
    ctx?: OSOperationContext | undefined;
  }): Promise<Task> {
    if (input.goal.trim() === "") throw new OsError("invalid_command", "task goal must not be empty");
    if (input.sessionId !== undefined) {
      const session = this.services.sessions.get(input.sessionId);
      if (session.state !== "active") throw new OsError("illegal_transition", `session ${input.sessionId} is not active`);
      if (session.agentId !== input.ownerAgentId) throw new OsError("permission_denied", "task owner must own the session");
    }
    if (input.retryOfTaskId !== undefined && !this.services.projection.tasks.has(input.retryOfTaskId)) {
      throw entityNotFound("task", input.retryOfTaskId);
    }
    for (const dependencyId of input.dependsOnTaskIds ?? []) {
      if (!this.services.projection.tasks.has(dependencyId)) throw entityNotFound("task", dependencyId);
    }
    const task: Task = {
      id: makeTaskId(newId("task")),
      sessionId: input.sessionId,
      goal: input.goal,
      ownerAgentId: input.ownerAgentId,
      assignedAgentId: input.assignedAgentId,
      parentTaskId: input.parentTaskId,
      retryOfTaskId: input.retryOfTaskId,
      dependsOnTaskIds: [...(input.dependsOnTaskIds ?? [])],
      state: "created",
      inputArtifacts: [...(input.inputArtifacts ?? [])],
      submittedInputs: [],
      outputArtifacts: [],
      constraints: input.constraints ?? {},
      modelRequirements: input.modelRequirements,
      outputContract: input.outputContract,
      createdAt: new Date().toISOString(),
    };
    this.kernel.emit("task.created", { task }, correlationFor({ agentId: input.ownerAgentId, sessionId: input.sessionId, taskId: task.id }), input.ctx);
    if (input.assignedAgentId !== undefined) {
      await this.assign(task.id, input.assignedAgentId, input.ctx);
    }
    return this.get(task.id);
  }

  get(taskIdValue: TaskId): Task {
    const task = this.services.projection.tasks.get(taskIdValue);
    if (!task) throw entityNotFound("task", taskIdValue);
    return task;
  }

  async assign(taskIdValue: TaskId, assignedAgentId: AgentId, ctx?: OSOperationContext | undefined): Promise<void> {
    this.get(taskIdValue);
    this.kernel.emit("task.assigned", { taskId: taskIdValue, assignedAgentId }, correlationFor({ taskId: taskIdValue, agentId: assignedAgentId }), ctx);
  }

  /** 状态迁移的单一入口：迁移表校验 + 事件。 */
  transition(taskIdValue: TaskId, event: Parameters<OSKernel["emit"]>[0] extends never ? never : TaskTransitionInput, ctx?: OSOperationContext | undefined): void {
    const task = this.get(taskIdValue);
    const next = nextStateFor(event);
    assertTaskTransition(task.state, next);
    this.kernel.emit(event.type, event.payload as never, correlationFor({ taskId: taskIdValue, agentId: task.assignedAgentId }), ctx);
  }

  async complete(taskIdValue: TaskId, ctx?: OSOperationContext | undefined): Promise<void> {
    const task = this.get(taskIdValue);
    if (!isTerminalTaskState(task.state)) {
      this.transition(taskIdValue, { type: "task.completed", payload: { taskId: taskIdValue } }, ctx);
    }
    // 任务作用域授权随终态回收（最小权限生命周期）
    await this.services.capabilities.releaseTaskGrants(taskIdValue);
  }

  async fail(taskIdValue: TaskId, reason: string, ctx?: OSOperationContext | undefined): Promise<void> {
    this.transition(taskIdValue, { type: "task.failed", payload: { taskId: taskIdValue, reason } }, ctx);
    await this.services.capabilities.releaseTaskGrants(taskIdValue);
  }

  async cancel(taskIdValue: TaskId, reason: string, ctx?: OSOperationContext | undefined): Promise<void> {
    for (const child of [...this.services.projection.tasks.values()]) {
      if (child.parentTaskId === taskIdValue && !isTerminalTaskState(child.state)) await this.cancel(child.id, "父任务已取消", ctx);
    }
    const task = this.get(taskIdValue);
    if (task.state === "running") {
      // 取消的责任跟着驱动方走：模型任务交给 Runtime；科学执行交给 ScienceService。
      // 不把科学执行当成模型运行去取消，那会掩盖"取消其实没生效"。
      if (task.constraints.science !== undefined) this.services.science.abortRunning(taskIdValue);
      else await this.services.runner.cancelRunningTask(taskIdValue);
    }
    this.transition(taskIdValue, { type: "task.cancelled", payload: { taskId: taskIdValue, reason } }, ctx);
    await this.services.capabilities.releaseTaskGrants(taskIdValue);
  }

  updatePriority(taskIdValue: TaskId, priority: number, ctx?: OSOperationContext): Task {
    const task = this.get(taskIdValue);
    if (isTerminalTaskState(task.state)) throw new OsError("illegal_transition", `terminal task ${taskIdValue} cannot change priority`);
    if (!Number.isInteger(priority) || priority < -10 || priority > 10) {
      throw new OsError("invalid_command", "task priority must be an integer from -10 to 10");
    }
    this.kernel.emit("task.priority_changed", { taskId: taskIdValue, priority }, correlationFor({ taskId: taskIdValue, agentId: task.assignedAgentId }), ctx);
    return this.get(taskIdValue);
  }

  async retry(taskIdValue: TaskId, ctx?: OSOperationContext): Promise<Task> {
    const original = this.get(taskIdValue);
    if (original.state !== "failed" && original.state !== "cancelled") {
      throw new OsError("illegal_transition", `task ${taskIdValue} must be failed or cancelled before retry`);
    }
    return this.create({
      goal: original.goal,
      sessionId: original.sessionId,
      ownerAgentId: original.ownerAgentId,
      assignedAgentId: original.assignedAgentId,
      parentTaskId: original.parentTaskId,
      retryOfTaskId: original.id,
      dependsOnTaskIds: original.dependsOnTaskIds,
      inputArtifacts: original.inputArtifacts,
      constraints: structuredClone(original.constraints),
      modelRequirements: structuredClone(original.modelRequirements),
      outputContract: structuredClone(original.outputContract),
      ctx,
    });
  }

  async submitInput(taskIdValue: TaskId, payload: unknown, sourceSurfaceId?: UiSurfaceId, ctx?: OSOperationContext): Promise<void> {
    const task = this.get(taskIdValue);
    if (task.state !== "waiting_input") throw new OsError("illegal_transition", `task ${taskIdValue} is not waiting for input`);
    this.kernel.emit("task.input_submitted", {
      taskId: taskIdValue,
      input: { id: newId("input"), payload: structuredClone(payload), submittedAt: new Date().toISOString(), sourceSurfaceId },
    }, correlationFor({ taskId: taskIdValue, agentId: task.assignedAgentId }), ctx);
    this.transition(taskIdValue, { type: "task.requeued", payload: { taskId: taskIdValue, reason: "user input submitted" } }, ctx);
  }

  listByOwner(agentId: AgentId): Task[] {
    return [...this.services.projection.tasks.values()].filter((task) => task.ownerAgentId === agentId);
  }

  listByAssignee(agentId: AgentId): Task[] {
    return [...this.services.projection.tasks.values()].filter((task) => task.assignedAgentId === agentId);
  }
}

export type TaskTransitionInput =
  | { type: "task.started"; payload: { taskId: TaskId; runId: string } }
  | { type: "task.waiting_input"; payload: { taskId: TaskId; reason?: string | undefined } }
  | { type: "task.waiting_approval"; payload: { taskId: TaskId; approvalId: string } }
  | { type: "task.waiting_dependency"; payload: { taskId: TaskId; dependsOnTaskIds: TaskId[] } }
  | { type: "task.requeued"; payload: { taskId: TaskId; reason: string } }
  | { type: "task.completed"; payload: { taskId: TaskId } }
  | { type: "task.failed"; payload: { taskId: TaskId; reason: string } }
  | { type: "task.cancelled"; payload: { taskId: TaskId; reason: string } };

function nextStateFor(input: TaskTransitionInput): Task["state"] {
  switch (input.type) {
    case "task.started": return "running";
    case "task.waiting_input": return "waiting_input";
    case "task.waiting_approval": return "waiting_approval";
    case "task.waiting_dependency": return "waiting_dependency";
    case "task.requeued": return "queued";
    case "task.completed": return "completed";
    case "task.failed": return "failed";
    case "task.cancelled": return "cancelled";
  }
}
