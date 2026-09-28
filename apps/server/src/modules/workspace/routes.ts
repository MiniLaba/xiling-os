import { validationFailure } from "../../http-errors.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  branchContextSchema, chatSessionCreateSchema, idParamsSchema,
  itemCreateSchema, itemUpdateSchema, projectCreateSchema, projectIdQuerySchema,
  projectUpdateSchema, wikiCreateSchema, wikiRevisionParamsSchema, wikiRevisionSchema, wikiSearchSchema,
} from "@xiling/api-contracts";
import type { KnowledgeStore } from "@xiling/knowledge";
import type { AgentSessionRecord, SqliteAgentSessionStore } from "@xiling/agent-harness";

export const BOT_SESSION_TITLE = "Bot 交办";

export interface WorkspaceRouteDependencies {
  knowledge: KnowledgeStore;
  agentSessions: SqliteAgentSessionStore;
  onChatSessionCreated?(session: { id: string; projectId: string }): AgentSessionRecord;
  onChatSessionArchived?(session: { id: string; projectId: string }): AgentSessionRecord | undefined;
  validateDomainIds?(domainIds: string[]): string[];
  validateResearchContext(projectId: string, context: { activeNodeId: string; quotedNodeIds: string[] }): Promise<unknown>;
}

export function registerWorkspaceRoutes(app: FastifyInstance, { knowledge, agentSessions, onChatSessionCreated, onChatSessionArchived, validateDomainIds, validateResearchContext }: WorkspaceRouteDependencies): void {
  app.get("/api/v1/projects", async () => knowledge.listProjects());
  app.post("/api/v1/projects", async (request, reply) => {
    const parsed = projectCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(validationFailure(parsed.error));
    try { return reply.code(201).send(knowledge.createProject({ ...parsed.data, domainIds: validateDomainIds?.(parsed.data.domainIds) ?? parsed.data.domainIds })); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "Invalid science domain" }); }
  });
  app.patch("/api/v1/projects/:id", async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params); const body = projectUpdateSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send(validationFailure(params.error));
    if (!body.success) return reply.code(400).send(validationFailure(body.error));
    const patch: Parameters<KnowledgeStore["updateProject"]>[1] = {};
    if (body.data.name !== undefined) patch.name = body.data.name;
    if (body.data.description !== undefined) patch.description = body.data.description;
    if (body.data.researchQuestion !== undefined) patch.researchQuestion = body.data.researchQuestion;
    if (body.data.domainIds !== undefined) {
      try { patch.domainIds = validateDomainIds?.(body.data.domainIds) ?? body.data.domainIds; }
      catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "Invalid science domain" }); }
    }
    if (body.data.status !== undefined) patch.status = body.data.status;
    return knowledge.updateProject(params.data.id, patch) ?? reply.code(404).send({ error: "Project not found" });
  });
  app.delete("/api/v1/projects/:id", async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send(validationFailure(params.error));
    return knowledge.updateProject(params.data.id, { status: "archived" }) ?? reply.code(404).send({ error: "Project not found" });
  });

  app.get("/api/v1/project-items", async (request, reply) => {
    const parsed = z.object({ projectId: z.string().min(1).max(120) }).safeParse(request.query);
    return parsed.success ? knowledge.listItems(parsed.data.projectId) : reply.code(400).send(validationFailure(parsed.error));
  });
  app.post("/api/v1/project-items", async (request, reply) => {
    const parsed = itemCreateSchema.safeParse(request.body);
    return parsed.success ? reply.code(201).send(knowledge.createItem(parsed.data.projectId, parsed.data)) : reply.code(400).send(validationFailure(parsed.error));
  });
  app.patch("/api/v1/project-items/:id", async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params); const body = itemUpdateSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send(validationFailure(params.error));
    if (!body.success) return reply.code(400).send(validationFailure(body.error));
    const patch: Parameters<KnowledgeStore["updateItem"]>[1] = {};
    if (body.data.title !== undefined) patch.title = body.data.title;
    if (body.data.notes !== undefined) patch.notes = body.data.notes;
    if (body.data.status !== undefined) patch.status = body.data.status;
    return knowledge.updateItem(params.data.id, patch) ?? reply.code(404).send({ error: "Project item not found" });
  });
  app.delete("/api/v1/project-items/:id", async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send(validationFailure(params.error));
    return knowledge.deleteItem(params.data.id) ? { status: "deleted" } : reply.code(404).send({ error: "Project item not found" });
  });

  const chatSessions = (projectId: string) => knowledge.listChatSessions(projectId).filter((session) => session.title !== BOT_SESSION_TITLE);
  const ensureBotSession = (projectId: string) => {
    const existing = knowledge.listChatSessions(projectId).find((session) => session.title === BOT_SESSION_TITLE);
    if (existing) {
      if (!agentSessions.getSession(existing.id)) onChatSessionCreated?.(existing);
      return existing;
    }
    const created = knowledge.createChatSession(projectId, BOT_SESSION_TITLE);
    onChatSessionCreated?.(created);
    return created;
  };
  const botLog = (sessionId: string) => agentSessions.listSessionEntries(sessionId)
    .filter((entry) => entry.kind === "user" || entry.kind === "assistant" || entry.kind === "tool-call" || entry.kind === "tool-result")
    .map((entry) => ({ id: entry.id, kind: entry.kind, role: entry.role, text: entry.text.slice(0, 1_200), createdAt: entry.createdAt }));
  const collapseProjectConversations = (projectId: string) => {
    const sessions = chatSessions(projectId).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    if (!sessions.length) return undefined;
    const [canonical, ...extras] = sessions;
    if (canonical && !agentSessions.getSession(canonical.id)) onChatSessionCreated?.(canonical);
    for (const extra of extras) {
      const messages = agentSessions.listSessionEntries(extra.id)
        .filter((entry) => entry.role === "user" || entry.role === "assistant")
        .map((entry) => ({ id: entry.id, role: entry.role as "user" | "assistant", text: entry.text, status: "complete" as const, createdAt: entry.createdAt }));
      if (messages.length && canonical) agentSessions.importLegacyTranscript({ sessionId: canonical.id, projectId, messages });
      if (agentSessions.getSession(extra.id)) onChatSessionArchived?.(extra);
      knowledge.archiveChatSession(extra.id);
    }
    return canonical;
  };
  const ensureLongConversation = (projectId: string, title: string) => {
    const existing = collapseProjectConversations(projectId);
    if (existing) return { session: existing, created: false };
    const created = knowledge.createChatSession(projectId, title.trim() || "项目对话");
    onChatSessionCreated?.(created);
    return { session: created, created: true };
  };

  app.get("/api/v1/chat-sessions", async (request, reply) => {
    const parsed = projectIdQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send(validationFailure(parsed.error));
    if (knowledge.getProject(parsed.data.projectId)) collapseProjectConversations(parsed.data.projectId);
    const sessions = chatSessions(parsed.data.projectId);
    const summaries = agentSessions.chatSessionEntrySummaries(sessions.map(({ id }) => id));
    return sessions.map((session) => {
      const summary = summaries.get(session.id);
      return { ...session, ...(summary ? { preview: summary.preview, messageCount: summary.messageCount, updatedAt: summary.lastEntryAt } : { preview: "", messageCount: 0 }) };
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  });
  app.post("/api/v1/chat-sessions", async (request, reply) => {
    const parsed = chatSessionCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(validationFailure(parsed.error));
    const project = knowledge.getProject(parsed.data.projectId);
    if (!project || project.status === "archived") return reply.code(404).send({ error: "Project not found or archived" });
    const ensured = ensureLongConversation(parsed.data.projectId, parsed.data.title === BOT_SESSION_TITLE ? "项目对话" : parsed.data.title);
    return reply.code(ensured.created ? 201 : 200).send(ensured.session);
  });
  app.delete("/api/v1/chat-sessions/:id", async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send(validationFailure(params.error));
    if (!knowledge.getChatSession(params.data.id)) return reply.code(404).send({ error: "Chat session not found" });
    return reply.code(409).send({ error: "每个项目只保留一条长对话" });
  });
  app.get("/api/v1/chat-sessions/:id/search", async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    const query = z.object({ q: z.string().trim().min(1).max(200) }).safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid conversation search" });
    const session = knowledge.getChatSession(params.data.id);
    if (!session) return reply.code(404).send({ error: "Chat session not found" });
    const needle = query.data.q.toLocaleLowerCase();
    return agentSessions.listSessionEntries(session.id)
      .filter((entry) => (entry.role === "user" || entry.role === "assistant") && entry.text.toLocaleLowerCase().includes(needle))
      .slice(0, 20)
      .map((entry) => ({ id: entry.id, role: entry.role, excerpt: entry.text.replace(/\s+/g, " ").slice(0, 220), createdAt: entry.createdAt }));
  });
  app.get("/api/v1/chat-sessions/:id/messages", async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send(validationFailure(params.error));
    if (!knowledge.getChatSession(params.data.id)) return reply.code(404).send({ error: "Chat session not found" });
    const entries = agentSessions.listSessionEntries(params.data.id).filter((entry) => entry.role === "user" || entry.role === "assistant");
    return entries.map((entry) => {
      const attachments = entry.role === "user" ? agentSessions.getRunAttachments(entry.runId) : [];
      return { id: entry.id, sessionId: entry.sessionId, role: entry.role, text: entry.text, status: "complete", ...(attachments.length ? { attachments } : {}), createdAt: entry.createdAt };
    });
  });
  app.get("/api/v1/chat-sessions/:id/context", async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send(validationFailure(params.error));
    if (!knowledge.getChatSession(params.data.id)) return reply.code(404).send({ error: "Chat session not found" });
    return knowledge.getChatSessionContext(params.data.id) ?? reply.code(404).send({ error: "Research Graph context not set" });
  });
  app.put("/api/v1/chat-sessions/:id/context", async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params); const body = branchContextSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid Chat Research Graph context" });
    const session = knowledge.getChatSession(params.data.id);
    if (!session) return reply.code(404).send({ error: "Chat session not found" });
    try { await validateResearchContext(session.projectId, body.data); return knowledge.setChatSessionContext(params.data.id, { projectId: session.projectId, ...body.data }); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.get("/api/v1/bot/conversation", async (request, reply) => {
    const parsed = projectIdQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send(validationFailure(parsed.error));
    if (!knowledge.getProject(parsed.data.projectId)) return reply.code(404).send({ error: "Project not found" });
    const session = knowledge.listChatSessions(parsed.data.projectId).find((item) => item.title === BOT_SESSION_TITLE);
    return { sessionId: session?.id ?? null, entries: session ? botLog(session.id) : [] };
  });
  app.post("/api/v1/bot/conversation", async (request, reply) => {
    const parsed = projectIdQuerySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(validationFailure(parsed.error));
    if (!knowledge.getProject(parsed.data.projectId)) return reply.code(404).send({ error: "Project not found" });
    const session = ensureBotSession(parsed.data.projectId);
    return { sessionId: session.id, entries: botLog(session.id) };
  });

  app.get("/api/v1/wiki/pages", async (request, reply) => {
    const parsed = projectIdQuerySchema.safeParse(request.query);
    return parsed.success ? knowledge.listWikiPages(parsed.data.projectId) : reply.code(400).send(validationFailure(parsed.error));
  });
  app.get("/api/v1/wiki/search", async (request, reply) => {
    const parsed = wikiSearchSchema.safeParse(request.query);
    return parsed.success ? knowledge.searchWikiPages(parsed.data.projectId, parsed.data.q, parsed.data.limit) : reply.code(400).send(validationFailure(parsed.error));
  });
  app.post("/api/v1/wiki/pages", async (request, reply) => {
    const parsed = wikiCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(validationFailure(parsed.error));
    return reply.code(201).send(knowledge.createWikiPage({ title: parsed.data.title, markdown: parsed.data.markdown, ...(parsed.data.projectId ? { projectId: parsed.data.projectId } : {}), ...(parsed.data.artifactUris ? { artifactUris: parsed.data.artifactUris } : {}) }));
  });
  app.get("/api/v1/wiki/pages/:id", async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    return params.success ? knowledge.getWikiPage(params.data.id) ?? reply.code(404).send({ error: "Wiki page not found" }) : reply.code(400).send(validationFailure(params.error));
  });
  app.post("/api/v1/wiki/pages/:id/revisions", async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params); const body = wikiRevisionSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send(validationFailure(params.error));
    if (!body.success) return reply.code(400).send(validationFailure(body.error));
    return knowledge.reviseWikiPage(params.data.id, { markdown: body.data.markdown, ...(body.data.title ? { title: body.data.title } : {}), ...(body.data.artifactUris ? { artifactUris: body.data.artifactUris } : {}) }) ?? reply.code(404).send({ error: "Wiki page not found" });
  });
  app.post("/api/v1/wiki/pages/:id/revisions/:version/restore", async (request, reply) => {
    const params = wikiRevisionParamsSchema.safeParse(request.params);
    return params.success ? knowledge.restoreWikiRevision(params.data.id, params.data.version) ?? reply.code(404).send({ error: "Wiki page or revision not found" }) : reply.code(400).send(validationFailure(params.error));
  });
  app.delete("/api/v1/wiki/pages/:id", async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send(validationFailure(params.error));
    return knowledge.archiveWikiPage(params.data.id) ? { status: "archived" } : reply.code(404).send({ error: "Wiki page not found" });
  });
}
