import type { AgentInputAttachment, AgentStreamEvent, ModelProviderId } from "@xiling/contracts";
import { jsonInit } from "./api-client.js";
import { streamAgentEvents } from "./agent-stream.js";

export interface ResearchTurnRequest {
  projectId: string;
  sessionId: string;
  prompt: string;
  modelRoute?: { providerId: ModelProviderId; modelId: string };
  attachments?: Array<{ name: string; modality: "image"; mimeType: string; size: number; data: string }>;
  context?: { activeNodeId: string; quotedNodeIds: string[] };
  signal?: AbortSignal;
}

export async function* runResearchTurn(request: ResearchTurnRequest): AsyncGenerator<AgentStreamEvent> {
  const clientCommandId = crypto.randomUUID();
  const startedResponse = await fetch("/api/agent-center/runs", jsonInit("POST", { sessionId: request.sessionId, projectId: request.projectId, prompt: request.prompt, clientCommandId, ...(request.modelRoute ? { modelRoute: request.modelRoute } : {}), ...(request.attachments?.length ? { attachments: request.attachments } : {}), ...(request.context ? { context: request.context } : {}) }));
  if (!startedResponse.ok) throw new Error((await startedResponse.text()) || `HTTP ${startedResponse.status}`);
  const started = await startedResponse.json() as { run: { id: string; attachments?: AgentInputAttachment[] }; entries: Array<{ id: string; kind: string }> };
  const runId = started.run.id;
  const userEntryId = started.entries.find((entry) => entry.kind === "user")?.id;
  if (!userEntryId) throw new Error("Agent run did not persist the user entry");
  yield { type: "run.accepted", runId, userEntryId, ...(started.run.attachments?.length ? { attachments: started.run.attachments } : {}) };
  const cancel = () => { void fetch(`/api/agent-center/runs/${encodeURIComponent(runId)}/cancel`, jsonInit("POST", { projectId: request.projectId })); };
  request.signal?.addEventListener("abort", cancel, { once: true });
  try {
    // Resume from the last seen sequence so a dropped connection replays only
    // the tail instead of restarting the whole stream from zero.
    let cursor = 0;
    let settled = false;
    for (let attempt = 0; attempt < 20 && !settled && !request.signal?.aborted; attempt += 1) {
      const response = await fetch(
        `/api/agent-center/runs/${encodeURIComponent(runId)}/events?projectId=${encodeURIComponent(request.projectId)}&afterSequence=${cursor}`,
        request.signal ? { signal: request.signal } : undefined,
      );
      for await (const raw of streamAgentEvents(response) as AsyncGenerator<unknown>) {
        const persisted = raw as { type?: string; payload?: unknown; sequence?: number };
        if (typeof persisted.sequence === "number" && persisted.sequence > cursor) cursor = persisted.sequence;
        const payload = persisted.payload as AgentStreamEvent | undefined;
        if (payload?.type && ["session.started", "context.ready", "message.delta", "tool.started", "tool.finished", "tool.failed", "workflow.projected", "workflow.projection.failed", "session.finished", "session.error"].includes(payload.type)) yield payload;
        if (persisted.type === "entry.persisted") {
          const entry = persisted.payload as { id: string; runId: string; kind: "user" | "assistant" | "tool-call" | "tool-result" | "compaction"; text: string; createdAt: string };
          yield { type: "entry.persisted", runId, entryId: entry.id, kind: entry.kind, text: entry.text, createdAt: entry.createdAt };
        }
        if (persisted.type === "run.completed" || persisted.type === "run.cancelled" || persisted.type === "run.suspended") { yield { type: "run.settled", runId, status: persisted.type.slice(4) as "completed" | "cancelled" | "suspended" }; settled = true; }
        if (persisted.type === "run.failed") {
          const failure = persisted.payload as { error?: string };
          yield { type: "session.error", sessionId: request.sessionId, message: failure.error ?? "Agent run failed" };
          yield { type: "run.settled", runId, status: "failed" };
          settled = true;
        }
      }
      if (!settled) await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } finally { request.signal?.removeEventListener("abort", cancel); }
}
