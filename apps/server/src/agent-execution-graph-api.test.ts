import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp as createAppBase } from "./app.js";

const createApp = (options: Parameters<typeof createAppBase>[0] = {}) => createAppBase({
  ...options,
  additionalProjects: [{ id: "ocean-heatwave", name: "海洋领域测试", description: "test fixture", researchQuestion: "层结如何变化？", domainIds: ["general-science", "ocean-climate"] }],
});

describe("Agent Execution Graph API", () => {
  it("serves project and current-session projections from the durable Agent Store", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "xiling-agent-graph-api-"));
    const app = createApp({ dataRoot });
    try {
      const created = await app.inject({ method: "POST", url: "/api/v1/chat-sessions", payload: { projectId: "ocean-heatwave", title: "运行图测试" } });
      expect(created.statusCode).toBe(201);
      const sessionId = created.json().id as string;
      const started = await app.inject({ method: "POST", url: "/api/agent-center/runs", payload: { projectId: "ocean-heatwave", sessionId, prompt: "检查运行图", clientCommandId: "graph-api-1" } });
      expect(started.statusCode).toBe(202);
      const runId = started.json().run.id as string;
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const snapshot = (await app.inject({ method: "GET", url: `/api/agent-center/runs/${runId}?projectId=ocean-heatwave` })).json();
        if (["completed", "failed", "cancelled", "suspended"].includes(snapshot.run.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      const projectGraph = await app.inject({ method: "GET", url: "/api/agent-center/graph?projectId=ocean-heatwave&scope=project" });
      expect(projectGraph.statusCode).toBe(200);
      expect(projectGraph.json()).toMatchObject({ projectId: "ocean-heatwave", scope: "project", counts: { sessions: 1, runs: 1 } });
      expect(projectGraph.json().nodes).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "session", title: "运行图测试" }), expect.objectContaining({ kind: "run", source: expect.objectContaining({ runId }) })]));

      const sessionGraph = await app.inject({ method: "GET", url: `/api/agent-center/graph?projectId=ocean-heatwave&scope=session&sessionId=${sessionId}` });
      expect(sessionGraph.statusCode).toBe(200);
      expect(sessionGraph.json()).toMatchObject({ scope: "session", sessionId });
      expect((await app.inject({ method: "GET", url: `/api/agent-center/graph?projectId=other-project&scope=session&sessionId=${sessionId}` })).statusCode).toBe(404);
      const roles = await app.inject({ method: "GET", url: "/api/agent-center/roles" });
      expect(roles.statusCode).toBe(200);
      expect(roles.json().roles).toEqual(expect.arrayContaining([expect.objectContaining({ id: "research-explorer", defaultIsolation: "scoped" }), expect.objectContaining({ id: "domain-executor", defaultIsolation: "execution" }), expect.objectContaining({ id: "independent-reviewer", defaultIsolation: "blind" })]));
      expect(JSON.stringify(roles.json())).not.toContain("systemPrompt");
    } finally { await app.close(); }
  });
});
