import type { AgentId, SessionId, TaskId, WorkspaceId } from "./ids.js";

/**
 * Session 是一个 Agent 的一次连续工作边界。
 * 它不是 Agent 身份、当前模型 Context，也不是跨任务长期 Memory。
 */
export type SessionState = "active" | "closed" | "interrupted";

export interface AgentSession {
  id: SessionId;
  agentId: AgentId;
  workspaceId?: WorkspaceId | undefined;
  title?: string | undefined;
  state: SessionState;
  taskIds: TaskId[];
  startedAt: string;
  lastActiveAt: string;
  endedAt?: string | undefined;
}
