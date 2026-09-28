import type { FastifyInstance } from "fastify";
import type { ResearchGraphStore } from "@xiling/research-graph";
import { researchGraphArtifactParamsSchema, researchGraphProjectParamsSchema, researchGraphProjectionQuerySchema, researchGraphProposalCreateSchema, researchGraphProposalDecisionSchema, researchGraphProposalParamsSchema, scientificCanvasLayoutSchema } from "@xiling/api-contracts";
import type { ScientificCanvasLayoutStore } from "./layout-store.js";
import { ScientificCanvasLayoutConflictError } from "./layout-store.js";
import type { ResearchGraphProposalStore } from "./proposal-store.js";

export function registerResearchGraphRoutes(app: FastifyInstance, dependencies: {
  graph: ResearchGraphStore;
  layout: ScientificCanvasLayoutStore;
  proposals: ResearchGraphProposalStore;
  ready: Promise<unknown>;
  reconcile(): Promise<unknown>;
  projectExists(projectId: string): boolean;
}): void {
  app.get("/api/research-graph/health", async () => {
    await dependencies.ready;
    return dependencies.graph.initialize();
  });

  app.get("/api/projects/:projectId/research-graph", async (request, reply) => {
    const params = researchGraphProjectParamsSchema.safeParse(request.params);
    const query = researchGraphProjectionQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid Research Graph request" });
    if (!dependencies.projectExists(params.data.projectId)) return reply.code(404).send({ error: "Project not found" });
    await dependencies.ready;
    await dependencies.reconcile();
    return dependencies.graph.getProjection(params.data.projectId, query.data.view);
  });

  app.get("/api/projects/:projectId/research-graph/proposals", async (request, reply) => {
    const params = researchGraphProjectParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid Research Graph proposal request" });
    if (!dependencies.projectExists(params.data.projectId)) return reply.code(404).send({ error: "Project not found" });
    return dependencies.proposals.list(params.data.projectId);
  });

  app.post("/api/projects/:projectId/research-graph/proposals", async (request, reply) => {
    const params = researchGraphProjectParamsSchema.safeParse(request.params);
    const body = researchGraphProposalCreateSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid Research Graph proposal" });
    if (!dependencies.projectExists(params.data.projectId)) return reply.code(404).send({ error: "Project not found" });
    if (body.data.type === "revise_claim") {
      await dependencies.ready;
      const claim = await dependencies.graph.getEntity(params.data.projectId, body.data.claimId);
      if (!claim || claim.kind !== "Claim") return reply.code(404).send({ error: "Claim not found" });
    }
    return reply.code(201).send(dependencies.proposals.create(params.data.projectId, body.data));
  });

  app.post("/api/projects/:projectId/research-graph/proposals/:proposalId/decision", async (request, reply) => {
    const params = researchGraphProposalParamsSchema.safeParse(request.params);
    const body = researchGraphProposalDecisionSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid Research Graph proposal decision" });
    if (!dependencies.projectExists(params.data.projectId)) return reply.code(404).send({ error: "Project not found" });
    const proposal = dependencies.proposals.get(params.data.projectId, params.data.proposalId);
    if (!proposal) return reply.code(404).send({ error: "Proposal not found" });
    if (proposal.status !== "pending") return reply.code(409).send({ error: "Proposal has already been decided" });
    if (body.data.decision === "reject") return dependencies.proposals.decide(params.data.projectId, params.data.proposalId, "rejected");

    await dependencies.ready;
    await dependencies.reconcile();
    if (proposal.action.type === "link_relation") {
      const action = proposal.action;
      await dependencies.graph.applyChangeSet({
        projectId: params.data.projectId,
        nodes: [],
        relations: [{ projectId: params.data.projectId, kind: action.kind, sourceId: action.sourceId, targetId: action.targetId }],
      });
      return dependencies.proposals.decide(params.data.projectId, params.data.proposalId, "accepted", [action.sourceId, action.targetId]);
    }
    const timestamp = new Date().toISOString();
    const projectNodeId = params.data.projectId;
    const questionId = `research-question:${params.data.projectId}`;
    let claimId: string;
    let revisionNumber: number;
    let previousRevisionId: string | undefined;
    if (proposal.action.type === "create_claim") {
      claimId = `claim:${proposal.id}`;
      revisionNumber = 1;
    } else {
      claimId = proposal.action.claimId;
      const projection = await dependencies.graph.getProjection(params.data.projectId, "all");
      const revisionIds = projection.relations.filter((relation) => relation.kind === "HAS_REVISION" && relation.sourceId === claimId).map((relation) => relation.targetId);
      const revisions = projection.nodes.filter((node) => revisionIds.includes(node.id) && node.kind === "ClaimRevision").sort((left, right) => right.revision - left.revision);
      revisionNumber = (revisions[0]?.revision ?? 0) + 1;
      previousRevisionId = revisions[0]?.id;
    }
    const revisionId = `${claimId}:r${revisionNumber}`;
    const action = proposal.action;
    const nodes = [
      { id: claimId, projectId: params.data.projectId, kind: "Claim" as const, title: action.title, summary: action.summary, status: "accepted" as const, revision: revisionNumber, createdAt: timestamp, updatedAt: timestamp },
      { id: revisionId, projectId: params.data.projectId, kind: "ClaimRevision" as const, title: action.title, summary: action.summary, status: "accepted" as const, revision: revisionNumber, sourceLocator: `research-graph-proposal://${proposal.id}`, createdAt: timestamp, updatedAt: timestamp },
    ];
    const relations = [
      { projectId: params.data.projectId, kind: "CONTAINS" as const, sourceId: projectNodeId, targetId: claimId },
      { projectId: params.data.projectId, kind: "HAS_REVISION" as const, sourceId: claimId, targetId: revisionId },
      { projectId: params.data.projectId, kind: "EVALUATES" as const, sourceId: revisionId, targetId: questionId },
      ...(previousRevisionId ? [{ projectId: params.data.projectId, kind: "SUPERSEDES" as const, sourceId: revisionId, targetId: previousRevisionId }] : []),
    ];
    await dependencies.graph.applyChangeSet({ projectId: params.data.projectId, nodes, relations });
    return dependencies.proposals.decide(params.data.projectId, params.data.proposalId, "accepted", [claimId, revisionId]);
  });

  app.get("/api/projects/:projectId/research-graph/layout", async (request, reply) => {
    const params = researchGraphProjectParamsSchema.safeParse(request.params);
    const query = researchGraphProjectionQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid Scientific Canvas layout request" });
    if (!dependencies.projectExists(params.data.projectId)) return reply.code(404).send({ error: "Project not found" });
    return dependencies.layout.get(params.data.projectId, query.data.view);
  });

  app.put("/api/projects/:projectId/research-graph/layout", async (request, reply) => {
    const params = researchGraphProjectParamsSchema.safeParse(request.params);
    const query = researchGraphProjectionQuerySchema.safeParse(request.query);
    const body = scientificCanvasLayoutSchema.safeParse(request.body);
    if (!params.success || !query.success || !body.success) return reply.code(400).send({ error: "Invalid Scientific Canvas layout payload" });
    if (!dependencies.projectExists(params.data.projectId)) return reply.code(404).send({ error: "Project not found" });
    await dependencies.ready;
    await dependencies.reconcile();
    const projection = await dependencies.graph.getProjection(params.data.projectId, query.data.view);
    const visibleIds = new Set(projection.nodes.map((node) => node.id));
    if (body.data.positions.some((position) => !visibleIds.has(position.entityId))) return reply.code(400).send({ error: "Layout contains an entity outside the selected Research Graph projection" });
    try {
      return dependencies.layout.save({ projectId: params.data.projectId, view: query.data.view, revision: body.data.revision, positions: body.data.positions, ...(body.data.viewport ? { viewport: body.data.viewport } : {}) });
    } catch (error) {
      if (error instanceof ScientificCanvasLayoutConflictError) return reply.code(409).send({ error: error.message, currentRevision: error.actualRevision });
      throw error;
    }
  });

  app.get("/api/projects/:projectId/research-graph/artifacts/:artifactVersionId/lineage", async (request, reply) => {
    const params = researchGraphArtifactParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid artifact lineage request" });
    if (!dependencies.projectExists(params.data.projectId)) return reply.code(404).send({ error: "Project not found" });
    await dependencies.ready;
    await dependencies.reconcile();
    const lineage = await dependencies.graph.traceArtifact(params.data.projectId, params.data.artifactVersionId);
    return lineage ?? reply.code(404).send({ error: "Artifact version not found" });
  });
}
