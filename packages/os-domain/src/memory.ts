// Memory 领域模型（指南 §13/§14/§15）：
// 四层中的长期三层（episodic/semantic/procedural）；Context Memory 由 Runtime 自己持有。
// 物理隔离：memory_namespace = tenant/agent —— 本模型根本没有跨 Agent 查询的字段。

import type { AgentId, ArtifactId, MemoryRecordId, SessionId, TaskId } from "./ids.js";

export type MemoryType = "episodic" | "semantic" | "procedural";

export interface MemoryProvenance {
  sourceSessionId?: SessionId | undefined;
  sourceTaskId?: TaskId | undefined;
  sourceArtifactId?: ArtifactId | undefined;
  /** 谁让系统记下这条：user / agent self / task outcome */
  origin: "user" | "agent" | "task";
  note?: string | undefined;
}

export interface MemoryRecord {
  id: MemoryRecordId;
  agentId: AgentId;
  type: MemoryType;
  content: unknown;
  /** 语义去重键：同键的新记录取代旧记录，而不是直接覆盖（memory.superseded） */
  dedupeKey: string;
  provenance: MemoryProvenance;
  confidence?: number | undefined;
  sensitivity?: string[] | undefined;
  createdAt: string;
  supersededBy?: MemoryRecordId | undefined;
  expiresAt?: string | undefined;
}

export interface MemorySearchHit {
  record: MemoryRecord;
  /** 0–1，表示本次查询的确定性词法相关度，不冒充向量相似度。 */
  relevance: number;
  /** 0–1，来自记录自身或按来源类型采用保守默认值。 */
  confidence: number;
  freshness: { status: "current" | "aging"; ageDays: number; expiresAt?: string | undefined };
  matchedTerms: string[];
  retrievedAt: string;
}

/** 导出记忆是跨 Agent 共享信息的唯一合法通道（memory.export → Context Artifact → A2A） */
export interface MemoryExport {
  records: MemoryRecord[];
  exportedAt: string;
  exportedBy: AgentId;
}
