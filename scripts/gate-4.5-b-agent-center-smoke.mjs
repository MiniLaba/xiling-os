import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSmokeApp } from "./lib/smoke-app.mjs";

const root = await mkdtemp(join(tmpdir(), "xiling-gate-4.5-b-smoke-"));
let app;
try {
  app = createSmokeApp({ dataRoot: root, fixtureModel: true });
  const session = await app.inject({ method: "POST", url: "/api/v1/chat-sessions", payload: { projectId: "free-exploration", title: "Agent Center smoke" } });
  if (session.statusCode !== 201) throw new Error(`Agent session smoke failed: HTTP ${session.statusCode}`);
  const started = await app.inject({ method: "POST", url: "/api/agent-center/runs", payload: { sessionId: session.json().id, projectId: "free-exploration", prompt: "Gate 4.5-B offline smoke", clientCommandId: "smoke-command" } });
  if (started.statusCode !== 202) throw new Error(`Agent run smoke failed: HTTP ${started.statusCode}`);
  const runId = started.json().run.id;
  let snapshot = started.json();
  for (let attempt = 0; attempt < 100 && snapshot.run.status !== "completed"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    snapshot = (await app.inject({ method: "GET", url: `/api/agent-center/runs/${runId}?projectId=free-exploration` })).json();
  }
  if (snapshot.run.status !== "completed" || !snapshot.entries.some((entry) => entry.kind === "assistant") || !snapshot.usage.length) throw new Error("Agent center did not durably settle its offline run");
  const replay = await app.inject({ method: "GET", url: `/api/agent-center/runs/${runId}/events?projectId=free-exploration&afterSequence=0` });
  if (replay.statusCode !== 200 || !replay.body.includes("run.completed")) throw new Error("Agent event replay smoke failed");
  await app.close();
  const restored = createSmokeApp({ dataRoot: root, fixtureModel: true });
  const durable = await restored.inject({ method: "GET", url: `/api/agent-center/runs/${runId}?projectId=free-exploration` });
  if (durable.statusCode !== 200 || durable.json().run.status !== "completed") throw new Error("Agent snapshot restart smoke failed");
  await restored.close();
  console.log("Gate 4.5-B Agent center smoke: ok");
} finally {
  if (app) { try { await app.close(); } catch { /* already closed on the happy path */ } }
  await rm(root, { recursive: true, force: true });
}
