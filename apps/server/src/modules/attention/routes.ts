import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AttentionItem, EvidenceRecord, ResearchGraphProposal } from "@xiling/contracts";
import type { ProjectResearchWorkflow } from "@xiling/domain-ocean";

export function registerAttentionRoutes(app: FastifyInstance, dependencies: {
  projectExists(projectId: string): boolean;
  listWorkflows(projectId: string): ProjectResearchWorkflow[];
  listEvidence(projectId: string): EvidenceRecord[];
  listProposals(projectId: string): ResearchGraphProposal[];
  listAgentIssues(projectId: string): Array<{ id: string; status: string; error?: string; createdAt: string }>;
}): void {
  app.get("/api/v1/attention", async (request, reply) => {
    const query = z.object({ projectId: z.string().min(1).max(120) }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "Attention view requires projectId" });
    const projectId = query.data.projectId;
    if (!dependencies.projectExists(projectId)) return reply.code(404).send({ error: "Project not found" });
    const items: AttentionItem[] = [];
    for (const workflow of dependencies.listWorkflows(projectId)) {
      if (workflow.status === "pending_approval") items.push({ id: `approval:${workflow.id}`, projectId, kind: "approval", severity: "warning", title: "数据与计算计划等待审批", summary: `${workflow.request.connectorId} · ${workflow.request.datasetId} · ${workflow.request.variables.join("、")}`, targetView: "chat", sourceId: workflow.id, createdAt: workflow.updatedAt });
      if (["failed", "cancelled"].includes(workflow.status)) items.push({ id: `workflow:${workflow.id}`, projectId, kind: "failed-run", severity: "critical", title: "科研运行需要恢复", summary: workflow.error ?? `Workflow ${workflow.status}`, targetView: "project", sourceId: workflow.id, createdAt: workflow.updatedAt });
      if (workflow.review?.verdict === "rejected") items.push({ id: `review:${workflow.review.id}`, projectId, kind: "review", severity: "warning", title: "Reviewer 未通过", summary: workflow.review.limitations.join("；") || "检查项未全部通过", targetView: "canvas", sourceId: workflow.review.id, createdAt: workflow.review.createdAt });
    }
    for (const evidence of dependencies.listEvidence(projectId)) if (evidence.sourceQuote && !evidence.sourceLocator) items.push({ id: `evidence:${evidence.id}`, projectId, kind: "evidence-gap", severity: "critical", title: "精确摘录缺少定位", summary: evidence.paper.title, targetView: "papers", sourceId: evidence.id, createdAt: evidence.createdAt });
    for (const proposal of dependencies.listProposals(projectId)) if (proposal.status === "pending") items.push({ id: `proposal:${proposal.id}`, projectId, kind: "proposal", severity: "warning", title: "科研事实提案等待确认", summary: proposal.action.type === "create_claim" ? proposal.action.title : proposal.action.type === "revise_claim" ? `修订 ${proposal.action.claimId}` : proposal.action.summary, targetView: "canvas", sourceId: proposal.id, createdAt: proposal.createdAt });
    for (const issue of dependencies.listAgentIssues(projectId)) items.push({ id: `agent:${issue.id}`, projectId, kind: "failed-run", severity: issue.status === "suspended" ? "warning" : "critical", title: issue.status === "suspended" ? "Agent 运行可恢复" : "Agent 运行失败", summary: issue.error ?? issue.status, targetView: "chat", sourceId: issue.id, createdAt: issue.createdAt });
    const severityRank = { critical: 0, warning: 1, info: 2 } as const;
    return items.sort((left, right) => severityRank[left.severity] - severityRank[right.severity] || right.createdAt.localeCompare(left.createdAt));
  });
}
