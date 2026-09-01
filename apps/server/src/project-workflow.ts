import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ConnectorMetadataProbe, ConnectorWorkflowService } from "@xiling/connectors";
import { canonicalRequestHash, preflightConnector } from "@xiling/connectors";
import type { ResourceUri, ReviewerReport } from "@xiling/contracts";
import type { OceanSubsetRequest, ProjectResearchWorkflow } from "@xiling/domain-ocean";

export interface ProjectAnalysisRunner {
  execute(workflow: ProjectResearchWorkflow, signal?: AbortSignal): Promise<{ artifactUris: ResourceUri[]; checks: ReviewerReport["checks"]; limitations: string[] }>;
}

export interface WorkflowArtifactRegistration {
  datasetArtifact?: ProjectResearchWorkflow["datasetArtifact"];
  artifactUris: ResourceUri[];
}

export interface WorkflowArtifactRegistrar {
  register(workflow: ProjectResearchWorkflow, artifactUris: ResourceUri[]): Promise<WorkflowArtifactRegistration>;
}

export interface ProjectWorkflowRepository {
  load(): Promise<ProjectResearchWorkflow[]>;
  save(workflows: ProjectResearchWorkflow[]): Promise<void>;
}

export interface WorkflowProjectionOutboxRecord {
  id: string;
  projectionKey: string;
  projectId: string;
  sourceId: string;
  eventType: "workflow.snapshot.updated";
  workflow: ProjectResearchWorkflow;
  createdAt: string;
  appliedAt?: string;
}

export class JsonProjectWorkflowRepository {
  constructor(private readonly path: string) {}
  async load(): Promise<ProjectResearchWorkflow[]> {
    try { return JSON.parse(await readFile(this.path, "utf8")) as ProjectResearchWorkflow[]; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  async save(workflows: ProjectResearchWorkflow[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(workflows, null, 2)}\n`, "utf8");
    await rename(temporary, this.path);
  }
}

export class SqliteProjectWorkflowRepository implements ProjectWorkflowRepository {
  private readonly sqlite: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.sqlite = new DatabaseSync(path);
    this.sqlite.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS project_workflows (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS project_workflows_project_updated ON project_workflows(project_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS research_projection_outbox (
        id TEXT PRIMARY KEY,
        projection_key TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        applied_at TEXT
      );
      CREATE INDEX IF NOT EXISTS workflow_projection_outbox_pending ON research_projection_outbox(applied_at, created_at);
    `);
  }

  async load(): Promise<ProjectResearchWorkflow[]> {
    const rows = this.sqlite.prepare("SELECT payload_json FROM project_workflows ORDER BY updated_at DESC, id").all() as Array<{ payload_json: string }>;
    return rows.map((row) => JSON.parse(row.payload_json) as ProjectResearchWorkflow);
  }

  async save(workflows: ProjectResearchWorkflow[]): Promise<void> {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const upsert = this.sqlite.prepare(`
        INSERT INTO project_workflows (id, project_id, status, payload_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, status = excluded.status,
          payload_json = excluded.payload_json, updated_at = excluded.updated_at
      `);
      const outbox = this.sqlite.prepare(`
        INSERT OR IGNORE INTO research_projection_outbox
          (id, projection_key, project_id, source_id, event_type, payload_json, created_at, applied_at)
        VALUES (?, ?, ?, ?, 'workflow.snapshot.updated', ?, ?, NULL)
      `);
      for (const workflow of workflows) {
        const payload = JSON.stringify(workflow);
        const digest = createHash("sha256").update(payload).digest("hex");
        const id = `workflow-outbox-${digest}`;
        const projectionKey = `workflow:snapshot:v1:${workflow.id}:${digest}`;
        upsert.run(workflow.id, workflow.projectId, workflow.status, payload, workflow.createdAt, workflow.updatedAt);
        outbox.run(id, projectionKey, workflow.projectId, workflow.id, payload, workflow.updatedAt);
      }
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  listProjectionOutbox(limit = 100): WorkflowProjectionOutboxRecord[] {
    const rows = this.sqlite.prepare(`
      SELECT id, projection_key, project_id, source_id, event_type, payload_json, created_at, applied_at
      FROM research_projection_outbox WHERE applied_at IS NULL ORDER BY rowid LIMIT ?
    `).all(Math.max(1, Math.min(limit, 1000))) as Array<{ id: string; projection_key: string; project_id: string; source_id: string; event_type: "workflow.snapshot.updated"; payload_json: string; created_at: string; applied_at: string | null }>;
    return rows.map((row) => ({ id: row.id, projectionKey: row.projection_key, projectId: row.project_id, sourceId: row.source_id, eventType: row.event_type, workflow: JSON.parse(row.payload_json) as ProjectResearchWorkflow, createdAt: row.created_at, ...(row.applied_at ? { appliedAt: row.applied_at } : {}) }));
  }

  markProjectionOutboxApplied(projectionKeys: string[], appliedAt = new Date().toISOString()): number {
    const unique = [...new Set(projectionKeys)];
    if (!unique.length) return 0;
    const placeholders = unique.map(() => "?").join(", ");
    return Number(this.sqlite.prepare(`UPDATE research_projection_outbox SET applied_at = ? WHERE applied_at IS NULL AND projection_key IN (${placeholders})`).run(appliedAt, ...unique).changes);
  }

  close(): void { this.sqlite.close(); }
}

export class FixtureProjectAnalysisRunner implements ProjectAnalysisRunner {
  constructor(private readonly runsRoot: string, private readonly now = () => new Date().toISOString()) {}
  async execute(workflow: ProjectResearchWorkflow, signal?: AbortSignal) {
    if (signal?.aborted) throw new Error("analysis cancelled");
    const root = resolve(this.runsRoot, workflow.id, "artifacts");
    await mkdir(resolve(root, "ro-crate"), { recursive: true });
    const warning = { fixture: true, scientificConclusion: false, workflowId: workflow.id, request: workflow.request, generatedAt: this.now() };
    const warningPath = resolve(root, "fixture-warning.json");
    await writeFile(warningPath, `${JSON.stringify(warning, null, 2)}\n`, "utf8");
    const checks: ReviewerReport["checks"] = [
      { id: "approval-boundary", passed: true, detail: "download ran only after explicit approval" },
      { id: "artifact-hash", passed: Boolean(workflow.datasetArtifact?.sha256), detail: "connector returned a content hash" },
      { id: "scientific-evidence", passed: false, detail: "offline fixture is not observational evidence" },
    ];
    const reviewPath = resolve(root, "reviewer-report.json");
    await writeFile(reviewPath, `${JSON.stringify({ verdict: "rejected", checks, limitations: ["离线 fixture 仅验证软件闭环，不代表真实科研结论。"] }, null, 2)}\n`, "utf8");
    const cratePath = resolve(root, "ro-crate", "ro-crate-metadata.json");
    await writeFile(cratePath, `${JSON.stringify({ "@context": "https://w3id.org/ro/crate/1.1/context", "@graph": [{ "@id": "ro-crate-metadata.json", "@type": "CreativeWork", about: { "@id": "./" } }, { "@id": "./", "@type": "Dataset", name: "Xi Ling OS offline workflow smoke", description: "Not scientific evidence" }] }, null, 2)}\n`, "utf8");
    const base = `artifact://workflow/${workflow.id}`;
    return { artifactUris: [`${base}/fixture-warning.json`, `${base}/reviewer-report.json`, `${base}/ro-crate/ro-crate-metadata.json`] as ResourceUri[], checks, limitations: ["离线 fixture 仅验证软件闭环，不代表真实科研结论。"] };
  }
}

export class ProjectWorkflowService {
  private workflows: ProjectResearchWorkflow[] = [];
  private readonly active = new Map<string, AbortController>();
  private persistTail: Promise<void> = Promise.resolve();
  constructor(
    private readonly repository: ProjectWorkflowRepository,
    private readonly connectorWorkflow: ConnectorWorkflowService,
    private readonly metadataProbe: ConnectorMetadataProbe,
    private readonly analysisRunner: ProjectAnalysisRunner,
    private readonly credentialsAvailable: (request: OceanSubsetRequest) => boolean,
    private readonly now = () => new Date().toISOString(),
    private readonly artifactRegistrar?: WorkflowArtifactRegistrar,
  ) {}

  async initialize() {
    this.workflows = await this.repository.load();
    const interrupted = new Set(["probing", "downloading", "analyzing"]);
    this.workflows = this.workflows.map((workflow) => {
      const requestHash = workflow.requestHash ?? canonicalRequestHash(workflow.request);
      const migrated = { ...workflow, requestHash, ...(["approved", "downloading", "analyzing", "completed"].includes(workflow.status) && !workflow.approvedRequestHash ? { approvedRequestHash: requestHash } : {}) };
      return interrupted.has(migrated.status) ? { ...migrated, status: "failed" as const, error: "interrupted during previous server session", updatedAt: this.now() } : migrated;
    });
    await this.persist();
    return this.list();
  }
  list(filter: { projectId?: string; sessionId?: string } = {}) {
    return structuredClone(this.workflows.filter((workflow) => (!filter.projectId || workflow.projectId === filter.projectId) && (!filter.sessionId || workflow.sessionId === filter.sessionId)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  }
  get(id: string) { const workflow = this.workflows.find((item) => item.id === id); return workflow ? structuredClone(workflow) : undefined; }
  async create(input: { projectId: string; sessionId: string; sourceCallId: string; sourceRunId?: string; sourceProjectionKey?: string; sourceEventSequence?: number; sourceOperationId?: string; sourceRequestHash?: string; request: OceanSubsetRequest }) {
    const request = input.request.connectorId === "argo-gdac"
      ? { ...input.request, variables: [...new Set([...input.request.variables, "POSITION_QC", "LATITUDE", "LONGITUDE", "JULD"])] }
      : input.request;
    const requestHash = canonicalRequestHash(request);
    const existing = this.workflows.find((workflow) => input.sourceProjectionKey
      ? workflow.sourceProjectionKey === input.sourceProjectionKey
      : workflow.projectId === input.projectId && workflow.sourceCallId === input.sourceCallId);
    if (existing) {
      if (existing.projectId !== input.projectId || existing.sessionId !== input.sessionId || existing.sourceRunId !== input.sourceRunId || existing.requestHash !== requestHash) throw new Error("Workflow projection idempotency conflict");
      return structuredClone(existing);
    }
    const timestamp = this.now();
    const workflow: ProjectResearchWorkflow = {
      id: `workflow-${randomUUID()}`,
      projectId: input.projectId,
      sessionId: input.sessionId,
      sourceCallId: input.sourceCallId,
      ...(input.sourceRunId ? { sourceRunId: input.sourceRunId } : {}),
      ...(input.sourceProjectionKey ? { sourceProjectionKey: input.sourceProjectionKey } : {}),
      ...(input.sourceEventSequence !== undefined ? { sourceEventSequence: input.sourceEventSequence } : {}),
      ...(input.sourceOperationId ? { sourceOperationId: input.sourceOperationId } : {}),
      ...(input.sourceRequestHash ? { sourceRequestHash: input.sourceRequestHash } : {}),
      requestHash,
      request,
      preflight: preflightConnector(request),
      status: "draft",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.workflows.push(workflow); await this.persist(); return structuredClone(workflow);
  }
  async probe(id: string) {
    const workflow = this.require(id);
    if (!["draft", "failed"].includes(workflow.status)) throw new Error("workflow is not ready for metadata probing");
    const controller = this.start(id); workflow.status = "probing"; delete workflow.error; workflow.updatedAt = this.now(); await this.persist();
    try {
      const metadata = await this.metadataProbe.probe(workflow.request, controller.signal);
      const job = await this.connectorWorkflow.prepare(workflow.request, metadata, this.credentialsAvailable(workflow.request));
      Object.assign(workflow, { metadata, preflight: job.preflight, connectorJobId: job.id, status: "pending_approval", updatedAt: this.now() } satisfies Partial<ProjectResearchWorkflow>);
      await this.persist(); return structuredClone(workflow);
    } catch (error) { await this.fail(workflow, controller.signal, error); throw error; }
    finally { this.active.delete(id); }
  }
  async reject(id: string) {
    const workflow = this.require(id); if (workflow.status !== "pending_approval" || !workflow.connectorJobId) throw new Error("workflow approval is not pending");
    await this.connectorWorkflow.reject(workflow.connectorJobId); workflow.status = "rejected"; workflow.updatedAt = this.now(); await this.persist(); return structuredClone(workflow);
  }
  async approve(id: string) {
    const workflow = this.require(id); if (workflow.status !== "pending_approval" || !workflow.connectorJobId || !workflow.requestHash) throw new Error("workflow approval is not pending");
    const requestHash = workflow.requestHash;
    await this.connectorWorkflow.approve(workflow.connectorJobId); workflow.status = "approved"; workflow.approvedRequestHash = requestHash; workflow.updatedAt = this.now(); await this.persist(); return structuredClone(workflow);
  }
  async run(id: string) {
    const workflow = this.require(id); if (workflow.status !== "approved" || !workflow.connectorJobId || !workflow.requestHash || workflow.approvedRequestHash !== workflow.requestHash) throw new Error("workflow requires explicit approval for the current plan");
    const controller = this.start(id); const startedAt = this.now();
    workflow.status = "downloading"; workflow.run = { id: `run-${randomUUID()}`, projectId: workflow.projectId, planId: workflow.id, status: "running", artifactUris: [], startedAt }; workflow.updatedAt = startedAt; await this.persist();
    try {
      const downloaded = await this.connectorWorkflow.download(workflow.connectorJobId, controller.signal);
      if (!downloaded.artifact) throw new Error("connector returned no dataset artifact");
      workflow.datasetArtifact = downloaded.artifact; workflow.status = "analyzing"; workflow.updatedAt = this.now(); await this.persist();
      const result = await this.analysisRunner.execute(structuredClone(workflow), controller.signal);
      const registered = this.artifactRegistrar ? await this.artifactRegistrar.register(structuredClone(workflow), result.artifactUris) : undefined;
      if (registered?.datasetArtifact) workflow.datasetArtifact = registered.datasetArtifact;
      const runId = workflow.run.id; const verdict = result.checks.every((check) => check.passed) ? "accepted" : "rejected";
      workflow.run = { ...workflow.run, status: "succeeded", artifactUris: registered?.artifactUris ?? result.artifactUris, finishedAt: this.now() };
      workflow.review = { id: `review-${randomUUID()}`, runId, verdict, checks: result.checks, limitations: result.limitations, createdAt: this.now() };
      workflow.status = "completed"; workflow.updatedAt = this.now(); await this.persist(); return structuredClone(workflow);
    } catch (error) { if (workflow.run) workflow.run = { ...workflow.run, status: controller.signal.aborted ? "cancelled" : "failed", finishedAt: this.now() }; await this.fail(workflow, controller.signal, error); throw error; }
    finally { this.active.delete(id); }
  }
  async reset(id: string) {
    const workflow = this.require(id); if (!["failed", "cancelled", "rejected"].includes(workflow.status)) throw new Error("workflow cannot be reset");
    workflow.status = "draft"; workflow.preflight = preflightConnector(workflow.request); delete workflow.metadata; delete workflow.connectorJobId; delete workflow.datasetArtifact; delete workflow.run; delete workflow.review; delete workflow.error; delete workflow.approvedRequestHash; workflow.updatedAt = this.now(); await this.persist(); return structuredClone(workflow);
  }
  async markSettled(id: string) { const workflow = this.require(id); workflow.settledAt = this.now(); workflow.updatedAt = this.now(); await this.persist(); return structuredClone(workflow); }
  cancel(id: string) { const controller = this.active.get(id); if (!controller) throw new Error("workflow is not active"); controller.abort("cancelled by user"); return { status: "cancelling" as const }; }
  private start(id: string) { if (this.active.has(id)) throw new Error("workflow is already active"); const controller = new AbortController(); this.active.set(id, controller); return controller; }
  private require(id: string) { const workflow = this.workflows.find((item) => item.id === id); if (!workflow) throw new Error("workflow not found"); return workflow; }
  private async fail(workflow: ProjectResearchWorkflow, signal: AbortSignal, error: unknown) { workflow.status = signal.aborted ? "cancelled" : "failed"; workflow.error = signal.aborted ? "cancelled by user" : error instanceof Error ? error.message : String(error); workflow.updatedAt = this.now(); await this.persist(); }
  private async persist() {
    const snapshot = structuredClone(this.workflows);
    const pending = this.persistTail.then(() => this.repository.save(snapshot));
    this.persistTail = pending.catch(() => undefined);
    await pending;
  }
}
