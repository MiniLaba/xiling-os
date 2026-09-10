// OS 事件模型（指南 §2.6/§37）：
// 长期状态一律 Command → Domain Logic → Event → Store → Projection。
// 事件携带完整关联字段（可空），支撑分布式追踪：User Action → Agent → Task → Tool → Artifact。

import { newId } from "./ids.js";
import type { AppInstallFact, AppInstance } from "./app.js";
import type {
  ActivationId, AgentId, ApprovalId, ArtifactId, DelegationId, GrantId, MemoryRecordId, RunId,
  SessionId, TaskId, ToolCallId, UiSurfaceId,
} from "./ids.js";
import type { AgentActivation, AgentDefinition, AgentState, ModelPolicy } from "./agent.js";
import type { AgentSession, SessionState } from "./session.js";
import type { Task, TaskInput, ScienceTaskBinding } from "./task.js";
import type { Artifact } from "./artifact.js";
import type { MemoryRecord } from "./memory.js";
import type { CapabilityGrant } from "./capability.js";
import type { Workspace, WorkspaceMount } from "./workspace.js";
import type { A2AStatusEvent, DelegationRequest } from "./a2a.js";
import type { ApprovalRequest } from "./approval.js";
import type { UISurface } from "./ui.js";
import type { AgentMessage } from "./message.js";
import type { ContextReceipt } from "./context.js";
import type { AgentPluginManifest, PluginInstallation } from "./plugin.js";
import type { ModelAddress, ModelCapabilityDeclaration } from "./model.js";

export interface EventCorrelation {
  tenantId?: string | undefined;
  userId?: string | undefined;
  agentId?: AgentId | undefined;
  activationId?: ActivationId | undefined;
  sessionId?: string | undefined;
  taskId?: TaskId | undefined;
  runId?: RunId | undefined;
  stepId?: string | undefined;
  toolCallId?: ToolCallId | undefined;
  artifactId?: ArtifactId | undefined;
  traceId?: string | undefined;
}

export interface OSOperationContext extends EventCorrelation {
  /** 命令发起者：user / agent / system */
  actor: "user" | "agent" | "system";
  actorAgentId?: AgentId | undefined;
}

export const SYSTEM_CONTEXT: OSOperationContext = { actor: "system" };
export type OSEventPayloads = {
  "app.installed": AppInstallFact;
  "app.upgraded": AppInstallFact;
  "app.updated": { instance: AppInstance };
  "agent.created": { definition: AgentDefinition };
  "agent.activated": { activation: AgentActivation };
  "agent.state_changed": { activationId: ActivationId; agentId: AgentId; state: AgentState };
  "agent.model_policy_updated": { agentId: AgentId; modelPolicy: ModelPolicy };
  "agent.runtime_updated": { agentId: AgentId; runtimeName: string };
  "agent.plugin_bound": { agentId: AgentId; pluginId: string; binding: { pluginId: string; version?: string | undefined; config?: Record<string, unknown> | undefined } };
  "agent.plugin_unbound": { agentId: AgentId; pluginId: string };
  "agent.message": { message: AgentMessage };
  "session.opened": { session: AgentSession };
  "session.closed": { sessionId: SessionId; state: Extract<SessionState, "closed" | "interrupted"> };
  "context.compiled": { receipt: ContextReceipt };
  "model.registered": { declaration: ModelCapabilityDeclaration };
  "model.removed": { address: ModelAddress };

  "plugin.installed": { installation: PluginInstallation };
  "plugin.enabled": { pluginId: string };
  "plugin.disabled": { pluginId: string; reason?: string | undefined };
  "plugin.upgraded": { pluginId: string; fromVersion: string; manifest: AgentPluginManifest };
  "plugin.rolled_back": { pluginId: string; fromVersion: string; manifest: AgentPluginManifest };
  "plugin.operation_failed": { pluginId: string; operation: string; reason: string };
  "plugin.removed": { pluginId: string };

  "task.created": { task: Task };
  "task.assigned": { taskId: TaskId; assignedAgentId: AgentId };
  "task.started": { taskId: TaskId; runId: RunId };
  "task.waiting_input": { taskId: TaskId; reason?: string | undefined };
  "task.waiting_approval": { taskId: TaskId; approvalId: ApprovalId };
  "task.waiting_dependency": { taskId: TaskId; dependsOnTaskIds: TaskId[] };
  "task.requeued": { taskId: TaskId; reason: string };
  "task.artifact_added": { taskId: TaskId; artifactId: ArtifactId; version: number };
  "task.input_submitted": { taskId: TaskId; input: TaskInput };
  "task.priority_changed": { taskId: TaskId; priority: number };
  /**
   * 科学执行绑定的落定事实：哪个适配器真的跑了、执行记录 ID 是什么。
   * 计划本身与 planHash 在 task.created 的约束里；这里只记录执行事实。
   */
  "task.science_bound": { taskId: TaskId; binding: ScienceTaskBinding };
  "task.completed": { taskId: TaskId };
  "task.failed": { taskId: TaskId; reason: string };
  "task.cancelled": { taskId: TaskId; reason: string };

  /** content 仅为旧 JSONL 兼容字段；新事件正文存入内容寻址 Blob Store。 */
  "artifact.created": { artifact: Artifact; content?: string };
  "artifact.version_added": { artifact: Artifact; content?: string };

  "memory.created": { record: MemoryRecord };
  "memory.superseded": { supersededId: MemoryRecordId; byId: MemoryRecordId };
  "memory.deleted": { recordId: MemoryRecordId; reason: string };

  "capability.granted": { grant: CapabilityGrant };
  "capability.revoked": { grantId: GrantId; reason: string };

  "workspace.created": { workspace: Workspace };
  "workspace.mounted": { mount: WorkspaceMount };

  "approval.requested": { request: ApprovalRequest };
  "approval.decided": { approvalId: ApprovalId; decision: "approved" | "rejected"; decidedBy: string };

  "a2a.delegated": { delegation: DelegationRequest };
  "a2a.status": { status: A2AStatusEvent };

  "tool.executed": { taskId: TaskId; toolCallId: string; name: string; idempotencyKey: string; output: unknown };

  "ui.presented": { surface: UISurface };
  "ui.closed": { surfaceId: UiSurfaceId; reason: string };
  "ui.action": { surfaceId: UiSurfaceId; actionId: string; command: string; input: unknown };
};

export type OSEventType = keyof OSEventPayloads;

/** 判别联合：event.type 收窄时 payload 同步收窄（投影/回放的类型基础）。 */
export type OSEvent = {
  [K in OSEventType]: {
    /** 全局单调递增序号，由 EventStore 分配 */
    seq: number;
    eventId: string;
    type: K;
    occurredAt: string;
    correlation: EventCorrelation;
    payload: OSEventPayloads[K];
  };
}[OSEventType];

export interface UnserializedEvent {
  type: OSEventType;
  payload: OSEventPayloads[OSEventType];
  correlation?: EventCorrelation | undefined;
}

export function createUnserializedEvent(type: OSEventType, payload: OSEventPayloads[OSEventType], correlation?: EventCorrelation | undefined): UnserializedEvent {
  return { type, payload, correlation };
}

export function newEventId(): string {
  return newId("evt");
}

// 关联字段提取助手：从领域对象快速构造 correlation
export function correlationFor(input: {
  agentId?: AgentId | undefined;
  sessionId?: SessionId | undefined;
  taskId?: TaskId | undefined;
  runId?: RunId | undefined;
  toolCallId?: ToolCallId | undefined;
  artifactId?: ArtifactId | undefined;
  activationId?: ActivationId | undefined;
  delegationId?: DelegationId | undefined;
  approvalId?: ApprovalId | undefined;
  surfaceId?: UiSurfaceId | undefined;
  memoryRecordId?: MemoryRecordId | undefined;
  grantId?: GrantId | undefined;
}): EventCorrelation {
  const correlation: EventCorrelation = {};
  if (input.agentId !== undefined) correlation.agentId = input.agentId;
  if (input.sessionId !== undefined) correlation.sessionId = input.sessionId;
  if (input.taskId !== undefined) correlation.taskId = input.taskId;
  if (input.runId !== undefined) correlation.runId = input.runId;
  if (input.toolCallId !== undefined) correlation.toolCallId = input.toolCallId;
  if (input.artifactId !== undefined) correlation.artifactId = input.artifactId;
  if (input.activationId !== undefined) correlation.activationId = input.activationId;
  return correlation;
}
