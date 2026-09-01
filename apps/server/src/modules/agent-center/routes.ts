import { validationFailure } from "../../http-errors.js";
import type { FastifyInstance } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { AGENT_SESSION_FORMAT_VERSION, type ResearchAgentHarness, type SqliteAgentSessionStore } from "@xiling/agent-harness";
import { agentAttachmentUploadSchema, agentRunCommandSchema, agentSessionCreateSchema, agentCenterIdSchema } from "@xiling/api-contracts";
import type { ModelModality } from "@xiling/contracts";
import { projectAgentExecutionGraph } from "../../agent-execution-graph.js";

const id = agentCenterIdSchema;
const supportedImageMimeTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const hasBytes = (data: Buffer, offset: number, expected: number[]) => expected.every((value, index) => data[offset + index] === value);
const hasNativeImageSignature = (data: Buffer, mimeType: string) => {
  if (mimeType === "image/png") return hasBytes(data, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (mimeType === "image/jpeg") return hasBytes(data, 0, [0xff, 0xd8, 0xff]);
  if (mimeType === "image/gif") return data.subarray(0, 6).toString("ascii") === "GIF87a" || data.subarray(0, 6).toString("ascii") === "GIF89a";
  if (mimeType === "image/webp") return data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP";
  return false;
};
const attachmentUpload = agentAttachmentUploadSchema;

export interface AgentCenterRouteDependencies {
  harness: ResearchAgentHarness;
  store: SqliteAgentSessionStore;
  ready?: Promise<unknown>;
  projectExists(projectId: string): boolean;
  projectActive(projectId: string): boolean;
  sessionExists(sessionId: string, projectId: string): boolean;
  sessionTitle?(sessionId: string): string | undefined;
  listAgentRoles?(): Array<{ id: string; title: string; description: string; allowedCapabilities: string[]; defaultIsolation: string; dynamic?: boolean }>;
  acceptedInputModalities(route?: { providerId: string; modelId: string }): Promise<ModelModality[]>;
}

export function registerAgentCenterRoutes(app: FastifyInstance, dependencies: AgentCenterRouteDependencies): void {
  const { harness, store, ready, projectExists, projectActive, sessionExists, sessionTitle, listAgentRoles, acceptedInputModalities } = dependencies;

  const sessionInProject = (sessionId: string, projectId: string) => {
    const session = store.getSession(sessionId);
    return Boolean(session && session.projectId === projectId && projectExists(projectId));
  };
  const activeSessionInProject = (sessionId: string, projectId: string) => {
    const session = store.getSession(sessionId);
    return session?.status === "active" && sessionInProject(sessionId, projectId) && projectActive(projectId) && sessionExists(sessionId, projectId);
  };
  const runInProject = (runId: string, projectId: string) => {
    const run = store.getRun(runId);
    return run && sessionInProject(run.sessionId, projectId) ? run : undefined;
  };

  app.get("/api/agent-center/status", async () => ({
    mode: "durable-harness-primary",
    sessionFormat: AGENT_SESSION_FORMAT_VERSION,
    recoveredOnStartup: harness.recoveredOnStartup,
    messageSource: "agent-store",
    researchGraphContext: true,
    workflowProjection: "durable-server-owned",
    multiAgent: { enabled: true, maxConcurrency: 3, maxTasksPerDelegation: 6, recursiveDelegation: false },
  }));

  app.get("/api/agent-center/roles", async () => ({ roles: listAgentRoles?.() ?? [] }));

  app.get("/api/agent-center/delegations", async (request, reply) => {
    await ready;
    const query = z.object({ projectId: id }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "Invalid delegation query" });
    if (!projectExists(query.data.projectId)) return reply.code(404).send({ error: "Project not found" });
    return { delegations: store.listProjectDelegations(query.data.projectId) };
  });

  app.get("/api/agent-center/graph", async (request, reply) => {
    await ready;
    const query = z.object({ projectId: id, scope: z.enum(["session", "project"]).default("project"), sessionId: id.optional() }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "Invalid Agent graph request" });
    if (!projectExists(query.data.projectId)) return reply.code(404).send({ error: "Project not found" });
    if (query.data.scope === "session" && (!query.data.sessionId || !sessionInProject(query.data.sessionId, query.data.projectId))) return reply.code(404).send({ error: "Agent session not found in project" });
    return projectAgentExecutionGraph(store, {
      projectId: query.data.projectId,
      scope: query.data.scope,
      ...(query.data.sessionId ? { sessionId: query.data.sessionId } : {}),
      ...(sessionTitle ? { sessionTitle } : {}),
    });
  });

  app.post("/api/agent-center/sessions", async (request, reply) => {
    const parsed = agentSessionCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(validationFailure(parsed.error));
    if (!projectActive(parsed.data.projectId)) return reply.code(404).send({ error: "Project not found or archived" });
    if (!parsed.data.id || !sessionExists(parsed.data.id, parsed.data.projectId)) return reply.code(409).send({ error: "Create the Knowledge chat session before its Agent session" });
    try { return reply.code(201).send(harness.createSession({ projectId: parsed.data.projectId, ...(parsed.data.id ? { id: parsed.data.id } : {}) })); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
  });

  // Base64 adds roughly 33% to the raw bytes, so the HTTP envelope must be
  // larger than the 20 MB raw attachment budget enforced below.
  app.post("/api/agent-center/runs", { bodyLimit: 32 * 1024 * 1024 }, async (request, reply) => {
    await ready;
    const parsed = agentRunCommandSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(validationFailure(parsed.error));
    if (!activeSessionInProject(parsed.data.sessionId, parsed.data.projectId)) return reply.code(404).send({ error: "Agent session, chat session, or project not found" });
    const uploads = parsed.data.attachments ?? [];
    const totalSize = uploads.reduce((sum, attachment) => sum + attachment.size, 0);
    if (totalSize > 20 * 1024 * 1024) return reply.code(413).send({ error: "附件总大小不能超过 20 MB" });
    const accepted = new Set(await acceptedInputModalities(parsed.data.modelRoute));
    const unavailable = [...new Set(uploads.map((attachment) => attachment.modality).filter((modality) => !accepted.has(modality)))];
    if (unavailable.length) return reply.code(409).send({ error: `当前模型与 Pi 传输层不支持原生${unavailable.join("、")}输入`, code: "unsupported_native_modality", acceptedInputModalities: [...accepted] });
    const attachments = [];
    for (const upload of uploads) {
      if (upload.modality !== "image" || !supportedImageMimeTypes.has(upload.mimeType)) return reply.code(415).send({ error: `不支持的原生附件类型：${upload.mimeType}` });
      const data = Buffer.from(upload.data, "base64");
      if (data.byteLength !== upload.size) return reply.code(400).send({ error: `附件大小校验失败：${upload.name}` });
      if (!hasNativeImageSignature(data, upload.mimeType)) return reply.code(415).send({ error: `附件内容与图像格式不符：${upload.name}` });
      attachments.push({ id: randomUUID(), name: upload.name, modality: "image" as const, mimeType: upload.mimeType, size: data.byteLength, sha256: createHash("sha256").update(data).digest("hex"), data });
    }
    try { return reply.code(202).send(harness.startTurn({ sessionId: parsed.data.sessionId, prompt: parsed.data.prompt, clientCommandId: parsed.data.clientCommandId, ...(attachments.length ? { attachments } : {}), context: { projectId: parsed.data.projectId, ...(parsed.data.modelRoute ? { modelRoute: parsed.data.modelRoute } : {}), ...(parsed.data.context ? { context: parsed.data.context } : {}) } })); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.get("/api/agent-center/attachments/:id", async (request, reply) => {
    await ready;
    const params = z.object({ id }).safeParse(request.params);
    const query = z.object({ projectId: id }).safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid attachment request" });
    const attachment = store.getAttachment(params.data.id);
    if (!attachment || attachment.projectId !== query.data.projectId || !projectExists(query.data.projectId)) return reply.code(404).send({ error: "Attachment not found in project" });
    return reply.header("cache-control", "private, max-age=3600").type(attachment.mimeType).send(Buffer.from(attachment.data));
  });

  app.get("/api/agent-center/runs/:id", async (request, reply) => {
    await ready;
    const parsed = z.object({ id }).safeParse(request.params);
    const query = z.object({ projectId: id }).safeParse(request.query);
    if (!parsed.success || !query.success) return reply.code(400).send({ error: "Invalid run snapshot request" });
    if (!runInProject(parsed.data.id, query.data.projectId)) return reply.code(404).send({ error: "Agent run not found in project" });
    try { return harness.snapshot(parsed.data.id); }
    catch { return reply.code(404).send({ error: "Agent run not found" }); }
  });

  app.get("/api/agent-center/sources/entries/:id", async (request, reply) => {
    await ready;
    const params = z.object({ id }).safeParse(request.params);
    const query = z.object({ projectId: id, maxChars: z.coerce.number().int().min(1).max(200_000).default(50_000) }).safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid source request" });
    const entry = store.getEntry(params.data.id);
    const session = entry ? store.getSession(entry.sessionId) : undefined;
    if (!entry || !session || !sessionInProject(session.id, query.data.projectId)) return reply.code(404).send({ error: "Source entry not found in project" });
    return { id: entry.id, sessionId: entry.sessionId, runId: entry.runId, kind: entry.kind, role: entry.role, text: entry.text.slice(0, query.data.maxChars), truncated: entry.text.length > query.data.maxChars, createdAt: entry.createdAt };
  });

  app.get("/api/agent-center/runs/:id/events", async (request, reply) => {
    await ready;
    const params = z.object({ id }).safeParse(request.params);
    const query = z.object({ projectId: id, afterSequence: z.coerce.number().int().min(0).default(0) }).safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid event subscription" });
    if (!runInProject(params.data.id, query.data.projectId)) return reply.code(404).send({ error: "Agent run not found in project" });
    // EventSource reconnects carry the last seen sequence in this header; it
    // wins over the query parameter so automatic reconnects resume in order.
    const lastEventId = request.headers["last-event-id"];
    const headerValue = Array.isArray(lastEventId) ? lastEventId[0] : lastEventId;
    const headerSequence = headerValue !== undefined && /^\d+$/.test(headerValue) ? Number(headerValue) : undefined;
    const afterSequence = headerSequence ?? query.data.afterSequence;
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive" });
    // Comment-only keep-alives stop idle connections from being reaped by proxies.
    const heartbeat = setInterval(() => { if (!request.raw.destroyed && !reply.raw.destroyed) reply.raw.write(": keep-alive\n\n"); }, 15_000);
    try {
      for await (const event of harness.subscribe(params.data.id, afterSequence)) {
        if (request.raw.destroyed || reply.raw.destroyed) break;
        reply.raw.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
      }
    } catch { /* client vanished or store hiccup: close below instead of leaking the socket */ }
    finally {
      clearInterval(heartbeat);
      if (!reply.raw.destroyed) reply.raw.end();
    }
  });

  app.post("/api/agent-center/runs/:id/cancel", async (request, reply) => {
    await ready;
    const parsed = z.object({ id }).safeParse(request.params);
    const body = z.object({ projectId: id }).safeParse(request.body);
    if (!parsed.success || !body.success) return reply.code(400).send({ error: "Invalid run cancellation request" });
    const run = runInProject(parsed.data.id, body.data.projectId);
    if (!run || !activeSessionInProject(run.sessionId, body.data.projectId)) return reply.code(404).send({ error: "Agent run not found in active project session" });
    try { return harness.cancel(parsed.data.id); }
    catch { return reply.code(404).send({ error: "Agent run not found" }); }
  });

  app.post("/api/agent-center/runs/:id/resume", async (request, reply) => {
    await ready;
    const parsed = z.object({ id }).safeParse(request.params);
    const body = z.object({ projectId: id }).safeParse(request.body);
    if (!parsed.success || !body.success) return reply.code(400).send({ error: "Invalid run resume request" });
    const run = runInProject(parsed.data.id, body.data.projectId);
    if (!run || !activeSessionInProject(run.sessionId, body.data.projectId)) return reply.code(404).send({ error: "Agent run not found in active project session" });
    try { return reply.code(202).send(harness.resume(parsed.data.id)); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.post("/api/agent-center/sessions/:id/compact", async (request, reply) => {
    await ready;
    const params = z.object({ id }).safeParse(request.params);
    const body = z.object({ projectId: id, runId: id, summary: z.string().min(1).max(20_000), retainEntries: z.number().int().min(1).max(100).default(8), model: z.string().min(1).max(200).default("host-reviewed-summary"), reason: z.string().min(1).max(200).default("manual_gate_4_5_b_sample") }).safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid compaction request" });
    if (!activeSessionInProject(params.data.id, body.data.projectId) || !runInProject(body.data.runId, body.data.projectId)) return reply.code(404).send({ error: "Session or run not found in project" });
    const snapshot = (() => { try { return harness.snapshot(body.data.runId); } catch { return undefined; } })();
    if (!snapshot || snapshot.session.id !== params.data.id) return reply.code(404).send({ error: "Session or run not found" });
    const compaction = harness.compact({ sessionId: params.data.id, runId: body.data.runId, retainEntries: body.data.retainEntries, summary: body.data.summary, model: body.data.model, usage: snapshot.usageTotals, reason: body.data.reason });
    return compaction ? reply.code(201).send(compaction) : reply.code(409).send({ error: "Not enough transcript entries to compact" });
  });
}
