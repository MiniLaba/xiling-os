import type { EvidenceRecord, ResearchEntityKind, ResearchGraphEntity, ResearchGraphRelation, ResearchRelationKind, WikiPageDetail, WikiSearchResult } from "@xiling/contracts";
import type { ResearchGraphStore } from "@xiling/research-graph";
import type { KnowledgeStore } from "@xiling/knowledge";
import type { SourceContentResolver } from "../../source-content-resolver.js";
import type { ResearchGraphProposalStore } from "../research-graph/proposal-store.js";

export const FORMAL_ENTITY_KINDS = new Set<ResearchEntityKind>(["Claim", "ClaimRevision", "EvidenceAssertion"]);

export type BrainHitKind = "note" | "chat" | "paper" | "chart" | "report" | "entity";

export interface BrainHit {
  id: string;
  kind: BrainHitKind;
  title: string;
  excerpt: string;
  locator?: string | undefined;
}

export function relationNeedsDecision(sourceKind: string, targetKind: string): boolean {
  return FORMAL_ENTITY_KINDS.has(sourceKind as ResearchEntityKind) || FORMAL_ENTITY_KINDS.has(targetKind as ResearchEntityKind);
}

export function textHits(query: string, text: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  return needle.length > 0 && text.toLocaleLowerCase().includes(needle);
}

export function excerptAround(text: string, query: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const needle = query.trim().toLocaleLowerCase();
  const hit = flat.toLocaleLowerCase().indexOf(needle);
  const start = Math.max(0, hit < 0 ? 0 : hit - 70);
  return `${start > 0 ? "…" : ""}${flat.slice(start, start + 220)}${flat.length > start + 220 ? "…" : ""}`;
}

export function collectBrainHits(query: string, sources: {
  notes: WikiSearchResult[];
  chats: Array<{ id: string; text: string; createdAt: string }>;
  papers: EvidenceRecord[];
  entities: ResearchGraphEntity[];
}): BrainHit[] {
  const hits: BrainHit[] = [];
  for (const note of sources.notes) hits.push({ id: note.pageId, kind: "note", title: note.title, excerpt: note.excerpt, locator: `wiki://${note.pageId}` });
  for (const chat of sources.chats.filter((item) => textHits(query, item.text))) hits.push({ id: chat.id, kind: "chat", title: "聊天片段", excerpt: excerptAround(chat.text, query), locator: `agent-entry://${chat.id}` });
  for (const record of sources.papers) {
    const blob = `${record.paper.title} ${record.paper.abstract ?? ""} ${record.note} ${record.sourceQuote}`;
    if (!textHits(query, blob)) continue;
    hits.push({ id: record.id, kind: "paper", title: record.paper.title, excerpt: excerptAround(blob, query), locator: record.sourceLocator ?? record.paper.url });
  }
  for (const entity of sources.entities) {
    const blob = `${entity.title} ${entity.summary}`;
    if (!textHits(query, blob)) continue;
    const kind: BrainHitKind = entity.kind === "Artifact" || entity.kind === "ArtifactVersion"
      ? (/图|chart|figure/i.test(entity.title) ? "chart" : "report")
      : "entity";
    hits.push({ id: entity.id, kind, title: entity.title, excerpt: excerptAround(blob, query), locator: entity.sourceLocator ?? entity.uri });
  }
  return hits.slice(0, 40);
}

export interface BrainServiceDependencies {
  knowledge: KnowledgeStore;
  graph: ResearchGraphStore;
  graphReady: Promise<unknown>;
  sources: SourceContentResolver;
  proposals: ResearchGraphProposalStore;
  searchChat(projectId: string, query: string): Array<{ id: string; text: string; createdAt: string }>;
}

export class BrainService {
  constructor(private readonly dependencies: BrainServiceDependencies) {}

  async search(projectId: string, query: string): Promise<BrainHit[]> {
    await this.dependencies.graphReady;
    const projection = await this.dependencies.graph.getProjection(projectId, "all");
    return collectBrainHits(query, {
      notes: this.dependencies.knowledge.searchWikiPages(projectId, query, 12),
      chats: this.dependencies.searchChat(projectId, query),
      papers: this.dependencies.knowledge.listEvidence(projectId),
      entities: projection.nodes,
    });
  }

  async readSource(projectId: string, entityId: string) {
    await this.dependencies.graphReady;
    const entity = await this.dependencies.graph.getEntity(projectId, entityId);
    if (!entity) return undefined;
    return this.dependencies.sources.resolve(projectId, entity);
  }

  saveNote(input: { projectId: string; title: string; markdown: string; pageId?: string | undefined }): WikiPageDetail {
    if (input.pageId) {
      const revised = this.dependencies.knowledge.reviseWikiPage(input.pageId, { markdown: input.markdown, title: input.title });
      if (!revised || revised.projectId !== input.projectId) throw new Error("Wiki page not found");
      return revised;
    }
    return this.dependencies.knowledge.createWikiPage({ projectId: input.projectId, title: input.title, markdown: input.markdown });
  }

  async neighborhood(projectId: string, focusId?: string): Promise<{ focusId: string; nodes: ResearchGraphEntity[]; relations: ResearchGraphRelation[] }> {
    await this.dependencies.graphReady;
    const projection = await this.dependencies.graph.getProjection(projectId, "all");
    const focus = focusId && projection.nodes.some((node) => node.id === focusId) ? focusId : `research-question:${projectId}`;
    const relations = projection.relations.filter((relation) => relation.sourceId === focus || relation.targetId === focus);
    const ids = new Set<string>([focus, ...relations.flatMap((relation) => [relation.sourceId, relation.targetId])]);
    return { focusId: focus, nodes: projection.nodes.filter((node) => ids.has(node.id)), relations };
  }

  async link(projectId: string, input: { kind: ResearchRelationKind; sourceId: string; targetId: string; summary?: string | undefined }) {
    await this.dependencies.graphReady;
    const source = await this.dependencies.graph.getEntity(projectId, input.sourceId);
    const target = await this.dependencies.graph.getEntity(projectId, input.targetId);
    if (!source || !target) throw new Error("Relation endpoint not found");
    if (relationNeedsDecision(source.kind, target.kind)) {
      const proposal = this.dependencies.proposals.create(projectId, {
        type: "link_relation",
        kind: input.kind,
        sourceId: input.sourceId,
        targetId: input.targetId,
        summary: input.summary?.trim() || `${source.title} ${input.kind} ${target.title}`,
      });
      return { status: "needs-decision" as const, proposal };
    }
    await this.dependencies.graph.applyChangeSet({
      projectId,
      nodes: [],
      relations: [{ projectId, kind: input.kind, sourceId: input.sourceId, targetId: input.targetId }],
    });
    return { status: "linked" as const, kind: input.kind, sourceId: input.sourceId, targetId: input.targetId };
  }
}
