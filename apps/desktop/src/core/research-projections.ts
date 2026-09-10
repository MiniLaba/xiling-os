import path from "node:path";
import { LadybugResearchGraphStore, knowledgeRecordToChangeSet } from "@xiling/research-graph";
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
  async close() { await this.pending.catch(() => {}); await this.store.close(); }
}
