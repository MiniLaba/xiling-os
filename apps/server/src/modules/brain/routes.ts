import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { validationFailure } from "../../http-errors.js";
import type { BrainService } from "./service.js";

const projectQuery = z.object({ projectId: z.string().min(1).max(120), q: z.string().trim().min(1).max(200).optional(), focus: z.string().min(1).max(240).optional() });
const entityParams = z.object({ entityId: z.string().min(1).max(240) });
const noteBody = z.object({ projectId: z.string().min(1).max(120), title: z.string().trim().min(1).max(200), markdown: z.string().min(1).max(200_000), pageId: z.string().min(1).max(160).optional() });
const linkBody = z.object({
  projectId: z.string().min(1).max(120),
  kind: z.enum(["CONTAINS", "HAS_REVISION", "HAS_FRAGMENT", "CITES", "ASSERTS", "BASED_ON", "USED", "GENERATED", "DERIVED_FROM", "EVALUATES", "DOCUMENTS", "SUPERSEDES", "HAS_VERSION", "TRANSITIONED_BY", "ASSOCIATED_WITH", "REFERENCES"]),
  sourceId: z.string().min(1).max(240),
  targetId: z.string().min(1).max(240),
  summary: z.string().trim().max(2_000).optional(),
});

export function registerBrainRoutes(app: FastifyInstance, brain: BrainService, projectExists: (projectId: string) => boolean): void {
  app.get("/api/v1/brain/search", async (request, reply) => {
    const parsed = projectQuery.safeParse(request.query);
    if (!parsed.success || !parsed.data.q) return reply.code(400).send(parsed.success ? { error: "Query is required" } : validationFailure(parsed.error));
    if (!projectExists(parsed.data.projectId)) return reply.code(404).send({ error: "Project not found" });
    return brain.search(parsed.data.projectId, parsed.data.q);
  });

  app.get("/api/v1/brain/neighborhood", async (request, reply) => {
    const parsed = projectQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send(validationFailure(parsed.error));
    if (!projectExists(parsed.data.projectId)) return reply.code(404).send({ error: "Project not found" });
    return brain.neighborhood(parsed.data.projectId, parsed.data.focus);
  });

  app.get("/api/v1/brain/sources/:entityId", async (request, reply) => {
    const params = entityParams.safeParse(request.params);
    const query = projectQuery.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid Brain source request" });
    if (!projectExists(query.data.projectId)) return reply.code(404).send({ error: "Project not found" });
    return await brain.readSource(query.data.projectId, params.data.entityId) ?? reply.code(404).send({ error: "Source not found" });
  });

  app.post("/api/v1/brain/notes", async (request, reply) => {
    const parsed = noteBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(validationFailure(parsed.error));
    if (!projectExists(parsed.data.projectId)) return reply.code(404).send({ error: "Project not found" });
    try { return reply.code(201).send(brain.saveNote(parsed.data)); }
    catch (error) { return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.post("/api/v1/brain/relations", async (request, reply) => {
    const parsed = linkBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(validationFailure(parsed.error));
    if (!projectExists(parsed.data.projectId)) return reply.code(404).send({ error: "Project not found" });
    try { return await brain.link(parsed.data.projectId, parsed.data); }
    catch (error) { return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
}
