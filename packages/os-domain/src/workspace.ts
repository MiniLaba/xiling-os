// Workspace 领域模型（指南 §17/§18）：
// Workspace = 持久数据视图；Sandbox = 当前执行环境。二者分离。
// 协作不共享整个 Workspace，只通过有界的、可过期的 mount。

import type { AgentId, TaskId, WorkspaceId } from "./ids.js";

export interface Workspace {
  workspaceId: WorkspaceId;
  ownerAgentId: AgentId;
  root: string;
  createdAt: string;
}

export interface WorkspaceMount {
  sourceWorkspaceId: WorkspaceId;
  /** 源 Workspace 内的子路径（只暴露子树，而不是 /） */
  path: string;
  targetAgentId: AgentId;
  access: "read" | "write";
  taskId: TaskId;
  expiresAt?: string | undefined;
}
