// Native adapter: durable KnowledgeStore and explicit project scope.
import type { EvidenceRecord, ScopedEvidenceInput } from "./contracts.js";
export async function listEvidence(projectId: string): Promise<EvidenceRecord[]> {
  if (!window.xilingDesktop) throw new Error("请使用原生科研 OS");
  return (await window.xilingDesktop.researchKnowledge({ action: "evidence.list", projectId })).evidence ?? [];
}
export async function saveEvidence(input: ScopedEvidenceInput): Promise<EvidenceRecord> {
  if (!window.xilingDesktop) throw new Error("请使用原生科研 OS");
  const result = await window.xilingDesktop.researchKnowledge({ ...input, action: "evidence.save" });
  if (!result.saved) throw new Error("证据未保存");
  return result.saved;
}
export type { EvidenceStance } from "./contracts.js";
