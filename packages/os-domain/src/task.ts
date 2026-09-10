// Task 领域模型（指南 §8）：Task 是 OS 的核心调度抽象，不是聊天消息。
// Session 是运行轨迹，Task 是需要被执行/等待/委托/取消的工作单元。

import { assertTransition } from "./state-machine.js";
import type { AgentId, SessionId, TaskId, UiSurfaceId } from "./ids.js";
import type { ModelRequirement } from "./model.js";

export type TaskState =
  | "created"
  | "queued"
  | "running"
  | "waiting_input"
  | "waiting_approval"
  | "waiting_dependency"
  | "completed"
  | "failed"
  | "cancelled";

export const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  created: ["queued", "running", "waiting_input", "waiting_dependency", "failed", "cancelled"],
  queued: ["running", "waiting_input", "waiting_dependency", "failed", "cancelled"],
  running: ["waiting_input", "waiting_approval", "waiting_dependency", "completed", "failed", "cancelled"],
  waiting_input: ["queued", "running", "failed", "cancelled"],
  waiting_approval: ["running", "queued", "cancelled", "failed"],
  waiting_dependency: ["queued", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function assertTaskTransition(from: TaskState, to: TaskState): void {
  assertTransition("task", TASK_TRANSITIONS, from, to);
}

export interface ArtifactRef {
  artifactId: string;
  version: number;
}

export interface TaskConstraints {
  /** Host-selected per-task runtime; never changes the persistent Agent's default. */
  runtimeBinding?: { name: string; providerId: string; modelId: string } | undefined;
  deadline?: string | undefined;
  priority?: number | undefined;
  budgetTokens?: number | undefined;
  budgetCost?: number | undefined;
  /**
   * 科学计算绑定。带此标记的任务是"本次计算计划"的用户可见工作单元，
   * 由 ScienceService 驱动，绝不由模型 Scheduler 执行（Harness Run 不冒充科学执行）。
   * 执行记录拥有自己的 ID（executionId），不是任务的别名。
   */
  science?: ScienceTaskBinding | undefined;
}

export interface ScienceTaskBinding {
  projectId: string;
  /** 规范化后的执行计划哈希；审批必须匹配同一个哈希。 */
  planHash: string;
  /**
   * 用户批准过的计划快照（规范化 JSON）。执行前会重新校验哈希，
   * 因此事后改动计划会被发现并拒绝，而不是按新参数执行旧审批。
   */
  plan: unknown;
  /** 真正执行该计划的安全适配器 ID（有可用执行后端时才写入）。 */
  adapterId?: string | undefined;
  /** 科学执行记录 ID（与任务 ID 不同，不互相冒充）。 */
  executionId?: string | undefined;
}

export interface OutputContract {
  /** 任务完成必须产出的 artifact 类型 */
  requiredArtifactTypes?: string[] | undefined;
  schema?: unknown;
}

export interface TaskInput {
  id: string;
  payload: unknown;
  submittedAt: string;
  sourceSurfaceId?: UiSurfaceId | undefined;
}

export interface Task {
  id: TaskId;
  /** 发起此任务的连续工作边界；旧事件可缺省，新目标入口必须提供。 */
  sessionId?: SessionId | undefined;
  goal: string;
  ownerAgentId: AgentId;
  assignedAgentId?: AgentId | undefined;
  parentTaskId?: TaskId | undefined;
  /** 失败/取消后重试会创建新任务；此字段保留原任务血缘，不复活终态事件。 */
  retryOfTaskId?: TaskId | undefined;
  /** 依赖的任务：全部完成后才可被调度 */
  dependsOnTaskIds: TaskId[];
  state: TaskState;
  /** 最近一次状态变化的人类可读原因；用于控制中心，不复制 Runtime 轨迹。 */
  statusReason?: string | undefined;
  inputArtifacts: ArtifactRef[];
  /** 旧事件/A2A 对端可省略；本地 TaskService 创建的新任务始终初始化为空数组。 */
  submittedInputs?: TaskInput[] | undefined;
  outputArtifacts: ArtifactRef[];
  constraints: TaskConstraints;
  modelRequirements?: ModelRequirement | undefined;
  outputContract?: OutputContract | undefined;
  createdAt: string;
  completedAt?: string | undefined;
}

/** 终态：不可再迁移 */
export function isTerminalTaskState(state: TaskState): boolean {
  return TASK_TRANSITIONS[state].length === 0;
}
