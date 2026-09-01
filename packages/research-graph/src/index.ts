import { createHash } from "node:crypto";
import { Connection, Database, type LbugValue, type QueryResult } from "@ladybugdb/core";
import type {
  EvidenceStance,
  ResearchEntityKind,
  ResearchEntityStatus,
  ResearchGraphEntity,
  ResearchGraphProjection,
  ResearchGraphRelation,
  ResearchGraphView,
  ResearchRelationKind,
} from "@xiling/contracts";

export { createOceanResearchFixture } from "./fixture.js";

export const RESEARCH_GRAPH_SCHEMA_VERSION = 2;

export const RESEARCH_RELATION_KINDS = [
  "CONTAINS",
  "HAS_REVISION",
  "HAS_FRAGMENT",
  "CITES",
  "ASSERTS",
  "BASED_ON",
  "USED",
  "GENERATED",
  "DERIVED_FROM",
  "EVALUATES",
  "DOCUMENTS",
  "SUPERSEDES",
  "HAS_VERSION",
  "TRANSITIONED_BY",
  "ASSOCIATED_WITH",
  "REFERENCES",
] as const satisfies readonly ResearchRelationKind[];

const relationKindSet = new Set<string>(RESEARCH_RELATION_KINDS);

/** Versioned scientific facts whose stored id pins one immutable revision. */
const IMMUTABLE_ENTITY_KINDS = new Set<ResearchEntityKind>(["ClaimRevision", "DatasetSnapshot", "ArtifactVersion", "WikiRevisionRef"]);

export interface ResearchGraphEntityInput {
  id: string;
  projectId: string;
  kind: ResearchEntityKind;
  title: string;
  summary?: string;
  status?: ResearchEntityStatus;
  revision?: number;
  uri?: string;
  stance?: EvidenceStance;
  confidence?: number;
  sourceLocator?: string;
  properties?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface ResearchGraphRelationInput {
  projectId: string;
  kind: ResearchRelationKind;
  sourceId: string;
  targetId: string;
  properties?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface ResearchGraphChangeSet {
  projectId: string;
  nodes: ResearchGraphEntityInput[];
  relations: ResearchGraphRelationInput[];
}

export interface ResearchGraphProjectionEnvelope {
  projectionKey: string;
  source: "knowledge" | "workflow" | "agent";
  sourceId: string;
  changeSet: ResearchGraphChangeSet;
}

export interface ResearchGraphProjectionApplyResult {
  applied: boolean;
  nodes: number;
  relations: number;
}

export interface EvidenceAssertionView {
  assertionId: string;
  assertionTitle: string;
  stance: EvidenceStance;
  confidence?: number;
  sourceId: string;
  sourceKind: ResearchEntityKind;
  sourceTitle: string;
  sourceLocator?: string;
}

export interface ArtifactLineageView {
  artifact: ResearchGraphEntity;
  run?: ResearchGraphEntity;
  inputs: ResearchGraphEntity[];
  reviews: ResearchGraphEntity[];
}

export interface ResearchGraphHealth {
  engine: "ladybugdb";
  engineVersion: string;
  storageVersion: string;
  schemaVersion: number;
}

export interface ResearchGraphStore {
  initialize(): Promise<ResearchGraphHealth>;
  applyChangeSet(changeSet: ResearchGraphChangeSet): Promise<{ nodes: number; relations: number }>;
  applyProjection(envelope: ResearchGraphProjectionEnvelope): Promise<ResearchGraphProjectionApplyResult>;
  getEntity(projectId: string, entityId: string): Promise<ResearchGraphEntity | undefined>;
  getProjection(projectId: string, view?: ResearchGraphView): Promise<ResearchGraphProjection>;
  getEvidenceForClaim(projectId: string, claimId: string): Promise<EvidenceAssertionView[]>;
  traceArtifact(projectId: string, artifactVersionId: string): Promise<ArtifactLineageView | undefined>;
  checkpoint(): Promise<void>;
  close(): Promise<void>;
}

const schemaStatements = [
  `CREATE NODE TABLE IF NOT EXISTS GraphMeta (
    id STRING PRIMARY KEY,
    schemaVersion INT64,
    engineVersion STRING,
    createdAt STRING
  )`,
  `CREATE NODE TABLE IF NOT EXISTS ResearchNode (
    graphId STRING PRIMARY KEY,
    id STRING,
    projectId STRING,
    kind STRING,
    title STRING,
    summary STRING,
    status STRING,
    revision INT64,
    uri STRING,
    contentHash STRING,
    stance STRING,
    confidence DOUBLE,
    sourceLocator STRING,
    propertiesJson STRING,
    createdAt STRING,
    updatedAt STRING
  )`,
  `CREATE NODE TABLE IF NOT EXISTS ProjectionLedger (
    projectionKey STRING PRIMARY KEY,
    projectId STRING,
    source STRING,
    sourceId STRING,
    sourceHash STRING,
    appliedAt STRING
  )`,
  ...RESEARCH_RELATION_KINDS.map((kind) => `CREATE REL TABLE IF NOT EXISTS ${kind} (
    FROM ResearchNode TO ResearchNode,
    id STRING,
    projectId STRING,
    propertiesJson STRING,
    createdAt STRING,
    updatedAt STRING
  )`),
];

const viewNodeKinds: Record<ResearchGraphView, ReadonlySet<ResearchEntityKind> | undefined> = {
  all: undefined,
  literature: new Set(["ResearchQuestion", "Claim", "ClaimRevision", "EvidenceAssertion", "Paper", "SourceFragment"]),
  evidence: new Set(["ResearchQuestion", "Hypothesis", "Claim", "ClaimRevision", "EvidenceAssertion", "Paper", "SourceFragment", "DatasetSnapshot", "ArtifactVersion", "ReviewReport"]),
  provenance: new Set(["Dataset", "DatasetSnapshot", "ResearchPlan", "Approval", "ResearchRun", "Artifact", "ArtifactVersion", "LifecycleEvent", "ReviewReport", "Actor"]),
  artifacts: new Set(["ResearchRun", "Artifact", "ArtifactVersion", "LifecycleEvent", "ReviewReport", "Actor"]),
};

const viewRelationKinds: Record<ResearchGraphView, readonly ResearchRelationKind[]> = {
  all: RESEARCH_RELATION_KINDS,
  literature: ["CONTAINS", "CITES", "HAS_FRAGMENT", "BASED_ON", "ASSERTS", "HAS_REVISION", "SUPERSEDES"],
  evidence: ["CONTAINS", "HAS_FRAGMENT", "BASED_ON", "ASSERTS", "EVALUATES", "DOCUMENTS", "DERIVED_FROM", "SUPERSEDES"],
  provenance: ["CONTAINS", "USED", "GENERATED", "DERIVED_FROM", "EVALUATES", "HAS_VERSION", "TRANSITIONED_BY", "ASSOCIATED_WITH"],
  artifacts: ["GENERATED", "DERIVED_FROM", "EVALUATES", "HAS_VERSION", "TRANSITIONED_BY", "ASSOCIATED_WITH"],
};

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function parseProperties(value: LbugValue | undefined): Record<string, unknown> {
  if (typeof value !== "string" || value.length === 0) return {};
  const parsed = JSON.parse(value) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function asString(value: LbugValue | undefined, field: string): string {
  if (typeof value !== "string") throw new Error(`Research Graph returned invalid ${field}`);
  return value;
}

function asNumber(value: LbugValue | undefined, field: string): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new Error(`Research Graph returned invalid ${field}`);
}

function optionalString(value: LbugValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: LbugValue | undefined): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return undefined;
}

function toEntity(row: Record<string, LbugValue>, prefix = ""): ResearchGraphEntity {
  const field = (name: string) => row[`${prefix}${name}`];
  const status = optionalString(field("status"));
  const uri = optionalString(field("uri"));
  const stance = optionalString(field("stance"));
  const confidence = optionalNumber(field("confidence"));
  const sourceLocator = optionalString(field("sourceLocator"));
  return {
    id: asString(field("id"), "entity id"),
    projectId: asString(field("projectId"), "entity projectId"),
    kind: asString(field("kind"), "entity kind") as ResearchEntityKind,
    title: asString(field("title"), "entity title"),
    summary: asString(field("summary"), "entity summary"),
    ...(status ? { status: status as ResearchEntityStatus } : {}),
    revision: asNumber(field("revision"), "entity revision"),
    ...(uri ? { uri } : {}),
    contentHash: asString(field("contentHash"), "entity contentHash"),
    ...(stance ? { stance: stance as EvidenceStance } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(sourceLocator ? { sourceLocator } : {}),
    properties: parseProperties(field("propertiesJson")),
    createdAt: asString(field("createdAt"), "entity createdAt"),
    updatedAt: asString(field("updatedAt"), "entity updatedAt"),
  };
}

const entityReturn = (variable: string, prefix = "") => [
  "id",
  "projectId",
  "kind",
  "title",
  "summary",
  "status",
  "revision",
  "uri",
  "contentHash",
  "stance",
  "confidence",
  "sourceLocator",
  "propertiesJson",
  "createdAt",
  "updatedAt",
].map((field) => `${variable}.${field} AS ${prefix}${field}`).join(", ");

function relationId(input: ResearchGraphRelationInput): string {
  return hash([input.projectId, input.kind, input.sourceId, input.targetId]);
}

function graphId(projectId: string, entityId: string): string {
  return `${projectId}\u001f${entityId}`;
}

function normalizedEntity(input: ResearchGraphEntityInput, now: string): ResearchGraphEntity {
  if (input.confidence !== undefined && (input.confidence < 0 || input.confidence > 1)) throw new Error("Evidence confidence must be between 0 and 1");
  const createdAt = input.createdAt ?? now;
  const updatedAt = input.updatedAt ?? now;
  const properties = input.properties ?? {};
  // uri and sourceLocator are locators, not content: a snapshot/version may
  // legitimately refine its pointer (connector URI → artifact://sha256) without
  // becoming new content, so the immutability hash intentionally excludes both.
  const content = {
    projectId: input.projectId,
    kind: input.kind,
    title: input.title,
    summary: input.summary ?? "",
    status: input.status,
    revision: input.revision ?? 1,
    stance: input.stance,
    confidence: input.confidence,
    properties,
  };
  return {
    id: input.id,
    projectId: input.projectId,
    kind: input.kind,
    title: input.title,
    summary: input.summary ?? "",
    ...(input.status ? { status: input.status } : {}),
    revision: input.revision ?? 1,
    ...(input.uri ? { uri: input.uri } : {}),
    contentHash: hash(content),
    ...(input.stance ? { stance: input.stance } : {}),
    ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
    ...(input.sourceLocator ? { sourceLocator: input.sourceLocator } : {}),
    properties,
    createdAt,
    updatedAt,
  };
}

export class LadybugResearchGraphStore implements ResearchGraphStore {
  private readonly database: Database;
  private readonly writeConnection: Connection;
  private readonly readConnection: Connection;
  private initialized = false;
  private initializePromise: Promise<void> | undefined;
  private closed = false;
  private writeTail: Promise<unknown> = Promise.resolve();

  constructor(readonly databasePath: string) {
    this.database = new Database(databasePath);
    this.writeConnection = new Connection(this.database);
    this.readConnection = new Connection(this.database);
    this.writeConnection.setQueryTimeout(10_000);
    this.readConnection.setQueryTimeout(10_000);
  }

  async initialize(): Promise<ResearchGraphHealth> {
    if (this.closed) throw new Error("Research Graph is closed");
    if (!this.initialized) {
      this.initializePromise ??= this.initializeStorage().catch((error: unknown) => {
        this.initializePromise = undefined;
        throw error;
      });
      await this.initializePromise;
    }
    return {
      engine: "ladybugdb",
      engineVersion: Database.getVersion(),
      storageVersion: Database.getStorageVersion().toString(),
      schemaVersion: RESEARCH_GRAPH_SCHEMA_VERSION,
    };
  }

  async applyChangeSet(changeSet: ResearchGraphChangeSet): Promise<{ nodes: number; relations: number }> {
    this.validateChangeSet(changeSet);
    return this.enqueueWrite(async () => {
      await this.initialize();
      await this.query("BEGIN TRANSACTION");
      try {
        const now = new Date().toISOString();
        for (const input of changeSet.nodes) await this.upsertEntity(normalizedEntity(input, now));
        for (const relation of changeSet.relations) await this.upsertRelation(relation, now);
        await this.query("COMMIT");
        return { nodes: changeSet.nodes.length, relations: changeSet.relations.length };
      } catch (error) {
        try {
          await this.query("ROLLBACK");
        } catch {
          // The original error is more actionable; a reconnect/recovery smoke verifies WAL safety.
        }
        throw error;
      }
    });
  }

  async applyProjection(envelope: ResearchGraphProjectionEnvelope): Promise<ResearchGraphProjectionApplyResult> {
    if (!envelope.projectionKey.trim()) throw new Error("Research Graph projection requires a projectionKey");
    if (!envelope.sourceId.trim()) throw new Error("Research Graph projection requires a sourceId");
    this.validateChangeSet(envelope.changeSet);
    const sourceHash = hash({ source: envelope.source, sourceId: envelope.sourceId, changeSet: envelope.changeSet });
    return this.enqueueWrite(async () => {
      await this.initialize();
      await this.query("BEGIN TRANSACTION");
      try {
        const existing = await this.executeWrite(
          "MATCH (ledger:ProjectionLedger {projectionKey: $projectionKey}) RETURN ledger.sourceHash AS sourceHash",
          { projectionKey: envelope.projectionKey },
        );
        if (existing[0]) {
          if (asString(existing[0].sourceHash, "projection sourceHash") !== sourceHash) {
            throw new Error(`Research Graph projection key conflict: ${envelope.projectionKey}`);
          }
          await this.query("COMMIT");
          return { applied: false, nodes: 0, relations: 0 };
        }
        const appliedAt = new Date().toISOString();
        for (const input of envelope.changeSet.nodes) await this.upsertEntity(normalizedEntity(input, appliedAt));
        for (const relation of envelope.changeSet.relations) await this.upsertRelation(relation, appliedAt);
        await this.executeWrite(
          `CREATE (:ProjectionLedger {
            projectionKey: $projectionKey, projectId: $projectId, source: $source,
            sourceId: $sourceId, sourceHash: $sourceHash, appliedAt: $appliedAt
          })`,
          {
            projectionKey: envelope.projectionKey,
            projectId: envelope.changeSet.projectId,
            source: envelope.source,
            sourceId: envelope.sourceId,
            sourceHash,
            appliedAt,
          },
        );
        await this.query("COMMIT");
        return { applied: true, nodes: envelope.changeSet.nodes.length, relations: envelope.changeSet.relations.length };
      } catch (error) {
        try { await this.query("ROLLBACK"); } catch { /* preserve the original failure */ }
        throw error;
      }
    });
  }

  async getEntity(projectId: string, entityId: string): Promise<ResearchGraphEntity | undefined> {
    await this.initialize();
    const rows = await this.execute(
      `MATCH (node:ResearchNode {graphId: $graphId}) RETURN ${entityReturn("node")}`,
      { graphId: graphId(projectId, entityId) },
    );
    return rows[0] ? toEntity(rows[0]) : undefined;
  }

  async getProjection(projectId: string, view: ResearchGraphView = "all"): Promise<ResearchGraphProjection> {
    await this.initialize();
    const nodeRows = await this.execute(
      `MATCH (node:ResearchNode) WHERE node.projectId = $projectId RETURN ${entityReturn("node")}`,
      { projectId },
    );
    const allowedNodeKinds = viewNodeKinds[view];
    const nodes = nodeRows.map((row) => toEntity(row)).filter((node) => !allowedNodeKinds || allowedNodeKinds.has(node.kind));
    const visibleNodeIds = new Set(nodes.map((node) => node.id));
    const relations: ResearchGraphRelation[] = [];
    for (const kind of viewRelationKinds[view]) {
      const rows = await this.execute(
        `MATCH (source:ResearchNode)-[relation:${kind}]->(target:ResearchNode)
         WHERE relation.projectId = $projectId
         RETURN relation.id AS id, relation.projectId AS projectId, source.id AS sourceId, target.id AS targetId,
                relation.propertiesJson AS propertiesJson, relation.createdAt AS createdAt, relation.updatedAt AS updatedAt`,
        { projectId },
      );
      for (const row of rows) {
        const sourceId = asString(row.sourceId, "relation sourceId");
        const targetId = asString(row.targetId, "relation targetId");
        if (!visibleNodeIds.has(sourceId) || !visibleNodeIds.has(targetId)) continue;
        relations.push({
          id: asString(row.id, "relation id"),
          projectId: asString(row.projectId, "relation projectId"),
          kind,
          sourceId,
          targetId,
          properties: parseProperties(row.propertiesJson),
          createdAt: asString(row.createdAt, "relation createdAt"),
          updatedAt: asString(row.updatedAt, "relation updatedAt"),
        });
      }
    }
    return { projectId, view, nodes, relations, generatedAt: new Date().toISOString() };
  }

  async getEvidenceForClaim(projectId: string, claimId: string): Promise<EvidenceAssertionView[]> {
    await this.initialize();
    const rows = await this.execute(
      `MATCH (assertion:ResearchNode)-[:ASSERTS]->(claim:ResearchNode),
             (assertion)-[:BASED_ON]->(source:ResearchNode)
       WHERE claim.id = $claimId AND claim.projectId = $projectId AND assertion.projectId = $projectId
       RETURN assertion.id AS assertionId, assertion.title AS assertionTitle, assertion.stance AS stance,
              assertion.confidence AS confidence, source.id AS sourceId, source.kind AS sourceKind,
              source.title AS sourceTitle, source.sourceLocator AS sourceLocator`,
      { projectId, claimId },
    );
    return rows.map((row) => {
      const confidence = optionalNumber(row.confidence);
      const sourceLocator = optionalString(row.sourceLocator);
      return {
        assertionId: asString(row.assertionId, "assertionId"),
        assertionTitle: asString(row.assertionTitle, "assertionTitle"),
        stance: asString(row.stance, "evidence stance") as EvidenceStance,
        ...(confidence !== undefined ? { confidence } : {}),
        sourceId: asString(row.sourceId, "evidence sourceId"),
        sourceKind: asString(row.sourceKind, "evidence sourceKind") as ResearchEntityKind,
        sourceTitle: asString(row.sourceTitle, "evidence sourceTitle"),
        ...(sourceLocator ? { sourceLocator } : {}),
      };
    });
  }

  async traceArtifact(projectId: string, artifactVersionId: string): Promise<ArtifactLineageView | undefined> {
    await this.initialize();
    const artifact = await this.getEntity(projectId, artifactVersionId);
    if (!artifact || artifact.kind !== "ArtifactVersion") return undefined;
    const runRows = await this.execute(
      `MATCH (run:ResearchNode)-[:GENERATED]->(artifact:ResearchNode {id: $artifactVersionId})
       WHERE run.projectId = $projectId RETURN ${entityReturn("run", "run_")}`,
      { projectId, artifactVersionId },
    );
    const run = runRows[0] ? toEntity(runRows[0], "run_") : undefined;
    if (!run) return { artifact, inputs: [], reviews: [] };
    const inputRows = await this.execute(
      `MATCH (run:ResearchNode {id: $runId})-[:USED]->(input:ResearchNode)
       WHERE run.projectId = $projectId RETURN ${entityReturn("input")}`,
      { projectId, runId: run.id },
    );
    const reviewRows = await this.execute(
      `MATCH (review:ResearchNode)-[:EVALUATES]->(run:ResearchNode {id: $runId})
       WHERE review.projectId = $projectId RETURN ${entityReturn("review")}`,
      { projectId, runId: run.id },
    );
    return { artifact, run, inputs: inputRows.map((row) => toEntity(row)), reviews: reviewRows.map((row) => toEntity(row)) };
  }

  async checkpoint(): Promise<void> {
    await this.enqueueWrite(async () => {
      await this.initialize();
      await this.query("CHECKPOINT");
    });
  }

  async close(): Promise<void> {
    await this.writeTail.catch(() => undefined);
    if (this.closed) return;
    await this.readConnection.close();
    await this.writeConnection.close();
    await this.database.close();
    this.closed = true;
  }

  private async upsertEntity(entity: ResearchGraphEntity): Promise<void> {
    // Versioned scientific facts are append-only: an id collision with a
    // different contentHash means the caller is trying to rewrite history and
    // must publish a new revision (SUPERSEDES) instead.
    if (IMMUTABLE_ENTITY_KINDS.has(entity.kind)) {
      const existingRows = await this.executeWrite(
        "MATCH (node:ResearchNode {graphId: $graphId}) RETURN node.contentHash AS contentHash",
        { graphId: graphId(entity.projectId, entity.id) },
      );
      const existingHash = existingRows[0]?.contentHash;
      if (typeof existingHash === "string" && existingHash.length > 0 && existingHash !== entity.contentHash) {
        throw new Error(`Immutable ${entity.kind} ${entity.id} cannot be overwritten in project ${entity.projectId}; publish a new revision connected by SUPERSEDES instead`);
      }
    }
    await this.executeWrite(
      `MERGE (node:ResearchNode {graphId: $graphId})
       SET node.id = $id, node.projectId = $projectId, node.kind = $kind, node.title = $title, node.summary = $summary,
           node.status = $status, node.revision = $revision, node.uri = $uri, node.contentHash = $contentHash,
           node.stance = $stance, node.confidence = $confidence, node.sourceLocator = $sourceLocator,
           node.propertiesJson = $propertiesJson, node.createdAt = $createdAt, node.updatedAt = $updatedAt`,
      {
        graphId: graphId(entity.projectId, entity.id),
        id: entity.id,
        projectId: entity.projectId,
        kind: entity.kind,
        title: entity.title,
        summary: entity.summary,
        status: entity.status ?? "",
        revision: entity.revision,
        uri: entity.uri ?? "",
        contentHash: entity.contentHash,
        stance: entity.stance ?? "",
        confidence: entity.confidence ?? null,
        sourceLocator: entity.sourceLocator ?? "",
        propertiesJson: canonicalJson(entity.properties),
        createdAt: entity.createdAt,
        updatedAt: entity.updatedAt,
      },
    );
  }

  private async upsertRelation(input: ResearchGraphRelationInput, now: string): Promise<void> {
    const endpointRows = await this.executeWrite(
      `MATCH (node:ResearchNode) WHERE node.graphId = $sourceGraphId OR node.graphId = $targetGraphId
       RETURN node.id AS id, node.projectId AS projectId`,
      { sourceGraphId: graphId(input.projectId, input.sourceId), targetGraphId: graphId(input.projectId, input.targetId) },
    );
    const endpoints = new Map(endpointRows.map((row) => [asString(row.id, "endpoint id"), asString(row.projectId, "endpoint projectId")]));
    if (endpoints.get(input.sourceId) !== input.projectId || endpoints.get(input.targetId) !== input.projectId) {
      throw new Error(`Relation ${input.kind} endpoints must exist in project ${input.projectId}`);
    }
    const id = relationId(input);
    await this.executeWrite(
      `MATCH (source:ResearchNode {graphId: $sourceGraphId}), (target:ResearchNode {graphId: $targetGraphId})
       MERGE (source)-[relation:${input.kind}]->(target)
       SET relation.id = $id, relation.projectId = $projectId, relation.propertiesJson = $propertiesJson,
           relation.createdAt = $createdAt, relation.updatedAt = $updatedAt`,
      {
        sourceGraphId: graphId(input.projectId, input.sourceId),
        targetGraphId: graphId(input.projectId, input.targetId),
        id,
        projectId: input.projectId,
        propertiesJson: canonicalJson(input.properties ?? {}),
        createdAt: input.createdAt ?? now,
        updatedAt: input.updatedAt ?? now,
      },
    );
  }

  private validateChangeSet(changeSet: ResearchGraphChangeSet): void {
    if (!changeSet.projectId) throw new Error("Research Graph change set requires a projectId");
    const nodeIds = new Set<string>();
    for (const node of changeSet.nodes) {
      if (!node.id || !node.title) throw new Error("Research Graph entities require id and title");
      if (node.projectId !== changeSet.projectId) throw new Error("Research Graph change set cannot cross projects");
      if (nodeIds.has(node.id)) throw new Error(`Duplicate Research Graph entity ${node.id}`);
      nodeIds.add(node.id);
    }
    for (const relation of changeSet.relations) {
      if (relation.projectId !== changeSet.projectId) throw new Error("Research Graph change set cannot cross projects");
      if (!relationKindSet.has(relation.kind)) throw new Error(`Unsupported Research Graph relation ${relation.kind}`);
      if (relation.sourceId === relation.targetId && relation.kind !== "REFERENCES") throw new Error(`${relation.kind} cannot be a self relation`);
    }
  }

  private enqueueWrite<T>(work: () => Promise<T>): Promise<T> {
    const next = this.writeTail.then(work, work);
    this.writeTail = next.then(() => undefined, () => undefined);
    return next;
  }

  private async initializeStorage(): Promise<void> {
    await this.database.init();
    await this.writeConnection.init();
    await this.readConnection.init();
    for (const statement of schemaStatements) await this.query(statement);
    const existing = await this.rows("MATCH (meta:GraphMeta {id: 'research-graph'}) RETURN meta.schemaVersion AS schemaVersion");
    if (existing.length === 0) {
      await this.executeWrite(
        "CREATE (:GraphMeta {id: $id, schemaVersion: $schemaVersion, engineVersion: $engineVersion, createdAt: $createdAt})",
        { id: "research-graph", schemaVersion: RESEARCH_GRAPH_SCHEMA_VERSION, engineVersion: Database.getVersion(), createdAt: new Date().toISOString() },
      );
    } else {
      const storedVersion = asNumber(existing[0]?.schemaVersion, "schemaVersion");
      if (storedVersion > RESEARCH_GRAPH_SCHEMA_VERSION) throw new Error(`Research Graph schema ${storedVersion} is newer than supported ${RESEARCH_GRAPH_SCHEMA_VERSION}`);
      if (storedVersion < 1) throw new Error(`Research Graph schema migration ${storedVersion} -> ${RESEARCH_GRAPH_SCHEMA_VERSION} is not implemented`);
      if (storedVersion < RESEARCH_GRAPH_SCHEMA_VERSION) {
        await this.executeWrite(
          "MATCH (meta:GraphMeta {id: $id}) SET meta.schemaVersion = $schemaVersion, meta.engineVersion = $engineVersion",
          { id: "research-graph", schemaVersion: RESEARCH_GRAPH_SCHEMA_VERSION, engineVersion: Database.getVersion() },
        );
      }
    }
    this.initialized = true;
  }

  private async query(statement: string): Promise<void> {
    const result = await this.writeConnection.query(statement);
    if (Array.isArray(result)) {
      for (const item of result) item.close();
    } else {
      result.close();
    }
  }

  private async rows(statement: string): Promise<Record<string, LbugValue>[]> {
    const result = await this.writeConnection.query(statement);
    return this.consume(result);
  }

  private async execute(statement: string, params: Record<string, LbugValue>): Promise<Record<string, LbugValue>[]> {
    return this.executeOn(this.readConnection, statement, params);
  }

  private async executeWrite(statement: string, params: Record<string, LbugValue>): Promise<Record<string, LbugValue>[]> {
    return this.executeOn(this.writeConnection, statement, params);
  }

  private async executeOn(connection: Connection, statement: string, params: Record<string, LbugValue>): Promise<Record<string, LbugValue>[]> {
    const prepared = await connection.prepare(statement);
    if (!prepared.isSuccess()) throw new Error(prepared.getErrorMessage());
    const result = await connection.execute(prepared, params);
    return this.consume(result);
  }

  private async consume(result: QueryResult | QueryResult[]): Promise<Record<string, LbugValue>[]> {
    if (Array.isArray(result)) throw new Error("Research Graph queries must contain exactly one statement");
    try {
      return await result.getAll();
    } finally {
      result.close();
    }
  }
}
