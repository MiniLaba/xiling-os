import { validationFailure } from "../../http-errors.js";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { idParamsSchema, projectWorkflowCreateSchema, toOceanSubsetRequest } from "@xiling/api-contracts";
import type { ConversationStore, ProjectStore } from "@xiling/knowledge";
import type { ProjectWorkflowService } from "../../project-workflow.js";

type Workflow = NonNullable<ReturnType<ProjectWorkflowService["get"]>>;

export function registerWorkflowRoutes(app: FastifyInstance, dependencies: {
  workflow: ProjectWorkflowService;
  ready: Promise<unknown>;
  projects: ProjectStore;
  conversations: ConversationStore;
  settle: (workflow: Workflow) => Promise<Workflow>;
}): void {
  const { workflow, ready, projects, conversations, settle } = dependencies;
  app.get("/api/v1/research-workflows", async (request, reply) => {
    const parsed = z.object({ projectId: z.string().min(1).max(120), sessionId: z.string().min(1).max(160).optional() }).safeParse(request.query);
    if (!parsed.success) return reply.code(400).send(validationFailure(parsed.error));
    const project = projects.getProject(parsed.data.projectId);
    if (!project || project.status === "archived") return reply.code(404).send({ error: "Project not found" });
    await ready; return workflow.list({ projectId: parsed.data.projectId, ...(parsed.data.sessionId ? { sessionId: parsed.data.sessionId } : {}) });
  });
  app.post("/api/v1/research-workflows", async (request, reply) => {
    const parsed = projectWorkflowCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(validationFailure(parsed.error));
    const project = projects.getProject(parsed.data.projectId); const session = conversations.getChatSession(parsed.data.sessionId);
    if (!project || project.status === "archived" || !session || session.projectId !== project.id) return reply.code(404).send({ error: "Project or chat session not found" });
    await ready;
    try { return reply.code(201).send(await workflow.create({ projectId: parsed.data.projectId, sessionId: parsed.data.sessionId, sourceCallId: parsed.data.sourceCallId, request: toOceanSubsetRequest(parsed.data.request) })); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
  });

  const action = async (params: unknown, body: unknown, reply: FastifyReply, name: "probe" | "approve" | "reject" | "run" | "reset" | "cancel" | "settle") => {
    const parsed = idParamsSchema.safeParse(params); if (!parsed.success) return reply.code(400).send(validationFailure(parsed.error));
    const scope = z.object({ projectId: z.string().min(1).max(120) }).safeParse(body);
    if (!scope.success) return reply.code(400).send({ error: "Workflow action requires projectId" });
    await ready;
    try {
      const current = workflow.get(parsed.data.id);
      const project = projects.getProject(scope.data.projectId);
      const session = current ? conversations.getChatSession(current.sessionId) : undefined;
      if (!current || current.projectId !== scope.data.projectId || !project || project.status === "archived" || !session || session.projectId !== project.id) return reply.code(404).send({ error: "Workflow not found in project" });
      if (name === "cancel") return workflow.cancel(parsed.data.id);
      if (name === "settle") return settle(current);
      if (name === "run") return settle(await workflow.run(parsed.data.id));
      return await workflow[name](parsed.data.id);
    } catch (error) { return reply.code(error instanceof Error && error.message.includes("not found") ? 404 : 409).send({ error: error instanceof Error ? error.message : String(error) }); }
  };
  for (const name of ["probe", "approve", "reject", "run", "reset", "cancel", "settle"] as const) {
    app.post(`/api/v1/research-workflows/:id/${name}`, async (request, reply) => action(request.params, request.body, reply, name));
  }
}
