// ApprovalService（指南 §25）：
// Permission = "理论上可不可以"；Approval = "这一次是否允许"。二者分离。
// 审批请求由 Run Loop 在高危操作前产生；用户决定后任务恢复运行。

import { approvalId as makeApprovalId, newId, correlationFor, entityNotFound, OsError } from "@xiling/os-domain";
import type { ApprovalId, ApprovalRequest, AgentId, OSOperationContext, TaskId } from "@xiling/os-domain";
import type { KernelServices } from "./kernel-services.js";
import type { OSKernel } from "./kernel.js";

export class ApprovalService {
  constructor(
    private readonly kernel: OSKernel,
    private readonly services: KernelServices,
  ) {}

  async request(input: {
    taskId: TaskId;
    agentId: AgentId;
    action: string;
    resource: string;
    reason?: string | undefined;
    ctx?: OSOperationContext | undefined;
  }): Promise<ApprovalRequest> {
    const request: ApprovalRequest = {
      approvalId: makeApprovalId(newId("apr")),
      taskId: input.taskId,
      agentId: input.agentId,
      action: input.action,
      resource: input.resource,
      reason: input.reason,
      state: "pending",
      createdAt: new Date().toISOString(),
    };
    this.kernel.emit("approval.requested", { request }, correlationFor({ taskId: input.taskId, agentId: input.agentId }), input.ctx);
    this.services.tasks.transition(input.taskId, {
      type: "task.waiting_approval",
      payload: { taskId: input.taskId, approvalId: request.approvalId },
    }, input.ctx);
    return request;
  }

  async decide(approvalIdValue: string, decision: "approved" | "rejected", decidedBy: string, ctx?: OSOperationContext | undefined): Promise<ApprovalRequest> {
    const request = this.services.projection.approvals.get(makeApprovalId(approvalIdValue));
    if (!request) throw entityNotFound("approval", approvalIdValue);
    if (request.state !== "pending") throw new OsError("illegal_transition", `approval ${approvalIdValue} already ${request.state}`);
    this.kernel.emit("approval.decided", { approvalId: makeApprovalId(approvalIdValue), decision, decidedBy }, correlationFor({ taskId: request.taskId }), { ...ctx, actor: "user" });
    // 决策后任务恢复（批准）/失败（拒绝）
    if (decision === "approved") {
      this.services.tasks.transition(request.taskId, {
        type: "task.requeued",
        payload: { taskId: request.taskId, reason: `approval ${approvalIdValue} approved` },
      }, ctx);
    } else {
      await this.services.tasks.fail(request.taskId, `approval ${approvalIdValue} rejected by ${decidedBy}`, ctx);
    }
    return this.services.projection.approvals.get(makeApprovalId(approvalIdValue))!;
  }

  pending(): ApprovalRequest[] {
    return [...this.services.projection.approvals.values()].filter((request) => request.state === "pending");
  }
}
