import path from "node:path";
import { KnowledgeService } from "@xiling/knowledge";
import { projectIdSchema, scopedPaperSchema, toPaperRecord } from "@xiling/api-contracts";
import type { ResearchKnowledgeResult } from "./research-types.js";

/** Native transport adapter over the SAME research store, not another schema. */
export class ResearchKnowledgeHost {
  readonly knowledge: KnowledgeService;
  constructor(root: string) { this.knowledge = new KnowledgeService(path.join(root, "knowledge.sqlite")); }
  close() { this.knowledge.close(); }
  handle(raw: unknown): ResearchKnowledgeResult {
    if (!raw || typeof raw !== "object") throw new Error("Invalid research request");
    const request = raw as Record<string, unknown>;
    if (request.action === "projects.list") return { projects: this.knowledge.listProjects() };
    if (request.action === "projects.create") {
      if (typeof request.name !== "string" || !request.name.trim() || request.name.length > 200) throw new Error("项目名称无效");
      this.knowledge.createProject({ name: request.name.trim(), description: "", researchQuestion: "", domainIds: ["general-science"] });
      return { projects: this.knowledge.listProjects() };
    }
    const projectId = projectIdSchema.parse(request.projectId);
    if (!this.knowledge.getProject(projectId)) throw new Error("项目不存在；请先选择或创建项目");
    if (request.action === "evidence.list") return { evidence: this.knowledge.listEvidence(projectId) };
    if (request.action === "evidence.save") {
      const value = scopedPaperSchema.parse(request);
      if (!value.sourceQuote.trim()) throw new Error("科研证据需要原文摘录");
      // Claim ownership is checked by the graph service; do not accept unchecked links here.
      if (value.claimRevisionId) throw new Error("请在科研图谱中验证并关联结论版本");
      const saved = this.knowledge.saveEvidence(projectId, toPaperRecord(value.paper), value.note, value.stance, value.confidence, {
        sourceQuote: value.sourceQuote, limitations: value.limitations,
        ...(value.sourceLocator ? { sourceLocator: value.sourceLocator } : {}),
      });
      return { saved };
    }
    throw new Error("Unsupported research operation");
  }
}
