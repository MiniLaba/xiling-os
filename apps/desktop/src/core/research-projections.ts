import path from "node:path";
import { LadybugResearchGraphStore, knowledgeRecordToChangeSet } from "@xiling/research-graph";
import type { ResearchGraphProjection } from "@xiling/contracts";
import type { KnowledgeService } from "@xiling/knowledge";

/** Same projection function as HTTP host; retryable durable outbox, no dual writes. */
export class ResearchProjectionHost {
  private store: LadybugResearchGraphStore;
  private pending: Promise<void> = Promise.resolve();
  constructor(root: string, private knowledge: KnowledgeService) { this.store = new LadybugResearchGraphStore(path.join(root, "research-graph.lbdb")); }
  flush(): Promise<void> {
    const run = async () => {
      await this.store.initialize();
      for (;;) {
        const batch = this.knowledge.listProjectionOutbox(100);
        if (!batch.length) return;
        for (const record of batch) {
          await this.store.applyProjection({ projectionKey: record.projectionKey, source: "knowledge", sourceId: record.sourceId, changeSet: knowledgeRecordToChangeSet(record, this.knowledge.getProject(record.projectId)) });
          this.knowledge.markProjectionOutboxApplied([record.projectionKey]);
        }
      }
    };
    this.pending = this.pending.catch(() => {}).then(run);
    return this.pending;
  }

  /**
   * 只读某项目的科研图谱投影（科研关系与证据，不是发现图，也不是画布布局）。
   * 先尝试把待处理的 outbox 投影完；投影失败时**如实返回错误**，调用方据此显示
   * "待投影"而不是把一个空图当成"没有关系"。
   */
  async read(projectId: string): Promise<{ projection: ResearchGraphProjection; flushError?: string | undefined }> {
    let flushError: string | undefined;
    try { await this.flush(); }
    catch (error) { flushError = error instanceof Error ? error.message : String(error); }
    await this.store.initialize();
    const projection = await this.store.getProjection(projectId);
    return flushError === undefined ? { projection } : { projection, flushError };
  }

  async close() { await this.pending.catch(() => {}); await this.store.close(); }
}
