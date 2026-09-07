// Approval 领域模型（指南 §25）：
// Permission 回答"理论上可不可以"；Approval 回答"这一次具体操作是否允许"。二者分离。

import type { AgentId, ApprovalId, TaskId } from "./ids.js";

export type ApprovalState = "pending" | "approved" | "rejected";

export interface ApprovalRequest {
  approvalId: ApprovalId;
  taskId: TaskId;
  agentId: AgentId;
  /** 待批准的具体操作（如 production.deploy） */
  action: string;
  resource: string;
  reason?: string | undefined;
  state: ApprovalState;
  createdAt: string;
  decidedAt?: string | undefined;
  decidedBy?: string | undefined;
}
