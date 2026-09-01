import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { and, asc, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-sqlite";
import { FREE_EXPLORATION_PROJECT_ID, type CanvasBranchContext, type ChatSessionSummary, type ContextCapsule, type EvidenceRecord, type ResearchProject, type PaperRecord, type ProjectItem, type ProjectItemKind, type ProjectItemStatus, type ProjectStatus, type ResourceUri, type WikiPageDetail, type WikiPageRevision, type WikiPageSummary, type WikiSearchResult } from "@xiling/contracts";
import { chatSessionContexts, chatSessions, contextCapsules, evidence, projectItems, projects, wikiPages, wikiRevisions } from "./schema.js";
import { KNOWLEDGE_SCHEMA_VERSION, runKnowledgeMigrations } from "./migrations.js";
import type { KnowledgeStore, ResearchProjectionOutboxRecord } from "./ports.js";

const DEFAULT_PROJECT_ID = FREE_EXPLORATION_PROJECT_ID;
const now = () => new Date().toISOString();

function slugify(title: string): string {
  return title.trim().toLocaleLowerCase().replace(/\s+/g, "-").replace(/[^\p{L}\p{N}-]+/gu, "").replace(/-+/g, "-") || `page-${randomUUID().slice(0, 8)}`;
}

function projectFromRow(row: typeof projects.$inferSelect): ResearchProject {
  return { ...row, domainIds: JSON.parse(row.domainIds) as string[], status: row.status as ProjectStatus };
}

function itemFromRow(row: typeof projectItems.$inferSelect): ProjectItem {
  return { ...row, kind: row.kind as ProjectItemKind, status: row.status as ProjectItemStatus };
}

function revisionFromRow(row: typeof wikiRevisions.$inferSelect): WikiPageRevision {
  return { ...row, artifactUris: JSON.parse(row.artifactUris) as ResourceUri[] };
}

/** 数据库即将跨 schema 版本迁移时，先把现有库文件（含 WAL/SHM）备份到同级 backups/ 目录，保留最近 5 份。 */
function backupSqliteBeforeMigration(path: string, latestVersion: number): void {
  if (!existsSync(path)) return;
  let current = 0;
  try {
    const probe = new DatabaseSync(path, { readOnly: true });
    current = (probe.prepare("PRAGMA user_version").get() as { user_version: number }).user_version ?? 0;
    probe.close();
  } catch {
    return;
  }
  if (current >= latestVersion) return;
  const backupDir = join(dirname(path), "backups");
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = basename(path);
  for (const suffix of ["", "-wal", "-shm"] as const) {
    const source = `${path}${suffix}`;
    if (existsSync(source)) copyFileSync(source, join(backupDir, `${base}${suffix}.${stamp}.bak`));
  }
  const backups = readdirSync(backupDir).filter((name) => name.startsWith(`${base}.`) && name.endsWith(".bak")).sort();
  for (const name of backups.slice(0, Math.max(0, backups.length - 5))) rmSync(join(backupDir, name));
}

export class KnowledgeService implements KnowledgeStore {
  private readonly sqlite: DatabaseSync;
  private readonly db;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    backupSqliteBeforeMigration(path, KNOWLEDGE_SCHEMA_VERSION);
    this.sqlite = new DatabaseSync(path);
    this.sqlite.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    runKnowledgeMigrations(this.sqlite);
    this.db = drizzle({ client: this.sqlite });
    this.seed();
  }

  close(): void { this.sqlite.close(); }

  listProjects(): ResearchProject[] {
    return this.db.select().from(projects).orderBy(desc(projects.updatedAt)).all().map(projectFromRow);
  }

  getProject(id: string): ResearchProject | undefined {
    const row = this.db.select().from(projects).where(eq(projects.id, id)).get();
    return row ? projectFromRow(row) : undefined;
  }

  createProject(input: { id?: string; name: string; description: string; researchQuestion: string; domainIds: string[] }): ResearchProject {
    const timestamp = now();
    const value: typeof projects.$inferInsert = { id: input.id ?? randomUUID(), name: input.name, description: input.description, researchQuestion: input.researchQuestion, domainIds: JSON.stringify(input.domainIds), status: "active", createdAt: timestamp, updatedAt: timestamp };
    const project = projectFromRow(value as typeof projects.$inferSelect);
    this.transaction(() => {
      this.db.insert(projects).values(value).run();
      this.enqueueProjection(project.id, project.id, "knowledge.project.upserted", project, timestamp);
    });
    return project;
  }

  updateProject(id: string, patch: Partial<Pick<ResearchProject, "name" | "description" | "researchQuestion" | "domainIds" | "status">>): ResearchProject | undefined {
    const timestamp = now();
    let project: ResearchProject | undefined;
    this.transaction(() => {
      const { domainIds, ...plainPatch } = patch;
      const result = this.db.update(projects).set({ ...plainPatch, ...(domainIds ? { domainIds: JSON.stringify(domainIds) } : {}), updatedAt: timestamp }).where(eq(projects.id, id)).run();
      if (!result.changes) return;
      const row = this.db.select().from(projects).where(eq(projects.id, id)).get();
      if (!row) return;
      project = projectFromRow(row);
      this.enqueueProjection(id, id, "knowledge.project.upserted", project, timestamp);
    });
    return project;
  }

  listItems(projectId: string): ProjectItem[] {
    return this.db.select().from(projectItems).where(eq(projectItems.projectId, projectId)).orderBy(asc(projectItems.createdAt)).all().map(itemFromRow);
  }

  createItem(projectId: string, input: { kind: ProjectItemKind; title: string; notes: string }): ProjectItem {
    const timestamp = now();
    const value: typeof projectItems.$inferInsert = { id: randomUUID(), projectId, ...input, status: "backlog", createdAt: timestamp, updatedAt: timestamp };
    this.db.insert(projectItems).values(value).run();
    return itemFromRow(value as typeof projectItems.$inferSelect);
  }

  updateItem(id: string, patch: Partial<Pick<ProjectItem, "title" | "notes" | "status">>): ProjectItem | undefined {
    this.db.update(projectItems).set({ ...patch, updatedAt: now() }).where(eq(projectItems.id, id)).run();
    const row = this.db.select().from(projectItems).where(eq(projectItems.id, id)).get();
    return row ? itemFromRow(row) : undefined;
  }

  deleteItem(id: string): boolean {
    return this.db.delete(projectItems).where(eq(projectItems.id, id)).run().changes > 0;
  }

  listChatSessions(projectId: string): ChatSessionSummary[] {
    return this.db.select().from(chatSessions).where(and(eq(chatSessions.projectId, projectId), eq(chatSessions.archived, false))).orderBy(desc(chatSessions.updatedAt)).all().map((session) => {
      const canvasContext = this.getChatSessionContext(session.id);
      return { id: session.id, projectId: session.projectId, title: session.title, preview: "", messageCount: 0, ...(canvasContext ? { canvasContext } : {}), createdAt: session.createdAt, updatedAt: session.updatedAt };
    });
  }

  createChatSession(projectId: string, title: string): ChatSessionSummary {
    const timestamp = now();
    const value: typeof chatSessions.$inferInsert = { id: randomUUID(), projectId, title: title.trim() || "新对话", archived: false, createdAt: timestamp, updatedAt: timestamp };
    this.db.insert(chatSessions).values(value).run();
    return { id: value.id, projectId, title: value.title, preview: "", messageCount: 0, createdAt: timestamp, updatedAt: timestamp };
  }

  getChatSession(id: string): ChatSessionSummary | undefined {
    const session = this.db.select().from(chatSessions).where(and(eq(chatSessions.id, id), eq(chatSessions.archived, false))).get();
    if (!session) return undefined;
    return this.listChatSessions(session.projectId).find((item) => item.id === id);
  }

  archiveChatSession(id: string): boolean {
    return this.db.update(chatSessions).set({ archived: true, updatedAt: now() }).where(eq(chatSessions.id, id)).run().changes > 0;
  }

  getChatSessionContext(sessionId: string): CanvasBranchContext | undefined {
    const session = this.db.select().from(chatSessions).where(and(eq(chatSessions.id, sessionId), eq(chatSessions.archived, false))).get();
    if (!session) return undefined;
    const row = this.db.select().from(chatSessionContexts).where(eq(chatSessionContexts.sessionId, sessionId)).get();
    if (!row) return undefined;
    const parsed = JSON.parse(row.quotedNodeIds) as unknown;
    return { projectId: session.projectId, activeNodeId: row.activeNodeId, quotedNodeIds: Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [], updatedAt: row.updatedAt };
  }

  setChatSessionContext(sessionId: string, context: Omit<CanvasBranchContext, "updatedAt">): CanvasBranchContext {
    const session = this.db.select().from(chatSessions).where(and(eq(chatSessions.id, sessionId), eq(chatSessions.archived, false))).get();
    if (!session || session.projectId !== context.projectId) throw new Error("Chat session context project mismatch");
    const updatedAt = now();
    this.db.insert(chatSessionContexts).values({ sessionId, activeNodeId: context.activeNodeId, quotedNodeIds: JSON.stringify([...new Set(context.quotedNodeIds)]), updatedAt }).onConflictDoUpdate({ target: chatSessionContexts.sessionId, set: { activeNodeId: context.activeNodeId, quotedNodeIds: JSON.stringify([...new Set(context.quotedNodeIds)]), updatedAt } }).run();
    this.db.update(chatSessions).set({ updatedAt }).where(eq(chatSessions.id, sessionId)).run();
    return { ...context, quotedNodeIds: [...new Set(context.quotedNodeIds)], updatedAt };
  }

  listContextCapsules(projectId: string): ContextCapsule[] {
    return this.db.select().from(contextCapsules).where(eq(contextCapsules.projectId, projectId)).all().map((row) => ({
      id: row.id,
      sourceNodeId: row.sourceNodeId,
      sourceRevision: row.sourceRevision,
      summary: row.summary,
      claims: JSON.parse(row.claims) as string[],
      artifactUris: JSON.parse(row.artifactUris) as ResourceUri[],
      layer: row.layer as "node" | "branch",
      coveredNodeIds: JSON.parse(row.coveredNodeIds) as string[],
      updatedAt: row.updatedAt,
    }));
  }

  upsertContextCapsule(projectId: string, capsule: ContextCapsule): ContextCapsule {
    const updatedAt = now();
    const value: typeof contextCapsules.$inferInsert = {
      id: capsule.id,
      projectId,
      sourceNodeId: capsule.sourceNodeId,
      layer: capsule.layer ?? "node",
      sourceRevision: capsule.sourceRevision,
      summary: capsule.summary,
      claims: JSON.stringify(capsule.claims),
      artifactUris: JSON.stringify(capsule.artifactUris),
      coveredNodeIds: JSON.stringify(capsule.coveredNodeIds ?? [capsule.sourceNodeId]),
      updatedAt,
    };
    this.db.insert(contextCapsules).values(value).onConflictDoUpdate({ target: contextCapsules.id, set: value }).run();
    return { ...capsule, layer: capsule.layer ?? "node", coveredNodeIds: capsule.coveredNodeIds ?? [capsule.sourceNodeId], updatedAt };
  }

  pruneContextCapsules(projectId: string, validNodeIds: string[]): number {
    const valid = new Set(validNodeIds);
    let changes = 0;
    for (const capsule of this.listContextCapsules(projectId)) {
      const covered = capsule.coveredNodeIds ?? [capsule.sourceNodeId];
      if (covered.some((id) => !valid.has(id))) changes += Number(this.db.delete(contextCapsules).where(eq(contextCapsules.id, capsule.id)).run().changes);
    }
    return changes;
  }

  listWikiPages(projectId = DEFAULT_PROJECT_ID): WikiPageSummary[] {
    return this.db.select().from(wikiPages).where(and(eq(wikiPages.projectId, projectId), eq(wikiPages.archived, false))).orderBy(desc(wikiPages.updatedAt)).all().map((page) => ({
      id: page.id, projectId: page.projectId, slug: page.slug, title: page.title,
      revisionCount: this.db.select().from(wikiRevisions).where(eq(wikiRevisions.pageId, page.id)).all().length,
      updatedAt: page.updatedAt,
    }));
  }

  searchWikiPages(projectId: string, query: string, limit = 20): WikiSearchResult[] {
    const needle = query.trim().slice(0, 160);
    if (!needle) return [];
    const escaped = needle.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
    const pattern = `%${escaped}%`;
    const rows = this.sqlite.prepare(`
      SELECT p.id AS page_id, p.slug, p.title, p.updated_at, r.version, r.markdown
      FROM wiki_pages p
      JOIN wiki_revisions r ON r.page_id = p.id
      WHERE p.project_id = ? AND p.archived = 0
        AND r.version = (SELECT MAX(latest.version) FROM wiki_revisions latest WHERE latest.page_id = p.id)
        AND (p.title LIKE ? ESCAPE '\\' OR r.markdown LIKE ? ESCAPE '\\')
      ORDER BY p.updated_at DESC
      LIMIT ?
    `).all(projectId, pattern, pattern, Math.max(1, Math.min(limit, 50))) as Array<{ page_id: string; slug: string; title: string; updated_at: string; version: number; markdown: string }>;
    const normalizedNeedle = needle.toLocaleLowerCase();
    return rows.map((row) => {
      const flat = row.markdown.replace(/^#\s+.*$/m, "").replace(/\s+/g, " ").trim();
      const hit = flat.toLocaleLowerCase().indexOf(normalizedNeedle);
      const start = Math.max(0, hit < 0 ? 0 : hit - 70);
      const excerpt = `${start > 0 ? "…" : ""}${flat.slice(start, start + 220)}${flat.length > start + 220 ? "…" : ""}`;
      return { pageId: row.page_id, slug: row.slug, title: row.title, excerpt, version: row.version, updatedAt: row.updated_at };
    });
  }

  createWikiPage(input: { projectId?: string; title: string; markdown: string; artifactUris?: ResourceUri[] }): WikiPageDetail {
    const timestamp = now();
    const page = { id: randomUUID(), projectId: input.projectId ?? DEFAULT_PROJECT_ID, slug: slugify(input.title), title: input.title, archived: false, createdAt: timestamp, updatedAt: timestamp };
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      this.db.insert(wikiPages).values(page).run();
      const revision = this.insertRevision(page.id, 1, input.markdown, input.artifactUris ?? [], timestamp, page.title);
      this.enqueueProjection(page.projectId, revision.id, "knowledge.wiki.revision.created", { page, revision }, timestamp);
      this.sqlite.exec("COMMIT");
    } catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
    return this.getWikiPage(page.id)!;
  }

  getWikiPage(id: string): WikiPageDetail | undefined {
    const page = this.db.select().from(wikiPages).where(and(eq(wikiPages.id, id), eq(wikiPages.archived, false))).get();
    if (!page) return undefined;
    const revisions = this.db.select().from(wikiRevisions).where(eq(wikiRevisions.pageId, id)).orderBy(desc(wikiRevisions.version)).all().map(revisionFromRow);
    const backlinks = this.listWikiPages(page.projectId).filter((candidate) => candidate.id !== id).filter((candidate) => {
      const revision = this.db.select().from(wikiRevisions).where(eq(wikiRevisions.pageId, candidate.id)).orderBy(desc(wikiRevisions.version)).get();
      return revision?.markdown.includes(`[[${page.slug}]]`);
    }).map(({ id: backlinkId, slug, title }) => ({ id: backlinkId, slug, title }));
    return { id: page.id, projectId: page.projectId, slug: page.slug, title: page.title, revisionCount: revisions.length, updatedAt: page.updatedAt, currentRevision: revisions[0]!, revisions, backlinks };
  }

  reviseWikiPage(id: string, input: { markdown: string; artifactUris?: ResourceUri[]; title?: string }): WikiPageDetail | undefined {
    const page = this.db.select().from(wikiPages).where(eq(wikiPages.id, id)).get();
    if (!page || page.archived) return undefined;
    const latest = this.db.select().from(wikiRevisions).where(eq(wikiRevisions.pageId, id)).orderBy(desc(wikiRevisions.version)).get();
    const timestamp = now();
    const title = input.title ?? page.title;
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      this.db.update(wikiPages).set({ title, updatedAt: timestamp }).where(eq(wikiPages.id, id)).run();
      const revision = this.insertRevision(id, (latest?.version ?? 0) + 1, input.markdown, input.artifactUris ?? [], timestamp, title);
      this.enqueueProjection(page.projectId, revision.id, "knowledge.wiki.revision.created", { page: { ...page, title, updatedAt: timestamp }, revision }, timestamp);
      this.sqlite.exec("COMMIT");
    } catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
    return this.getWikiPage(id);
  }

  restoreWikiRevision(id: string, version: number): WikiPageDetail | undefined {
    const page = this.db.select().from(wikiPages).where(and(eq(wikiPages.id, id), eq(wikiPages.archived, false))).get();
    if (!page) return undefined;
    const revision = this.db.select().from(wikiRevisions).where(and(eq(wikiRevisions.pageId, id), eq(wikiRevisions.version, version))).get();
    if (!revision) return undefined;
    return this.reviseWikiPage(id, { markdown: revision.markdown, artifactUris: JSON.parse(revision.artifactUris) as ResourceUri[] });
  }

  archiveWikiPage(id: string): boolean {
    return this.db.update(wikiPages).set({ archived: true, updatedAt: now() }).where(eq(wikiPages.id, id)).run().changes > 0;
  }

  saveEvidence(projectId: string, paper: PaperRecord, note = "", stance: EvidenceRecord["stance"] = "insufficient", confidence = 0.5, source: Pick<EvidenceRecord, "sourceQuote" | "sourceLocator" | "limitations" | "claimRevisionId"> = { sourceQuote: "", limitations: "" }): EvidenceRecord {
    const existing = this.db.select().from(evidence).where(and(eq(evidence.projectId, projectId), eq(evidence.paperId, paper.id))).all().find((row) => row.note === note && row.stance === stance && row.sourceQuote === source.sourceQuote && row.claimRevisionId === (source.claimRevisionId ?? null));
    if (existing) return this.evidenceFromRow(existing);
    const value: typeof evidence.$inferInsert = { id: randomUUID(), projectId, paperId: paper.id, paperJson: JSON.stringify(paper), note, stance, confidence: Math.max(0, Math.min(confidence, 1)), sourceQuote: source.sourceQuote, sourceLocator: source.sourceLocator, limitations: source.limitations, claimRevisionId: source.claimRevisionId, createdAt: now() };
    const record = this.evidenceFromRow(value as typeof evidence.$inferSelect);
    this.transaction(() => {
      this.db.insert(evidence).values(value).run();
      this.enqueueProjection(projectId, record.id, "knowledge.evidence.saved", record, record.createdAt);
    });
    return record;
  }

  listEvidence(projectId = DEFAULT_PROJECT_ID): EvidenceRecord[] {
    return this.db.select().from(evidence).where(eq(evidence.projectId, projectId)).orderBy(desc(evidence.createdAt)).all().map((row) => this.evidenceFromRow(row));
  }

  private evidenceFromRow(row: typeof evidence.$inferSelect): EvidenceRecord {
    return { id: row.id, projectId: row.projectId, paper: JSON.parse(row.paperJson) as PaperRecord, note: row.note, stance: row.stance as EvidenceRecord["stance"], confidence: row.confidence, sourceQuote: row.sourceQuote, ...(row.sourceLocator ? { sourceLocator: row.sourceLocator } : {}), limitations: row.limitations, ...(row.claimRevisionId ? { claimRevisionId: row.claimRevisionId } : {}), createdAt: row.createdAt };
  }

  listProjectionOutbox(limit = 100): ResearchProjectionOutboxRecord[] {
    const rows = this.sqlite.prepare(`
      SELECT id, projection_key, project_id, source_id, event_type, payload_json, created_at, applied_at
      FROM research_projection_outbox WHERE applied_at IS NULL ORDER BY rowid LIMIT ?
    `).all(Math.max(1, Math.min(limit, 1000))) as Array<{ id: string; projection_key: string; project_id: string; source_id: string; event_type: ResearchProjectionOutboxRecord["eventType"]; payload_json: string; created_at: string; applied_at: string | null }>;
    return rows.map((row) => ({ id: row.id, projectionKey: row.projection_key, projectId: row.project_id, sourceId: row.source_id, eventType: row.event_type, payload: JSON.parse(row.payload_json) as unknown, createdAt: row.created_at, ...(row.applied_at ? { appliedAt: row.applied_at } : {}) }));
  }

  markProjectionOutboxApplied(projectionKeys: string[], appliedAt = now()): number {
    const unique = [...new Set(projectionKeys)];
    if (!unique.length) return 0;
    const placeholders = unique.map(() => "?").join(", ");
    return Number(this.sqlite.prepare(`UPDATE research_projection_outbox SET applied_at = ? WHERE applied_at IS NULL AND projection_key IN (${placeholders})`).run(appliedAt, ...unique).changes);
  }

  private insertRevision(pageId: string, version: number, markdown: string, artifactUris: ResourceUri[], createdAt: string, title: string): WikiPageRevision {
    const revision: WikiPageRevision = { id: randomUUID(), pageId, version, markdown, artifactUris, createdAt };
    this.db.insert(wikiRevisions).values({ ...revision, artifactUris: JSON.stringify(artifactUris) }).run();
    return revision;
  }

  private enqueueProjection(projectId: string, sourceId: string, eventType: ResearchProjectionOutboxRecord["eventType"], payload: unknown, createdAt: string): void {
    const id = randomUUID();
    this.sqlite.prepare(`
      INSERT INTO research_projection_outbox (id, projection_key, project_id, source_id, event_type, payload_json, created_at, applied_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(id, `knowledge:${eventType}:v1:${id}`, projectId, sourceId, eventType, JSON.stringify(payload), createdAt);
  }

  private transaction<T>(work: () => T): T {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  private seed(): void {
    if (this.db.select().from(projects).get()) return;
    const timestamp = now();
    const project: ResearchProject = {
      id: DEFAULT_PROJECT_ID,
      name: "自由探索",
      description: "不绑定单一学科或研究事件的通用科研入口。",
      researchQuestion: "提出研究问题，检索和核对证据，规划数据与方法，并将结果沉淀为可追溯的科研对象。",
      domainIds: ["general-science"],
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.transaction(() => {
      this.db.insert(projects).values({ ...project, domainIds: JSON.stringify(project.domainIds) }).run();
      this.enqueueProjection(project.id, project.id, "knowledge.project.upserted", project, timestamp);
    });
  }
}

export type { AgentKnowledgeReader, ContextCapsuleStore, ConversationStore, EvidenceStore, KnowledgeStore, ProjectItemStore, ProjectStore, ResearchProjectionOutboxRecord, ResearchProjectionOutboxStore, WikiStore } from "./ports.js";
export { KNOWLEDGE_SCHEMA_VERSION, runKnowledgeMigrations } from "./migrations.js";
