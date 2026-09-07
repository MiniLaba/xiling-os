// 契约类型：自旧版 Web OS @xiling/contracts 原样复制（桌面端不依赖旧 monorepo 包）。

export interface PaperRecord {
  id: string;
  title: string;
  year: number;
  authors: string[];
  citationCount: number;
  references: string[];
  source: "semantic-scholar" | "openalex" | "fixture";
  url?: string;
  abstract?: string;
}

export interface LiteratureGraphNode extends PaperRecord {
  seed: boolean;
  relevance: number;
}

export interface LiteratureGraphEdge {
  id: string;
  source: string;
  target: string;
  kind: "citation" | "recommendation" | "co-citation" | "bibliographic-coupling";
  score: number;
}

export interface LiteratureGraph {
  seedIds: string[];
  nodes: LiteratureGraphNode[];
  edges: LiteratureGraphEdge[];
  algorithm: string;
  provider: "semantic-scholar" | "openalex" | "fixture";
  fetchedAt: string;
}

export interface LiteratureSearchResponse {
  query: string;
  papers: PaperRecord[];
  provider: "semantic-scholar" | "openalex";
  fetchedAt: string;
  cache: "miss" | "hit" | "stale";
  sourceHash: string;
  degradedFrom?: "semantic-scholar";
  attempts: number;
}

export type EvidenceStance = "supports" | "refutes" | "qualifies" | "insufficient";

export interface EvidenceRecord {
  id: string;
  projectId: string;
  paper: PaperRecord;
  note: string;
  stance: EvidenceStance;
  confidence: number;
  sourceQuote: string;
  sourceLocator?: string;
  limitations: string;
  claimRevisionId?: string;
  createdAt: string;
}

/** 保存证据的请求体（对应旧 POST /api/v1/evidence 的 scopedPaperSchema） */
export interface ScopedEvidenceInput {
  projectId: string;
  paper: LiteratureGraphNode | PaperRecord;
  note: string;
  stance: EvidenceStance;
  confidence: number;
  sourceQuote: string;
  sourceLocator: string;
  limitations: string;
  claimRevisionId?: string;
}
