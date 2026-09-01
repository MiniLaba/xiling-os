import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSmokeApp } from "./lib/smoke-app.mjs";

const root = await mkdtemp(join(tmpdir(), "xiling-gate-4.5-d-smoke-"));
try {
  const app = createSmokeApp({ dataRoot: root, connectorMode: "fixture", fixtureModel: true });
  if ((await app.inject({ method: "POST", url: "/api/chat/stream", payload: { sessionId: "legacy", prompt: "legacy" } })).statusCode !== 404) throw new Error("Retired Chat stream route is still writable");

  const project = await app.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "Gate 4.5-D", description: "ownership smoke", researchQuestion: "Is the formal Agent path durable?" } });
  const projectId = project.json().id;
  const session = await app.inject({ method: "POST", url: "/api/v1/chat-sessions", payload: { projectId, title: "formal" } });
  const sessionId = session.json().id;
  if (!projectId || !sessionId) throw new Error("Project/session setup failed");
  if ((await app.inject({ method: "POST", url: `/api/v1/chat-sessions/${sessionId}/messages`, payload: { role: "user", text: "legacy", status: "complete" } })).statusCode !== 404) throw new Error("Retired message writer is still available");

  const started = await app.inject({ method: "POST", url: "/api/agent-center/runs", payload: { projectId, sessionId, prompt: "Check the durable path", clientCommandId: "gate-4.5-d-smoke" } });
  const runId = started.json().run?.id;
  if (started.statusCode !== 202 || !runId) throw new Error("Formal Agent command was not accepted");
  let snapshot;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    snapshot = (await app.inject({ method: "GET", url: `/api/agent-center/runs/${runId}?projectId=${projectId}` })).json();
    if (["completed", "failed", "cancelled", "suspended"].includes(snapshot.run?.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (snapshot?.run?.status !== "completed" || !snapshot.entries.some((entry) => entry.kind === "assistant")) throw new Error("Formal Agent run did not settle durably");

  const request = { connectorId: "erddap", datasetId: "fixture", variables: ["sst"], region: { west: 110, east: 120, south: 10, north: 20 }, time: { start: "2024-01-01", end: "2024-01-02" }, outputFormat: "NetCDF" };
  const workflow = await app.inject({ method: "POST", url: "/api/v1/research-workflows", payload: { projectId, sessionId, sourceCallId: "manual-smoke", request } });
  if (workflow.statusCode !== 201 || workflow.json().status !== "draft") throw new Error("Approval-gated draft was not created");
  const workflowId = workflow.json().id;
  if ((await app.inject({ method: "POST", url: `/api/v1/research-workflows/${workflowId}/probe`, payload: { projectId: "ocean-heatwave" } })).statusCode !== 404) throw new Error("Workflow action crossed project scope");
  if ((await app.inject({ method: "POST", url: `/api/v1/research-workflows/${workflowId}/run`, payload: { projectId } })).statusCode !== 409) throw new Error("Unapproved workflow was executable");
  await app.close();

  const restored = createSmokeApp({ dataRoot: root, connectorMode: "fixture", fixtureModel: true });
  const messages = await restored.inject({ method: "GET", url: `/api/v1/chat-sessions/${sessionId}/messages` });
  if (messages.statusCode !== 200 || !messages.json().some((entry) => entry.role === "assistant")) throw new Error("Durable Agent transcript was not restored");
  await restored.close();
  console.log("Gate 4.5-D main-path ownership smoke: ok");
} finally {
  await rm(root, { recursive: true, force: true });
}
