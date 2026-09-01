import { createHash } from "node:crypto";
import type { AgentRunEvent, SqliteAgentSessionStore } from "@xiling/agent-harness";
import type { EvidenceRecord, ResearchProject, ResearchEntityStatus, WikiPageRevision } from "@xiling/contracts";
import type { ProjectResearchWorkflow } from "@xiling/domain-ocean";
import type { KnowledgeService, ResearchProjectionOutboxRecord } from "@xiling/knowledge";
import type { ResearchGraphChangeSet, ResearchGraphEntityInput, ResearchGraphRelationInput, ResearchGraphStore } from "@xiling/research-graph";
import type { SqliteProjectWorkflowRepository, WorkflowProjectionOutboxRecord } from "./project-workflow.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);
const questionId = (projectId: string) => `research-question:${projectId}`;
const artifactId = (uri: string) => `artifact:${digest(uri)}`;
const artifactVersionId = (uri: string) => `artifact-version:${digest(uri)}`;
const datasetId = (workflow: ProjectResearchWorkflow) => `dataset:${digest(`${workflow.request.connectorId}:${workflow.request.datasetId}`)}`;
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

function addArtifact(builder: ChangeSetBuilder, uri: string, createdAt: string): string {
  const artifact = artifactId(uri);
  const version = artifactVersionId(uri);
  builder.node({ id: artifact, kind: "Artifact", title: uri.split("/").at(-1) ?? "Artifact", summary: "受管科研产物", status: "available", uri, properties: { uri }, createdAt, updatedAt: createdAt });
  builder.node({ id: version, kind: "ArtifactVersion", title: uri.split("/").at(-1) ?? "Artifact version", summary: "可复现的产物版本", status: "available", uri, sourceLocator: uri, properties: { uri }, createdAt, updatedAt: createdAt });
  builder.relation("HAS_VERSION", artifact, version);
  return version;
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
    for (const uri of payload.revision.artifactUris) builder.relation("REFERENCES", wiki, addArtifact(builder, uri, payload.revision.createdAt));
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

function workflowStatus(status: ProjectResearchWorkflow["status"]): ResearchEntityStatus {
  switch (status) {
    case "draft": return "draft";
    case "pending_approval": return "pending";
    case "approved": return "approved";
    case "probing": case "downloading": case "analyzing": return "running";
    case "completed": return "succeeded";
    case "rejected": return "rejected";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
  }
}

const runStatus = (status: NonNullable<ProjectResearchWorkflow["run"]>["status"]): ResearchEntityStatus => status === "queued" ? "pending" : status;

export function workflowRecordToChangeSet(record: WorkflowProjectionOutboxRecord, project: ResearchProject): ResearchGraphChangeSet {
  const workflow = record.workflow;
  const builder = new ChangeSetBuilder(record.projectId);
  addProject(builder, project);
  const plan = builder.node({
    id: `research-plan:${workflow.id}`,
    kind: "ResearchPlan",
    title: `${workflow.request.datasetId} 科研数据计划`,
    summary: `${workflow.request.variables.join(", ")} · ${workflow.request.time.start} — ${workflow.request.time.end}`,
    status: workflowStatus(workflow.status),
    properties: { workflowId: workflow.id, request: workflow.request, preflight: workflow.preflight, requestHash: workflow.requestHash, error: workflow.error },
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
  });
  builder.relation("CONTAINS", project.id, plan);
  const dataset = builder.node({
    id: datasetId(workflow),
    kind: "Dataset",
    title: workflow.request.datasetId,
    summary: `${workflow.request.connectorId} 数据集`,
    status: "available",
    uri: `dataset://${workflow.request.connectorId}/${workflow.request.datasetId}`,
    properties: { connectorId: workflow.request.connectorId, datasetId: workflow.request.datasetId },
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
  });
  builder.relation("CONTAINS", project.id, dataset);
  builder.relation("REFERENCES", plan, dataset);

  if (workflow.approvedRequestHash) {
    const approval = builder.node({
      id: `approval:${workflow.id}:${workflow.approvedRequestHash.slice(0, 16)}`,
      kind: "Approval",
      title: "科研数据计划审批",
      summary: "用户已批准当前请求哈希对应的数据访问边界。",
      status: "approved",
      properties: { requestHash: workflow.approvedRequestHash, connectorJobId: workflow.connectorJobId },
      createdAt: workflow.updatedAt,
      updatedAt: workflow.updatedAt,
    });
    builder.relation("CONTAINS", project.id, approval);
    builder.relation("REFERENCES", approval, plan);
  }

  const actor = workflow.sourceRunId ? builder.node({
    id: `actor:agent-run:${workflow.sourceRunId}`,
    kind: "Actor",
    title: `Agent Run ${workflow.sourceRunId.slice(-8)}`,
    summary: "创建或推进该科研计划的 Agent 运行。",
    sourceLocator: `agent-run://${workflow.sourceRunId}`,
    properties: { sessionId: workflow.sessionId, runId: workflow.sourceRunId, operationId: workflow.sourceOperationId, callId: workflow.sourceCallId },
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
  }) : undefined;
  if (actor) builder.relation("ASSOCIATED_WITH", plan, actor);

  let snapshot: string | undefined;
  if (workflow.datasetArtifact) {
    snapshot = builder.node({
      id: `dataset-snapshot:${workflow.datasetArtifact.sha256}`,
      kind: "DatasetSnapshot",
      title: `${workflow.request.datasetId} 数据快照`,
      summary: `${workflow.datasetArtifact.bytes} bytes · SHA-256 ${workflow.datasetArtifact.sha256.slice(0, 12)}…`,
      status: "verified",
      uri: workflow.datasetArtifact.uri,
      sourceLocator: workflow.datasetArtifact.uri,
      properties: { bytes: workflow.datasetArtifact.bytes, sha256: workflow.datasetArtifact.sha256, request: workflow.request },
      createdAt: workflow.updatedAt,
      updatedAt: workflow.updatedAt,
    });
    builder.relation("HAS_VERSION", dataset, snapshot);
  }

  if (workflow.run) {
    const run = builder.node({
      id: workflow.run.id,
      kind: "ResearchRun",
      title: `${workflow.request.datasetId} 计算运行`,
      summary: workflow.review ? `Reviewer：${workflow.review.verdict}` : "科研计算正在执行或等待审查。",
      status: runStatus(workflow.run.status),
      properties: { planId: workflow.run.planId, workflowId: workflow.id },
      createdAt: workflow.run.startedAt ?? workflow.updatedAt,
      updatedAt: workflow.run.finishedAt ?? workflow.updatedAt,
    });
    builder.relation("CONTAINS", project.id, run);
    if (snapshot) builder.relation("USED", run, snapshot);
    if (actor) builder.relation("ASSOCIATED_WITH", run, actor);
    for (const uri of workflow.run.artifactUris) {
      const artifactVersion = addArtifact(builder, uri, workflow.run.finishedAt ?? workflow.updatedAt);
      builder.relation("GENERATED", run, artifactVersion);
      const artifactLifecycle = builder.node({
        id: `lifecycle:artifact:${digest(`${workflow.run.id}:${uri}:available`)}`,
        kind: "LifecycleEvent",
        title: "Artifact · available",
        summary: "科研运行已生成并登记该受管产物版本。",
        status: "available",
        properties: { runId: workflow.run.id, uri, state: "available" },
        createdAt: workflow.run.finishedAt ?? workflow.updatedAt,
        updatedAt: workflow.run.finishedAt ?? workflow.updatedAt,
      });
      builder.relation("TRANSITIONED_BY", artifactVersion, artifactLifecycle);
    }
    if (workflow.review) {
      const review = builder.node({
        id: workflow.review.id,
        kind: "ReviewReport",
        title: `自动审查 · ${workflow.review.verdict}`,
        summary: workflow.review.limitations.join("；") || workflow.review.checks.map((check) => `${check.passed ? "✓" : "✕"} ${check.id}`).join("；"),
        status: workflow.review.verdict,
        properties: { checks: workflow.review.checks, limitations: workflow.review.limitations },
        createdAt: workflow.review.createdAt,
        updatedAt: workflow.review.createdAt,
      });
      builder.relation("CONTAINS", project.id, review);
      builder.relation("EVALUATES", review, run);
    }
  }

  const lifecycle = builder.node({
    id: `lifecycle:${digest(JSON.stringify({ workflowId: workflow.id, status: workflow.status, updatedAt: workflow.updatedAt, error: workflow.error }))}`,
    kind: "LifecycleEvent",
    title: `Workflow · ${workflow.status}`,
    summary: workflow.error ?? `科研工作流进入 ${workflow.status} 状态。`,
    status: workflowStatus(workflow.status),
    properties: { workflowId: workflow.id, status: workflow.status },
    createdAt: workflow.updatedAt,
    updatedAt: workflow.updatedAt,
  });
  builder.relation("TRANSITIONED_BY", plan, lifecycle);
  return builder.build();
}

export function agentEventToProjection(event: AgentRunEvent): { projectionKey: string; sourceId: string; changeSet: ResearchGraphChangeSet } | undefined {
  if (event.type !== "workflow.projected" || !event.payload || typeof event.payload !== "object") return undefined;
  const payload = event.payload as { type?: unknown; projectionKey?: unknown; projectId?: unknown; sessionId?: unknown; runId?: unknown; sourceOperationId?: unknown; sourceCallId?: unknown };
  if (payload.type !== "workflow.projected" || typeof payload.projectionKey !== "string" || typeof payload.projectId !== "string" || typeof payload.runId !== "string") return undefined;
  const builder = new ChangeSetBuilder(payload.projectId);
  builder.node({
    id: `actor:agent-run:${payload.runId}`,
    kind: "Actor",
    title: `Agent Run ${payload.runId.slice(-8)}`,
    summary: "由 Agent Harness 耐久事件投影的科研参与者。",
    sourceLocator: `agent-run://${payload.runId}`,
    properties: { sessionId: payload.sessionId, runId: payload.runId, operationId: payload.sourceOperationId, callId: payload.sourceCallId },
    createdAt: event.createdAt,
    updatedAt: event.createdAt,
  });
  return { projectionKey: `agent:workflow-projected:v1:${payload.projectionKey}`, sourceId: `${event.runId}:${event.sequence}`, changeSet: builder.build() };
}

export class ResearchGraphReconciler {
  private tail: Promise<ResearchGraphReconcileResult> = Promise.resolve({ knowledge: 0, agent: 0, workflow: 0 });
  constructor(
    private readonly graph: ResearchGraphStore,
    private readonly knowledge: KnowledgeService,
    private readonly workflows: SqliteProjectWorkflowRepository,
    private readonly agents: SqliteAgentSessionStore,
  ) {}

  reconcile(): Promise<ResearchGraphReconcileResult> {
    const next = this.tail.then(() => this.reconcileOnce(), () => this.reconcileOnce());
    this.tail = next;
    return next;
  }

  private async reconcileOnce(): Promise<ResearchGraphReconcileResult> {
    await this.graph.initialize();
    let knowledgeCount = 0;
    for (const record of this.knowledge.listProjectionOutbox(1000)) {
      try {
        const project = this.knowledge.getProject(record.projectId);
        await this.graph.applyProjection({ projectionKey: record.projectionKey, source: "knowledge", sourceId: record.sourceId, changeSet: knowledgeRecordToChangeSet(record, project) });
        this.knowledge.markProjectionOutboxApplied([record.projectionKey]);
        knowledgeCount += 1;
      } catch (error) {
        // Poison isolation: one broken record must not block the rest of the
        // batch or wedge every future reconcile. It stays unapplied and visible.
        console.warn(`[xiling] knowledge projection ${record.projectionKey} failed: ${error instanceof Error ? error.message : error}`);
      }
    }
    // Development databases created before the outbox schema have no source
    // event for their project root. Bootstrap only the missing root; old Wiki,
    // Evidence and Workflow payloads are intentionally not migrated.
    for (const project of this.knowledge.listProjects()) {
      if (await this.graph.getEntity(project.id, project.id)) continue;
      const changeSet = knowledgeRecordToChangeSet({
        id: `bootstrap-${project.id}`,
        projectionKey: `knowledge:project-bootstrap:v1:${project.id}:${digest(JSON.stringify(project))}`,
        projectId: project.id,
        sourceId: project.id,
        eventType: "knowledge.project.upserted",
        payload: project,
        createdAt: project.updatedAt,
      });
      const result = await this.graph.applyProjection({ projectionKey: `knowledge:project-bootstrap:v1:${project.id}:${digest(JSON.stringify(project))}`, source: "knowledge", sourceId: project.id, changeSet });
      if (result.applied) knowledgeCount += 1;
    }
    // The durable cursor keeps every reconcile O(delta) instead of rescanning
    // the whole Agent journal; a failed event holds the cursor so it retries.
    let agentCount = 0;
    const cursorName = "agent-workflow-projected";
    const cursor = this.agents.getProjectionCursor(cursorName);
    let safeCursor = cursor;
    for (const event of this.agents.listEventsByTypeAfter(["workflow.projected"], cursor)) {
      const projection = agentEventToProjection(event);
      if (projection) {
        try {
          const result = await this.graph.applyProjection({ ...projection, source: "agent" });
          if (result.applied) agentCount += 1;
        } catch (error) {
          console.warn(`[xiling] agent projection ${projection.projectionKey} failed: ${error instanceof Error ? error.message : error}`);
          continue;
        }
      }
      if (event.eventId > safeCursor) safeCursor = event.eventId;
    }
    if (safeCursor > cursor) this.agents.setProjectionCursor(cursorName, safeCursor);
    let workflowCount = 0;
    for (const record of this.workflows.listProjectionOutbox(1000)) {
      try {
        const project = this.knowledge.getProject(record.projectId);
        if (!project) continue;
        await this.graph.applyProjection({ projectionKey: record.projectionKey, source: "workflow", sourceId: record.sourceId, changeSet: workflowRecordToChangeSet(record, project) });
        this.workflows.markProjectionOutboxApplied([record.projectionKey]);
        workflowCount += 1;
      } catch (error) {
        console.warn(`[xiling] workflow projection ${record.projectionKey} failed: ${error instanceof Error ? error.message : error}`);
      }
    }
    return { knowledge: knowledgeCount, agent: agentCount, workflow: workflowCount };
  }
}

export interface ResearchGraphReconcileResult {
  knowledge: number;
  agent: number;
  workflow: number;
}
