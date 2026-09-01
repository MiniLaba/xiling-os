import { validationFailure } from "../../http-errors.js";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { ArtifactLifecycle } from "@xiling/contracts";
import type { ArtifactRegistry } from "@xiling/artifacts";

const id = z.string().min(1).max(240);
const projectQuery = z.object({ projectId: id });
const readQuery = projectQuery.extend({ offsetBytes: z.coerce.number().int().min(0).default(0), maxBytes: z.coerce.number().int().min(1).max(4 * 1024 * 1024).default(256 * 1024) });
const lifecycleBody = z.object({ projectId: id, lifecycle: z.enum(["available", "quarantined", "archived"]) });

async function sendContent(reply: FastifyReply, artifacts: ArtifactRegistry, projectId: string, uriOrId: string, offsetBytes: number, maxBytes: number) {
  try {
    const result = await artifacts.read(projectId, uriOrId, offsetBytes, maxBytes);
    return reply.header("accept-ranges", "bytes").header("x-artifact-offset", result.offsetBytes).header("x-artifact-truncated", String(result.truncated)).type(result.record.mimeType).send(Buffer.from(result.data));
  } catch (error) { return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) }); }
}

export function registerArtifactRoutes(app: FastifyInstance, artifacts: ArtifactRegistry, projectExists: (projectId: string) => boolean): void {
  const requireProject = (projectId: string) => projectExists(projectId);

  app.get("/api/v1/artifacts", async (request, reply) => {
    const query = projectQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send(validationFailure(query.error));
    if (!requireProject(query.data.projectId)) return reply.code(404).send({ error: "Project not found" });
    return artifacts.list(query.data.projectId);
  });

  app.get("/api/v1/artifacts/:id", async (request, reply) => {
    const params = z.object({ id }).safeParse(request.params);
    const query = projectQuery.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid Artifact request" });
    if (!requireProject(query.data.projectId)) return reply.code(404).send({ error: "Project not found" });
    return artifacts.get(query.data.projectId, params.data.id) ?? reply.code(404).send({ error: "Artifact not found in project" });
  });

  app.get("/api/v1/artifacts/:id/content", async (request, reply) => {
    const params = z.object({ id }).safeParse(request.params);
    const query = readQuery.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid Artifact content request" });
    if (!requireProject(query.data.projectId)) return reply.code(404).send({ error: "Project not found" });
    return sendContent(reply, artifacts, query.data.projectId, params.data.id, query.data.offsetBytes, query.data.maxBytes);
  });

  app.get("/api/v1/artifact-content", async (request, reply) => {
    const query = readQuery.extend({ uri: z.string().regex(/^artifact:\/\/sha256\/[a-f0-9]{64}$/) }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "Invalid Artifact URI request" });
    if (!requireProject(query.data.projectId)) return reply.code(404).send({ error: "Project not found" });
    return sendContent(reply, artifacts, query.data.projectId, query.data.uri, query.data.offsetBytes, query.data.maxBytes);
  });

  app.post("/api/v1/artifacts/:id/verify", async (request, reply) => {
    const params = z.object({ id }).safeParse(request.params);
    const body = z.object({ projectId: id }).safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid Artifact verification request" });
    if (!requireProject(body.data.projectId)) return reply.code(404).send({ error: "Project not found" });
    try {
      const result = await artifacts.verify(body.data.projectId, params.data.id);
      return result.valid ? result : reply.code(409).send(result);
    } catch (error) { return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.post("/api/v1/artifacts/:id/lifecycle", async (request, reply) => {
    const params = z.object({ id }).safeParse(request.params);
    const body = lifecycleBody.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid Artifact lifecycle request" });
    if (!requireProject(body.data.projectId)) return reply.code(404).send({ error: "Project not found" });
    try { return artifacts.transition(body.data.projectId, params.data.id, body.data.lifecycle as ArtifactLifecycle); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
}
