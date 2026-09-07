// 证据存储：旧 @xiling/knowledge EvidenceStore 的本地持久化形态。
// 同一 API（listEvidence / saveEvidence / toPaperRecord），数据落在 localStorage。

import type { EvidenceRecord, EvidenceStance, PaperRecord, ScopedEvidenceInput } from "./contracts.js";

const EVIDENCE_KEY = "xiling:app.literature-workbench/evidence/v1";

function toPaperRecord(paper: PaperRecord | LiteratureGraphNodeShape): PaperRecord {
  const { seed: _seed, relevance: _relevance, ...record } = paper as PaperRecord & Partial<LiteratureGraphNodeShape>;
  return record;
}

type LiteratureGraphNodeShape = PaperRecord & { seed: boolean; relevance: number };

export function listEvidence(projectId: string): EvidenceRecord[] {
  try {
    const all = JSON.parse(localStorage.getItem(EVIDENCE_KEY) ?? "{}") as Record<string, EvidenceRecord[]>;
    return all[projectId] ?? [];
  } catch {
    return [];
  }
}

export function saveEvidence(input: ScopedEvidenceInput): EvidenceRecord {
  const record: EvidenceRecord = {
    id: `evd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    projectId: input.projectId,
    paper: toPaperRecord(input.paper),
    note: input.note,
    stance: input.stance,
    confidence: input.confidence,
    sourceQuote: input.sourceQuote,
    ...(input.sourceLocator ? { sourceLocator: input.sourceLocator } : {}),
    limitations: input.limitations,
    ...(input.claimRevisionId ? { claimRevisionId: input.claimRevisionId } : {}),
    createdAt: new Date().toISOString(),
  };
  try {
    const all = JSON.parse(localStorage.getItem(EVIDENCE_KEY) ?? "{}") as Record<string, EvidenceRecord[]>;
    const list = all[input.projectId] ?? [];
    all[input.projectId] = [record, ...list];
    localStorage.setItem(EVIDENCE_KEY, JSON.stringify(all));
  } catch { /* 存储满时仅保留内存态 */ }
  return record;
}

export type { EvidenceStance };
