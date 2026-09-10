// A2A 领域模型（指南 §10/§11）：
// 内部协议围绕 Task Delegation，而不是聊天。
// ContextBundle 是发送方显式构造的最小信息包——绝不等于 sourceAgent.entireSession。

import type { AgentId, ArtifactId, DelegationId, GrantId, SessionId, TaskId } from "./ids.js";
import type { ArtifactRef } from "./task.js";
import type { OutputContract } from "./task.js";

export interface ContextFact {
  key: string;
  value: unknown;
  /** 事实来源（artifact/session/task 引用），保证可追溯 */
  sourceRef?: string | undefined;
}

export interface MessageRef {
  sessionId: SessionId;
  messageId: string;
}

export interface ContextBundle {
  summary?: string | undefined;
  facts?: ContextFact[] | undefined;
  references?: ArtifactRef[] | undefined;
  selectedMessages?: MessageRef[] | undefined;
  constraints?: string[] | undefined;
}

export interface DelegationBudget {
  tokens?: number | undefined;
  cost?: number | undefined;
  deadline?: string | undefined;
}

export interface DelegationRequest {
  delegationId: DelegationId;
  fromAgentId: AgentId;
  toAgentId: AgentId;
  taskId: TaskId;
  goal: string;
  context: ContextBundle;
  inputArtifacts: ArtifactRef[];
  /** 衰减后授予受托方的 CapabilityGrant id 集合 */
  capabilityGrantIds: GrantId[];
  outputContract?: OutputContract | undefined;
  budget?: DelegationBudget | undefined;
}

export type A2AMessageState = "pending" | "accepted" | "completed" | "failed" | "cancelled";

export interface A2AInboxEntry {
  delegationId: DelegationId;
  taskId: TaskId;
  fromAgentId: AgentId;
  toAgentId: AgentId;
  state: A2AMessageState;
  receivedAt: string;
  /** 收件方可见的上下文就是 DelegationRequest.context——不发完整会话 */
  delegation: DelegationRequest;
}

/** 受托方回执给委托方的最小事件（指南 §11 返回路径） */
export interface A2AStatusEvent {
  delegationId: DelegationId;
  taskId: TaskId;
  fromAgentId: AgentId;
  state: A2AMessageState;
  outputArtifacts: ArtifactRef[];
  reason?: string | undefined;
  at: string;
}
