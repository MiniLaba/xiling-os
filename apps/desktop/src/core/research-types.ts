import type { EvidenceRecord, ResearchProject } from "@xiling/contracts";
export interface ResearchKnowledgeResult {
  projects?: ResearchProject[];
  evidence?: EvidenceRecord[];
  saved?: EvidenceRecord;
}
