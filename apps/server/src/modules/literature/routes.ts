import { validationFailure } from "../../http-errors.js";
import type { FastifyInstance } from "fastify";
import { literatureQuerySchema, projectIdQuerySchema, scopedPaperSchema, toPaperRecord } from "@xiling/api-contracts";
import type { EvidenceStore } from "@xiling/knowledge";
import { buildLiteratureGraph, type LiteratureSearchService } from "@xiling/literature";

export function registerLiteratureRoutes(app: FastifyInstance, dependencies: { literature: LiteratureSearchService; credentialsReady: Promise<unknown>; evidence: EvidenceStore; validateClaimRevision(projectId: string, entityId: string): Promise<boolean> }): void {
  app.get("/api/v1/literature/search", async (request, reply) => {
    const parsed = literatureQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send(validationFailure(parsed.error));
    await dependencies.credentialsReady;
    try { const result = await dependencies.literature.search(parsed.data.q, parsed.data.limit); const graph = result.papers.length ? buildLiteratureGraph(result.papers, [result.papers[0]!.id], { limit: parsed.data.limit, fetchedAt: result.fetchedAt }) : undefined; return { ...result, ...(graph ? { graph } : {}) }; }
    catch (error) { return reply.code(503).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.get("/api/v1/evidence", async (request, reply) => { const parsed = projectIdQuerySchema.safeParse(request.query); return parsed.success ? dependencies.evidence.listEvidence(parsed.data.projectId) : reply.code(400).send(validationFailure(parsed.error)); });
  app.post("/api/v1/evidence", async (request, reply) => {
    const scoped = scopedPaperSchema.safeParse(request.body);
    if (scoped.success) {
      if (scoped.data.claimRevisionId && !await dependencies.validateClaimRevision(scoped.data.projectId, scoped.data.claimRevisionId)) return reply.code(400).send({ error: "Evidence target must be an existing ClaimRevision in this project" });
      return reply.code(201).send(dependencies.evidence.saveEvidence(
      scoped.data.projectId,
      toPaperRecord(scoped.data.paper),
      scoped.data.note,
      scoped.data.stance,
      scoped.data.confidence,
      {
        sourceQuote: scoped.data.sourceQuote,
        limitations: scoped.data.limitations,
        ...(scoped.data.sourceLocator ? { sourceLocator: scoped.data.sourceLocator } : {}),
        ...(scoped.data.claimRevisionId ? { claimRevisionId: scoped.data.claimRevisionId } : {}),
      },
      ));
    }
    return reply.code(400).send(validationFailure(scoped.error));
  });
}
