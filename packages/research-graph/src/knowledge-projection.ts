import { createHash } from "node:crypto";
import type { EvidenceRecord, ResearchProject, ResearchEntityStatus, WikiPageRevision } from "@xiling/contracts";
import type { ResearchProjectionOutboxRecord } from "@xiling/knowledge";
import type { ResearchGraphChangeSet, ResearchGraphEntityInput, ResearchGraphRelationInput, ResearchGraphStore } from "./index.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);
const questionId = (projectId: string) => `research-question:${projectId}`;
const artifactId = (uri: string) => `artifact:${digest(uri)}`;
const artifactVersionId = (uri: string) => `artifact-version:${digest(uri)}`;
const compact = (value: string, limit = 360) => {
  const normalized = value.replace(/^#+\s+/gmu, "").replace(/\s+/gu, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
};

class ChangeSetBuilder {
  private readonly nodes = new Map<string, ResearchGraphEntityInput>();
  private readonly relations = new Map<string, ResearchGraphRelationInput>();
  constructor(readonly projectId: string) {}
  node(node: Omit<ResearchGraphEntityInput, "projectId">): string {
    this.nodes.set(node.id, { ...node, projectId: this.projectId });
    return node.id;
  }
  relation(kind: ResearchGraphRelationInput["kind"], sourceId: string, targetId: string, properties: Record<string, unknown> = {}): void {
    this.relations.set(`${kind}\u001f${sourceId}\u001f${targetId}`, { projectId: this.projectId, kind, sourceId, targetId, properties });
  }
  build(): ResearchGraphChangeSet { return { projectId: this.projectId, nodes: [...this.nodes.values()], relations: [...this.relations.values()] }; }
}

function addProject(builder: ChangeSetBuilder, project: ResearchProject): void {
  builder.node({ id: project.id, kind: "Project", title: project.name, summary: project.description, status: project.status === "paused" ? "pending" : project.status, properties: {}, createdAt: project.createdAt, updatedAt: project.updatedAt });
  const rq = builder.node({ id: questionId(project.id), kind: "ResearchQuestion", title: project.researchQuestion, summary: project.researchQuestion, status: "active", properties: {}, createdAt: project.createdAt, updatedAt: project.updatedAt });
  builder.relation("CONTAINS", project.id, rq);
}

function addArtifact(
  builder: ChangeSetBuilder,
  uri: string,
  createdAt: string,
  extra: { title?: string; summary?: string; properties?: Record<string, unknown> } = {},
): string {
  const artifact = artifactId(uri);
  const version = artifactVersionId(uri);
  // 标题默认取 URI 末段：对 artifact://<id>/version/<n> 来说是版本号，几乎不可读。
  // 调用方知道真实名字时必须传 title，否则图里会出现一堆叫 "1" 的节点。
  const fallback = uri.split("/").at(-1) ?? "Artifact";
  const title = extra.title ?? fallback;
  builder.node({ id: artifact, kind: "Artifact", title, summary: extra.summary ?? "受管科研产物", status: "available", uri, properties: { uri }, createdAt, updatedAt: createdAt });
  builder.node({ id: version, kind: "ArtifactVersion", title: title === fallback ? `${fallback}（版本）` : title, summary: extra.summary ?? "可复现的产物版本", status: "available", uri, sourceLocator: uri, properties: { uri, ...(extra.properties ?? {}) }, createdAt, updatedAt: createdAt });
  builder.relation("HAS_VERSION", artifact, version);
  return version;
}

export interface ScienceArtifactsPayload {
  executionId: string;
  adapterId: string;
  planHash: string;
  recipe: { id: string; version: string };
  artifacts: Array<{ name: string; uri: string; sha256: string; kind: string; mimeType: string }>;
  createdAt?: string;
}

export function knowledgeRecordToChangeSet(record: ResearchProjectionOutboxRecord, currentProject?: ResearchProject): ResearchGraphChangeSet {
  const builder = new ChangeSetBuilder(record.projectId);
  if (record.eventType === "knowledge.project.upserted") {
    addProject(builder, record.payload as ResearchProject);
    return builder.build();
  }
  if (!currentProject) throw new Error(`Knowledge projection requires project ${record.projectId}`);
  addProject(builder, currentProject);
  if (record.eventType === "knowledge.wiki.revision.created") {
    const payload = record.payload as { page: { id: string; projectId: string; slug: string; title: string; createdAt: string; updatedAt: string }; revision: WikiPageRevision };
    const wiki = builder.node({
      id: `wiki-revision:${payload.revision.id}`,
      kind: "WikiRevisionRef",
      title: `${payload.page.title} · v${payload.revision.version}`,
      summary: compact(payload.revision.markdown),
      revision: payload.revision.version,
      sourceLocator: `wiki://${payload.page.id}/revisions/${payload.revision.version}`,
      properties: { pageId: payload.page.id, slug: payload.page.slug, markdownHash: digest(payload.revision.markdown) },
      createdAt: payload.revision.createdAt,
      updatedAt: payload.revision.createdAt,
    });
    builder.relation("CONTAINS", record.projectId, wiki);
    builder.relation("DOCUMENTS", wiki, questionId(record.projectId));
    // 只建立引用边，**不**在这里重建产物节点。
    //
    // 产物节点的唯一所有者是"产物登记"投影（knowledge.science.artifacts.registered）。
    // 早先这里调用 addArtifact 重建节点，于是同一份产物被两个投影各写一次不可变
    // ArtifactVersion：第二个投影因内容哈希不同被不可变守卫拒绝，整批变更回滚，
    // wiki 页面永远进不了图、outbox 永久 pending。引用方不该重定义事实。
    for (const uri of payload.revision.artifactUris) builder.relation("REFERENCES", wiki, artifactVersionId(uri));
    return builder.build();
  }
  // 科研计算产出：让"哪次执行、用哪个计划哈希、在哪种隔离里跑出来"在图里可追溯。
  if (record.eventType === "knowledge.science.artifacts.registered") {
    const payload = record.payload as ScienceArtifactsPayload;
    const createdAt = payload.createdAt ?? record.createdAt;
    for (const artifact of payload.artifacts) {
      const version = addArtifact(builder, artifact.uri, createdAt, {
        title: artifact.name,
        summary: `${payload.recipe.id}@${payload.recipe.version} 由 ${payload.adapterId} 隔离执行产出`,
        properties: {
          executionId: payload.executionId,
          adapterId: payload.adapterId,
          planHash: payload.planHash,
          recipe: `${payload.recipe.id}@${payload.recipe.version}`,
          sha256: artifact.sha256,
          kind: artifact.kind,
          mimeType: artifact.mimeType,
        },
      });
      builder.relation("CONTAINS", record.projectId, artifactId(artifact.uri));
      // 这次计算是针对本项目研究问题的：与证据断言一样指向研究问题，便于从问题追到计算
      builder.relation("EVALUATES", version, questionId(record.projectId));
    }
    return builder.build();
  }
  const evidence = record.payload as EvidenceRecord;
  const paper = builder.node({
    id: `paper:${evidence.paper.id}`,
    kind: "Paper",
    title: evidence.paper.title,
    summary: `${evidence.paper.authors.join(", ")} · ${evidence.paper.year}`,
    ...(evidence.paper.url ? { sourceLocator: evidence.paper.url } : {}),
    properties: { paperId: evidence.paper.id, year: evidence.paper.year, authors: evidence.paper.authors, citationCount: evidence.paper.citationCount, provider: evidence.paper.source, abstract: evidence.paper.abstract },
    createdAt: evidence.createdAt,
    updatedAt: evidence.createdAt,
  });
  const fragment = builder.node({
    id: `source-fragment:${evidence.id}`,
    kind: "SourceFragment",
    title: `证据摘录 · ${evidence.paper.title}`,
    summary: compact(evidence.sourceQuote || evidence.note || "已固定到项目证据库，尚未添加阅读标注。"),
    ...(evidence.sourceLocator || evidence.paper.url ? { sourceLocator: evidence.sourceLocator ?? evidence.paper.url } : {}),
    properties: { evidenceRecordId: evidence.id, note: evidence.note, sourceQuote: evidence.sourceQuote, limitations: evidence.limitations },
    createdAt: evidence.createdAt,
    updatedAt: evidence.createdAt,
  });
  const assertion = builder.node({
    id: `evidence-assertion:${evidence.id}`,
    kind: "EvidenceAssertion",
    title: `${evidenceStanceLabel(evidence.stance)} · ${evidence.paper.title}`,
    summary: compact(evidence.note || "尚未添加阅读标注。"),
    stance: evidence.stance,
    confidence: evidence.confidence,
    properties: { evidenceRecordId: evidence.id, paperId: evidence.paper.id, limitations: evidence.limitations },
    createdAt: evidence.createdAt,
    updatedAt: evidence.createdAt,
  });
  builder.relation("CONTAINS", record.projectId, paper);
  builder.relation("CONTAINS", record.projectId, assertion);
  builder.relation("HAS_FRAGMENT", paper, fragment);
  builder.relation("BASED_ON", assertion, fragment);
  if (evidence.claimRevisionId) builder.relation("ASSERTS", assertion, evidence.claimRevisionId);
  builder.relation("EVALUATES", assertion, questionId(record.projectId));
  return builder.build();
}

function evidenceStanceLabel(stance: EvidenceRecord["stance"]): string {
  switch (stance) {
    case "supports": return "支持";
    case "refutes": return "反驳";
    case "qualifies": return "限定";
    case "insufficient": return "证据尚不充分";
  }
}
