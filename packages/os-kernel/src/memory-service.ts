// MemoryService（指南 §13–§16）：
// 物理隔离 memory_namespace = tenant/agent —— 查询接口根本没有"别人的 namespace"参数。
// 写入走 Pipeline：candidate → dedupe → supersede（不直接覆盖）。读取记录 provenance。

import { memoryRecordId as makeMemoryRecordId, newId, OsError, correlationFor } from "@xiling/os-domain";
import type { AgentId, MemoryProvenance, MemoryRecord, MemoryRecordId, MemorySearchHit, MemoryType, OSOperationContext } from "@xiling/os-domain";
import type { KernelServices } from "./kernel-services.js";
import type { OSKernel } from "./kernel.js";

export interface MemoryWriteCandidate {
  agentId: AgentId;
  type: MemoryType;
  content: unknown;
  dedupeKey: string;
  provenance: MemoryProvenance;
  confidence?: number | undefined;
  sensitivity?: string[] | undefined;
  expiresAt?: string | undefined;
  /** MemoryPolicy.readOnly = true 的 Agent 禁止写入 */
}

export class MemoryService {
  constructor(
    private readonly kernel: OSKernel,
    private readonly services: KernelServices,
  ) {}

  /** Human review, not model retrieval: do not hide records behind a search hit limit. */
  listForReview(agentId: AgentId): MemoryRecord[] {
    this.services.agents.get(agentId);
    return [...this.services.projection.memories.values()].filter((record) => record.agentId === agentId && record.supersededBy === undefined).map((record) => structuredClone(record));
  }

  /** 写管道：Memory Policy → Deduplication → supersede 旧记录 → persist */
  async write(candidate: MemoryWriteCandidate, ctx?: OSOperationContext | undefined): Promise<MemoryRecord> {
    const definition = this.services.agents.get(candidate.agentId);
    if (definition.memoryPolicy.readOnly === true) {
      throw new OsError("memory_policy_denied", `agent ${candidate.agentId} memory is read-only`);
    }
    if (candidate.confidence !== undefined && (!Number.isFinite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 1)) {
      throw new OsError("invalid_command", "memory confidence must be between 0 and 1");
    }
    if (candidate.provenance.origin === "task" && candidate.provenance.sourceTaskId === undefined) {
      throw new OsError("invalid_command", "task memory requires sourceTaskId provenance");
    }
    if (candidate.provenance.sourceTaskId !== undefined && !this.services.projection.tasks.has(candidate.provenance.sourceTaskId)) {
      throw new OsError("entity_not_found", `source task not found: ${candidate.provenance.sourceTaskId}`);
    }
    if (candidate.provenance.sourceArtifactId !== undefined && !this.services.projection.artifacts.has(candidate.provenance.sourceArtifactId)) {
      throw new OsError("entity_not_found", `source artifact not found: ${candidate.provenance.sourceArtifactId}`);
    }
    // 去重：同 agent 同 dedupeKey 的现存记录被新记录取代（memory.superseded，保留可追溯）
    const superseded = [...this.services.projection.memories.values()].find((record) =>
      record.agentId === candidate.agentId && record.dedupeKey === candidate.dedupeKey && record.supersededBy === undefined,
    );
    const record: MemoryRecord = {
      id: makeMemoryRecordId(newId("mem")),
      agentId: candidate.agentId,
      type: candidate.type,
      content: candidate.content,
      dedupeKey: candidate.dedupeKey,
      provenance: candidate.provenance,
      confidence: candidate.confidence,
      sensitivity: candidate.sensitivity,
      expiresAt: candidate.expiresAt,
      createdAt: new Date().toISOString(),
    };
    this.kernel.emit("memory.created", { record }, correlationFor({ agentId: candidate.agentId }), ctx);
    if (superseded) {
      this.kernel.emit("memory.superseded", { supersededId: superseded.id, byId: record.id }, correlationFor({ agentId: candidate.agentId }), ctx);
    }
    return record;
  }

  /** 命名空间内搜索（标题/内容字符串匹配；向量检索是未来 persistence 层的事） */
  search(agentId: AgentId, query: string, type?: MemoryType | undefined): MemoryRecord[] {
    return this.retrieve(agentId, query, type === undefined ? {} : { type }).map((hit) => hit.record);
  }

  /** 有证据的检索结果：相关度、置信度、时效与来源同时返回。 */
  retrieve(agentId: AgentId, query: string, options: { type?: MemoryType; limit?: number; now?: Date } = {}): MemorySearchHit[] {
    const needle = query.trim().toLocaleLowerCase();
    const terms = [...new Set(needle.split(/[\s,，。；;:：!?！？]+/u).filter(Boolean))].slice(0, 16);
    const now = options.now ?? new Date();
    const limit = Math.max(1, Math.min(50, options.limit ?? 8));
    return [...this.services.projection.memories.values()]
      .filter((record) => record.agentId === agentId && record.supersededBy === undefined)
      .filter((record) => options.type === undefined || record.type === options.type)
      .filter((record) => record.expiresAt === undefined || Date.parse(record.expiresAt) > now.getTime())
      .flatMap((record): MemorySearchHit[] => {
        const haystack = `${record.dedupeKey} ${JSON.stringify(record.content)}`.toLocaleLowerCase();
        const matchedTerms = terms.filter((term) => haystack.includes(term));
        if (needle !== "" && !haystack.includes(needle) && matchedTerms.length === 0) return [];
        const exact = needle !== "" && haystack.includes(needle) ? 0.55 : 0;
        const coverage = terms.length === 0 ? 0.5 : (matchedTerms.length / terms.length) * 0.45;
        const ageDays = Math.max(0, Math.floor((now.getTime() - Date.parse(record.createdAt)) / 86_400_000));
        const agingAfter = record.type === "episodic" ? 30 : record.type === "procedural" ? 180 : 365;
        const confidence = record.confidence ?? (record.provenance.origin === "user" ? 0.95 : record.provenance.origin === "task" ? 0.8 : 0.65);
        return [{
          record: structuredClone(record),
          relevance: Math.min(1, exact + coverage), confidence,
          freshness: { status: ageDays > agingAfter ? "aging" : "current", ageDays, expiresAt: record.expiresAt },
          matchedTerms, retrievedAt: now.toISOString(),
        }];
      })
      .sort((a, b) => b.relevance - a.relevance || b.confidence - a.confidence || b.record.createdAt.localeCompare(a.record.createdAt))
      .slice(0, limit);
  }

  get(recordId: string): MemoryRecord {
    const record = this.services.projection.memories.get(makeMemoryRecordId(recordId));
    if (!record) throw new OsError("entity_not_found", `memory record not found: ${recordId}`);
    return record;
  }

  /** 记忆导出：跨 Agent 共享信息的唯一合法通道（memory.export → Context Artifact → A2A） */
  async exportForDelegation(agentId: AgentId, recordIds: string[], ctx?: OSOperationContext | undefined): Promise<MemoryRecord[]> {
    return recordIds.map((id) => {
      const record = this.get(id);
      if (record.agentId !== agentId) {
        throw permissionDeniedFor(agentId, id);
      }
      return record;
    });
  }

  async delete(recordIdValue: string, reason: string, ctx?: OSOperationContext | undefined): Promise<void> {
    this.get(recordIdValue);
    this.kernel.emit("memory.deleted", { recordId: makeMemoryRecordId(recordIdValue), reason }, {}, ctx);
  }
}

import { permissionDenied } from "@xiling/os-domain";
function permissionDeniedFor(agentId: AgentId, recordId: string): OsError {
  return permissionDenied(`agent ${agentId} cannot export memory record ${recordId} owned by another agent`);
}
