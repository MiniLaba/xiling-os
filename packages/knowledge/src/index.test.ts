import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { KnowledgeService } from "./index.js";
import { KNOWLEDGE_SCHEMA_VERSION } from "./migrations.js";

const systemProjectId = "free-exploration";

describe("knowledge service smoke", () => {
  it("starts with only the generic research entry and no demonstration content", async () => {
    const root = await mkdtemp(join(tmpdir(), "xiling-generic-seed-"));
    const service = new KnowledgeService(join(root, "knowledge.sqlite"));
    expect(service.listProjects()).toMatchObject([{ id: systemProjectId, domainIds: ["general-science"], name: "自由探索" }]);
    expect(service.listItems(systemProjectId)).toHaveLength(0);
    expect(service.listWikiPages(systemProjectId)).toHaveLength(0);
    expect(service.listEvidence(systemProjectId)).toHaveLength(0);
    service.close();
  });

  it("persists projects, item state, immutable wiki revisions and backlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "xiling-knowledge-"));
    const path = join(root, "knowledge.sqlite");
    const first = new KnowledgeService(path);
    const project = first.createProject({ name: "边缘海实验", description: "fixture", researchQuestion: "层结如何变化？", domainIds: ["ocean-climate"] });
    const task = first.createItem(project.id, { kind: "task", title: "检查剖面", notes: "QC" });
    expect(first.updateItem(task.id, { status: "done" })?.status).toBe("done");
    const target = first.createWikiPage({ projectId: project.id, title: "数据方法", markdown: "# 数据方法" });
    const source = first.createWikiPage({ projectId: project.id, title: "研究结论", markdown: `参考 [[${target.slug}]]` });
    expect(first.getWikiPage(target.id)?.backlinks).toMatchObject([{ id: source.id }]);
    expect(first.reviseWikiPage(source.id, { markdown: `再次参考 [[${target.slug}]]` })?.revisionCount).toBe(2);
    expect(first.searchWikiPages(project.id, "再次参考")).toMatchObject([{ pageId: source.id, version: 2 }]);
    expect(first.restoreWikiRevision(source.id, 1)).toMatchObject({ revisionCount: 3, currentRevision: { version: 3, markdown: expect.stringContaining("参考") } });
    first.close();

    const migrated = new DatabaseSync(path);
    expect((migrated.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(KNOWLEDGE_SCHEMA_VERSION);
    migrated.close();

    const restored = new KnowledgeService(path);
    expect(restored.listProjects().some((item) => item.id === project.id)).toBe(true);
    expect(restored.getWikiPage(source.id)?.revisions.map((item) => item.version)).toEqual([3, 2, 1]);
    restored.close();
  });

  it("deduplicates retries while allowing one paper to support multiple claims", async () => {
    const root = await mkdtemp(join(tmpdir(), "xiling-evidence-"));
    const service = new KnowledgeService(join(root, "knowledge.sqlite"));
    const paper = { id: "paper-1", title: "Ocean paper", year: 2024, authors: ["Lin"], citationCount: 4, references: [], source: "fixture" as const };
    expect(service.saveEvidence(systemProjectId, paper).id).toBe(service.saveEvidence(systemProjectId, paper).id);
    service.saveEvidence(systemProjectId, paper, "另一主张", "supports", 0.8, { sourceQuote: "Observed warming persisted.", limitations: "regional", claimRevisionId: "claim:2:r1" });
    expect(service.listEvidence()).toHaveLength(2);
    service.close();
  });

  it("commits projection outbox records with source mutations and persists acknowledgements", async () => {
    const root = await mkdtemp(join(tmpdir(), "xiling-knowledge-outbox-"));
    const path = join(root, "knowledge.sqlite");
    const first = new KnowledgeService(path);
    const project = first.createProject({ name: "Outbox 项目", description: "atomic", researchQuestion: "投影是否耐久？", domainIds: ["general-science"] });
    const projectEvent = first.listProjectionOutbox().find((event) => event.projectId === project.id && event.eventType === "knowledge.project.upserted");
    expect(projectEvent).toMatchObject({ sourceId: project.id, payload: { name: "Outbox 项目" } });
    expect(first.markProjectionOutboxApplied([projectEvent!.projectionKey])).toBe(1);
    expect(first.listProjectionOutbox().some((event) => event.projectionKey === projectEvent!.projectionKey)).toBe(false);
    first.close();

    const reopened = new KnowledgeService(path);
    expect(reopened.listProjectionOutbox().some((event) => event.projectionKey === projectEvent!.projectionKey)).toBe(false);
    reopened.close();
  });

  it("persists project-scoped chat session directories and Research Graph selections", async () => {
    const root = await mkdtemp(join(tmpdir(), "xiling-chat-history-"));
    const path = join(root, "knowledge.sqlite");
    const first = new KnowledgeService(path);
    const project = first.createProject({ name: "海气耦合", description: "fixture", researchQuestion: "风应力如何响应？", domainIds: ["ocean-climate"] });
    const session = first.createChatSession(project.id, "检查风应力资料");
    first.setChatSessionContext(session.id, { projectId: project.id, activeNodeId: "response-1", quotedNodeIds: ["paper-1", "paper-1"] });
    expect(first.listChatSessions(project.id)).toMatchObject([{ id: session.id, messageCount: 0, preview: "", canvasContext: { activeNodeId: "response-1", quotedNodeIds: ["paper-1"] } }]);
    expect(first.listChatSessions(systemProjectId)).toHaveLength(0);
    first.close();

    const restored = new KnowledgeService(path);
    expect(restored.getChatSessionContext(session.id)).toMatchObject({ projectId: project.id, activeNodeId: "response-1", quotedNodeIds: ["paper-1"] });
    restored.close();
  });

  it("persists, replaces and invalidates context capsules", async () => {
    const root = await mkdtemp(join(tmpdir(), "xiling-context-capsules-"));
    const path = join(root, "knowledge.sqlite");
    const first = new KnowledgeService(path);
    const capsule = { id: `node:${systemProjectId}:n1`, sourceNodeId: "n1", sourceRevision: "r1", summary: "第一版", claims: ["结论"], artifactUris: ["artifact://plot" as const], layer: "node" as const, coveredNodeIds: ["n1"] };
    first.upsertContextCapsule(systemProjectId, capsule);
    first.upsertContextCapsule(systemProjectId, { ...capsule, sourceRevision: "r2", summary: "第二版" });
    first.close();
    const restored = new KnowledgeService(path);
    expect(restored.listContextCapsules(systemProjectId)).toMatchObject([{ sourceRevision: "r2", summary: "第二版" }]);
    expect(restored.pruneContextCapsules(systemProjectId, [])).toBe(1);
    expect(restored.listContextCapsules(systemProjectId)).toHaveLength(0);
    restored.close();
  });
});
