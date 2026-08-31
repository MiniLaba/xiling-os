import { describe, expect, it } from "vitest";
import { createApp as createAppBase } from "./app.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "@xiling/artifacts";

const oceanTestProject = { id: "ocean-heatwave", name: "海洋领域测试", description: "test fixture", researchQuestion: "层结如何变化？", domainIds: ["general-science", "ocean-climate"] };
function createApp(options: Parameters<typeof createAppBase>[0] = {}) {
  return createAppBase({ ...options, additionalProjects: [...(options.additionalProjects ?? []), oceanTestProject] });
}
type TestApp = ReturnType<typeof createAppBase>;

async function createAgentChatSession(app: TestApp, projectId: string, title: string) {
  const response = await app.inject({ method: "POST", url: "/api/v1/chat-sessions", payload: { projectId, title } });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string };
}

async function runAgentTurn(app: TestApp, input: { projectId: string; sessionId: string; prompt: string; clientCommandId: string; context?: { activeNodeId: string; quotedNodeIds: string[] } }) {
  const started = await app.inject({ method: "POST", url: "/api/agent-center/runs", payload: input });
  expect(started.statusCode).toBe(202);
  const runId = started.json().run.id as string;
  let snapshot = started.json();
  for (let attempt = 0; attempt < 1_000 && !["completed", "failed", "cancelled", "suspended"].includes(snapshot.run.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    snapshot = (await app.inject({ method: "GET", url: `/api/agent-center/runs/${runId}?projectId=${encodeURIComponent(input.projectId)}` })).json();
  }
  return snapshot as { run: { id: string; status: string; error?: string }; events: Array<{ type: string; payload: unknown }>; entries: Array<{ id: string; kind: string; text: string }> };
}

describe("server vertical slice", () => {
  it("serves project-scoped content-addressed Artifacts with integrity and lifecycle controls", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "xiling-artifact-api-"));
    const artifacts = new LocalArtifactStore(join(dataRoot, "artifacts.sqlite"), join(dataRoot, "blobs"));
    const record = await artifacts.put({ projectId: "ocean-heatwave", name: "温度摘要.csv", mimeType: "text/csv", kind: "table", data: Buffer.from("time,temp\n2023-01-01,26.4\n") });
    const app = createApp({ dataRoot, artifactStore: artifacts });

    const listed = await app.inject({ method: "GET", url: "/api/v1/artifacts?projectId=ocean-heatwave" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual([expect.objectContaining({ id: record.id, uri: record.uri, lifecycle: "available" })]);
    expect((await app.inject({ method: "GET", url: `/api/v1/artifacts/${record.id}?projectId=other-project` })).statusCode).toBe(404);

    const content = await app.inject({ method: "GET", url: `/api/v1/artifacts/${record.id}/content?projectId=ocean-heatwave&maxBytes=9` });
    expect(content.statusCode).toBe(200);
    expect(content.headers["x-artifact-truncated"]).toBe("true");
    expect(content.body).toBe("time,temp");
    expect((await app.inject({ method: "POST", url: `/api/v1/artifacts/${record.id}/verify`, payload: { projectId: "ocean-heatwave" } })).json()).toMatchObject({ valid: true, record: { id: record.id } });
    expect((await app.inject({ method: "POST", url: `/api/v1/artifacts/${record.id}/lifecycle`, payload: { projectId: "ocean-heatwave", lifecycle: "archived" } })).json()).toMatchObject({ id: record.id, lifecycle: "archived" });

    await app.close();
    artifacts.close();
  });

  it("runs a non-ocean tabular domain through plan approval, generic execution and Artifacts", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "xiling-tabular-vertical-")); const app = createApp({ dataRoot });
    const project = await app.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "实验测量", researchQuestion: "批次测量的均值和离散度如何？", domainIds: ["tabular-experiment"] } });
    const projectId = project.json().id as string; const csvText = "sample,batch,value\na,A,1\nb,A,2\nc,B,4\n";
    const planned = await app.inject({ method: "POST", url: "/api/v1/tabular/plans", payload: { projectId, csvText, numericColumns: ["value"] } });
    expect(planned.statusCode).toBe(200); expect(planned.json()).toMatchObject({ planHash: expect.stringMatching(/^[a-f0-9]{64}$/), recipe: { id: "tabular.describe" }, network: { mode: "none" } });
    expect((await app.inject({ method: "POST", url: "/api/v1/tabular/runs", payload: { projectId, csvText, numericColumns: ["value"], approvedPlanHash: "0".repeat(64), idempotencyKey: "tabular-run-1" } })).statusCode).toBe(409);
    const executed = await app.inject({ method: "POST", url: "/api/v1/tabular/runs", payload: { projectId, csvText, numericColumns: ["value"], approvedPlanHash: planned.json().planHash, idempotencyKey: "tabular-run-1" } });
    expect(executed.statusCode, executed.body).toBe(200); expect(executed.json()).toMatchObject({ status: "succeeded", result: { outputs: [expect.objectContaining({ kind: "statistical-summary", artifactUri: expect.stringMatching(/^artifact:\/\/sha256\//) })] } });
    const retried = await app.inject({ method: "POST", url: "/api/v1/tabular/runs", payload: { projectId, csvText, numericColumns: ["value"], approvedPlanHash: planned.json().planHash, idempotencyKey: "tabular-run-1" } });
    expect(retried.json().id).toBe(executed.json().id);
    expect((await app.inject({ method: "GET", url: `/api/v1/artifacts?projectId=${projectId}` })).json()).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "tabular-dataset" }), expect.objectContaining({ kind: "statistical-summary" }), expect.objectContaining({ kind: "code-snapshot" })]));
    await app.close();
  });

  it("reports health and projects only explicit Research Graph context", async () => {
    const webRoot = await mkdtemp(join(tmpdir(), "xiling-web-fixture-"));
    await writeFile(join(webRoot, "index.html"), "<!doctype html><title>汐灵 OS</title>");
    const app = createApp({ webRoot });
    const web = await app.inject({ method: "GET", url: "/" });
    expect(web.statusCode).toBe(200);
    expect(web.body).toContain("汐灵 OS");

    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    const domains = await app.inject({ method: "GET", url: "/api/science/domains" });
    expect(domains.json().domains).toEqual(expect.arrayContaining([expect.objectContaining({ id: "general-science" }), expect.objectContaining({ id: "ocean-climate" }), expect.objectContaining({ id: "tabular-experiment" })]));
    expect(domains.body).not.toContain("systemPrompt");

    const generalProject = await app.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "通用材料研究", researchQuestion: "退火如何影响强度？", domainIds: ["general-science"] } });
    expect(generalProject.statusCode).toBe(201);
    expect(generalProject.json()).toMatchObject({ domainIds: ["general-science"] });
    const unknownDomain = await app.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "未知领域", researchQuestion: "能否加载？", domainIds: ["unknown-domain"] } });
    expect(unknownDomain.statusCode).toBe(400);

    const projection = await app.inject({
      method: "POST",
      url: "/api/context/project",
      payload: { projectId: "ocean-heatwave", activeNodeId: "research-question:ocean-heatwave", quotedNodeIds: ["ocean-heatwave"], capabilityQuery: "分析 Argo 温度" },
    });
    expect(projection.statusCode, projection.body).toBe(200);
    expect(projection.json()).toMatchObject({ quotedNodeIds: ["ocean-heatwave"], activatedCapabilities: ["project.read", "ocean.subset.plan"] });
    expect(projection.json().activeBranchNodeIds.at(-1)).toBe("research-question:ocean-heatwave");
    expect(projection.json().activeBranchNodeIds.length).toBeLessThanOrEqual(9);
    await app.close();
  });

  it("removes the retired browser-owned Chat write APIs", async () => {
    const root = await mkdtemp(join(tmpdir(), "xiling-server-chat-"));
    const app = createApp({ dataRoot: root });
    expect((await app.inject({ method: "POST", url: "/api/chat/stream", payload: { sessionId: "smoke", prompt: "检查数据" } })).statusCode).toBe(404);
    const session = await createAgentChatSession(app, "ocean-heatwave", "旧写入口检查");
    expect((await app.inject({ method: "POST", url: `/api/v1/chat-sessions/${session.id}/messages`, payload: { role: "user", text: "旧写入口", status: "complete" } })).statusCode).toBe(404);
    await app.close();
  });

  it("runs the isolated Gate 4.5-B Agent center with durable snapshots and resumable event replay", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "xiling-agent-center-api-"));
    const app = createApp({ dataRoot });
    expect((await app.inject({ method: "GET", url: "/api/agent-center/status" })).json()).toMatchObject({ mode: "durable-harness-primary", messageSource: "agent-store", researchGraphContext: true, workflowProjection: "durable-server-owned", sessionFormat: 1 });
    const session = await app.inject({ method: "POST", url: "/api/v1/chat-sessions", payload: { projectId: "ocean-heatwave", title: "Agent Center 测试" } });
    expect(session.statusCode).toBe(201);
    const started = await app.inject({ method: "POST", url: "/api/agent-center/runs", payload: { sessionId: session.json().id, projectId: "ocean-heatwave", prompt: "离线检查海温数据", clientCommandId: "api-command-1" } });
    expect(started.statusCode).toBe(202);
    const runId = started.json().run.id as string;
    let snapshot = started.json();
    for (let attempt = 0; attempt < 1_000 && snapshot.run.status !== "completed"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      snapshot = (await app.inject({ method: "GET", url: `/api/agent-center/runs/${runId}?projectId=ocean-heatwave` })).json();
    }
    expect(snapshot).toMatchObject({ run: { status: "completed" }, entries: [expect.objectContaining({ kind: "user" }), expect.objectContaining({ kind: "assistant" })], usage: [expect.objectContaining({ providerId: "xiling-test-fixture", modelId: "fixture" })] });
    const replay = await app.inject({ method: "GET", url: `/api/agent-center/runs/${runId}/events?projectId=ocean-heatwave&afterSequence=1` });
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toContain("run.completed");
    expect(replay.body).not.toContain("id: 1\n");
    await app.close();

    const restored = createApp({ dataRoot });
    expect((await restored.inject({ method: "GET", url: `/api/agent-center/runs/${runId}?projectId=ocean-heatwave` })).json()).toMatchObject({ run: { status: "completed" }, recovery: { resumable: false } });
    await restored.close();
  });

  it("rejects image uploads when the selected model and Pi transport do not jointly support them", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "xiling-agent-native-modality-"));
    const app = createApp({ dataRoot });
    const session = await createAgentChatSession(app, "ocean-heatwave", "原生模态边界");
    const bytes = Buffer.from("small-image-fixture");
    const response = await app.inject({
      method: "POST",
      url: "/api/agent-center/runs",
      payload: {
        sessionId: session.id,
        projectId: "ocean-heatwave",
        prompt: "解释这张图",
        clientCommandId: "native-image-offline-1",
        attachments: [{ name: "fixture.png", modality: "image", mimeType: "image/png", size: bytes.byteLength, data: bytes.toString("base64") }],
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "unsupported_native_modality", acceptedInputModalities: ["text"] });
    await app.close();
  });

  it("keeps Agent commands project-scoped and archives the Agent session with its Knowledge chat session", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "xiling-agent-scope-"));
    const app = createApp({ dataRoot });
    const session = await app.inject({ method: "POST", url: "/api/v1/chat-sessions", payload: { projectId: "ocean-heatwave", title: "边界测试" } });
    const sessionId = session.json().id as string;
    expect((await app.inject({ method: "POST", url: `/api/v1/chat-sessions/${sessionId}/messages`, payload: { role: "user", text: "旧写入口", status: "complete" } })).statusCode).toBe(404);

    const started = await app.inject({ method: "POST", url: "/api/agent-center/runs", payload: { sessionId, projectId: "ocean-heatwave", prompt: "检查作用域", clientCommandId: "scope-command-1" } });
    expect(started.statusCode).toBe(202);
    const runId = started.json().run.id as string;
    const sourceEntryId = started.json().entries[0].id as string;
    expect((await app.inject({ method: "GET", url: `/api/agent-center/runs/${runId}` })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `/api/agent-center/runs/${runId}?projectId=other-project` })).statusCode).toBe(404);

    expect((await app.inject({ method: "DELETE", url: `/api/v1/chat-sessions/${sessionId}` })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/agent-center/runs", payload: { sessionId, projectId: "ocean-heatwave", prompt: "不可继续", clientCommandId: "scope-command-2" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/agent-center/runs/${runId}?projectId=ocean-heatwave` })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/agent-center/sources/entries/${sourceEntryId}?projectId=ocean-heatwave` })).statusCode).toBe(200);
    await app.close();
  });

  it("budgets the current prompt through the formal Agent run", async () => {
    const root = await mkdtemp(join(tmpdir(), "xiling-server-context-budget-"));
    const app = createApp({ dataRoot: root });
    const readTrace = (snapshot: { events: Array<{ type: string; payload: unknown }> }) => (snapshot.events.find((event) => event.type === "context.ready")?.payload as { trace: { estimatedInputTokens: number; cache: string } }).trace;
    const shortSession = await createAgentChatSession(app, "ocean-heatwave", "短上下文");
    const short = readTrace(await runAgentTurn(app, { projectId: "ocean-heatwave", sessionId: shortSession.id, prompt: "短问题", clientCommandId: "budget-short" }));
    const longPrompt = `请分析以下科研问题：${"海温异常与混合层变化。".repeat(500)}`;
    const longSession = await createAgentChatSession(app, "ocean-heatwave", "长上下文");
    const long = readTrace(await runAgentTurn(app, { projectId: "ocean-heatwave", sessionId: longSession.id, prompt: longPrompt, clientCommandId: "budget-long" }));
    expect(long.estimatedInputTokens).toBeGreaterThan(short.estimatedInputTokens);
    expect(short.cache).toBe("miss");
    expect(long.cache).toBe("miss");
    expect((await app.inject({ method: "GET", url: "/api/metrics/context" })).json().assemblyCache).toMatchObject({ entries: 2, estimatedTokens: expect.any(Number) });
    await app.close();
  });

  it("serves lazy connector preflights and a bounded transparent literature graph", async () => {
    const app = createApp();
    const connectors = await app.inject({ method: "GET", url: "/api/v1/connectors" });
    expect(connectors.json()).toHaveLength(4);
    const preflight = await app.inject({ method: "POST", url: "/api/v1/connectors/preflight", payload: {
      connectorId: "erddap", datasetId: "jplMURSST41", variables: ["analysed_sst"],
      region: { west: 130, east: 150, south: 10, north: 30 }, time: { start: "2023-07-01", end: "2023-07-31" }, outputFormat: "NetCDF",
    } });
    expect(preflight.json()).toMatchObject({ status: "metadata_required", connector: { id: "erddap" } });
    expect((await app.inject({ method: "GET", url: "/api/v1/literature/demo" })).statusCode).toBe(404);
    await app.close();
  });

  it("gates connector fixture execution behind metadata and a second approval", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "xiling-connector-api-"));
    const app = createApp({ dataRoot });
    const request = {
      connectorId: "erddap", datasetId: "jplMURSST41", variables: ["analysed_sst"],
      region: { west: 130, east: 150, south: 10, north: 30 }, depth: { min: 0, max: 200 },
      time: { start: "2023-07-01", end: "2023-07-31" }, outputFormat: "NetCDF",
    };
    const metadata = await app.inject({ method: "POST", url: "/api/v1/connectors/metadata", payload: request });
    expect(metadata.statusCode).toBe(200);
    expect(metadata.json()).toMatchObject({ metadata: { source: "fixture", provider: "erddap" }, preflight: { status: "ready", estimatedBytes: expect.any(Number) } });
    const prepared = await app.inject({ method: "POST", url: "/api/v1/connector-jobs", payload: { request, sourceHash: metadata.json().metadata.sourceHash } });
    expect(prepared.statusCode).toBe(201);
    expect(prepared.json()).toMatchObject({ status: "pending_approval" });
    expect((await app.inject({ method: "POST", url: `/api/v1/connector-jobs/${prepared.json().id}/run` })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `/api/v1/connector-jobs/${prepared.json().id}/approve` })).json()).toMatchObject({ status: "approved" });
    const completed = await app.inject({ method: "POST", url: `/api/v1/connector-jobs/${prepared.json().id}/run` });
    expect(completed.json()).toMatchObject({ status: "completed", artifact: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    const artifact = await app.inject({ method: "GET", url: `/api/v1/connector-artifacts/${completed.json().artifact.sha256}` });
    expect(artifact.statusCode).toBe(200); expect(artifact.json()).toMatchObject({ fixture: true, warning: "Not scientific data" });
    await app.close();
  });

  it("isolates Wiki, evidence, Research Graph and chat context by active project", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "xiling-project-context-"));
    const app = createApp({ dataRoot });
    const created = await app.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "第二项目", description: "隔离验收", researchQuestion: "第二项目的问题是什么？" } });
    const projectId = created.json().id as string;

    const page = await app.inject({ method: "POST", url: "/api/v1/wiki/pages", payload: { projectId, title: "第二项目 Wiki", markdown: "# 独立上下文" } });
    expect(page.statusCode).toBe(201);
    expect((await app.inject({ method: "GET", url: `/api/v1/wiki/pages?projectId=${projectId}` })).json()).toMatchObject([{ projectId, title: "第二项目 Wiki" }]);
    expect((await app.inject({ method: "GET", url: "/api/v1/wiki/pages?projectId=ocean-heatwave" })).body).not.toContain("第二项目 Wiki");

    const paper = { id: "paper-isolation", title: "Independent evidence record", year: 2025, authors: ["Lin"], citationCount: 1, references: [], source: "fixture" };
    expect((await app.inject({ method: "POST", url: "/api/v1/evidence", payload: { projectId, paper } })).statusCode).toBe(201);
    expect((await app.inject({ method: "GET", url: `/api/v1/evidence?projectId=${projectId}` })).json()).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: "/api/v1/evidence?projectId=ocean-heatwave" })).json()).toHaveLength(0);

    const scopedGraph = await app.inject({ method: "GET", url: `/api/projects/${projectId}/research-graph?view=evidence` });
    expect(scopedGraph.json().nodes).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "EvidenceAssertion" })]));
    expect((await app.inject({ method: "GET", url: "/api/projects/ocean-heatwave/research-graph?view=evidence" })).json().nodes).not.toEqual(expect.arrayContaining([expect.objectContaining({ kind: "EvidenceAssertion" })]));

    const session = await app.inject({ method: "POST", url: "/api/v1/chat-sessions", payload: { projectId, title: "第二项目对话" } });
    expect(session.statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: `/api/v1/chat-sessions/${session.json().id}/messages`, payload: { role: "user", text: "第二项目问题", status: "complete" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/v1/chat-sessions?projectId=${projectId}` })).json()).toMatchObject([{ title: "第二项目对话", messageCount: 0 }]);
    expect((await app.inject({ method: "GET", url: "/api/v1/chat-sessions?projectId=ocean-heatwave" })).json()).toHaveLength(0);
    const wrongProjectChat = await app.inject({ method: "POST", url: "/api/agent-center/runs", payload: { sessionId: session.json().id, projectId: "ocean-heatwave", prompt: "不应越界", clientCommandId: "cross-project" } });
    expect(wrongProjectChat.statusCode).toBe(404);

    const missing = await app.inject({ method: "POST", url: "/api/agent-center/runs", payload: { sessionId: "missing-session", projectId: "not-found", prompt: "检查上下文", clientCommandId: "missing-project" } });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it("keeps Scientific Canvas layout separate while restoring Research Graph Chat context", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "xiling-canvas-chat-context-"));
    const app = createApp({ dataRoot });
    const project = await app.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "分支上下文项目", description: "context fixture", researchQuestion: "涡旋如何影响混合层？" } });
    const projectId = project.json().id as string;
    const researchQuestionId = `research-question:${projectId}`;
    const projectEntityId = projectId;
    const saved = await app.inject({ method: "PUT", url: `/api/projects/${projectId}/research-graph/layout?view=all`, payload: { revision: 0, positions: [{ entityId: researchQuestionId, x: 400, y: 240 }, { entityId: projectEntityId, x: 400, y: 20 }], viewport: { x: 12, y: 34, zoom: 0.8 } } });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({ projectId, view: "all", revision: 1, positions: expect.arrayContaining([expect.objectContaining({ entityId: researchQuestionId, x: 400, y: 240 })]) });
    expect((await app.inject({ method: "GET", url: `/api/projects/${projectId}/research-graph` })).json().nodes).toHaveLength(2);

    const projection = await app.inject({ method: "POST", url: "/api/context/project", payload: { projectId, activeNodeId: researchQuestionId, quotedNodeIds: [projectEntityId, projectEntityId], capabilityQuery: "继续分析文献" } });
    expect(projection.statusCode, projection.body).toBe(200);
    expect(projection.json()).toMatchObject({ activeBranchNodeIds: [researchQuestionId], quotedNodeIds: [projectEntityId], activatedCapabilities: ["project.read", "literature.search"], economy: { selectedNodeCount: 2 } });
    expect(projection.json().capsules.map((capsule: { sourceNodeId: string }) => capsule.sourceNodeId)).toEqual([researchQuestionId, projectEntityId]);

    const session = await app.inject({ method: "POST", url: "/api/v1/chat-sessions", payload: { projectId, title: "暖涡分支" } });
    const sessionId = session.json().id as string;
    expect((await app.inject({ method: "PUT", url: `/api/v1/chat-sessions/${sessionId}/context`, payload: { activeNodeId: researchQuestionId, quotedNodeIds: [projectEntityId, projectEntityId] } })).json()).toMatchObject({ projectId, activeNodeId: researchQuestionId, quotedNodeIds: [projectEntityId] });
    expect((await app.inject({ method: "POST", url: `/api/v1/chat-sessions/${sessionId}/messages`, payload: { role: "user", text: "沿这个分支继续", status: "complete" } })).statusCode).toBe(404);
    const snapshot = await runAgentTurn(app, { projectId, sessionId, prompt: "沿这个科研实体继续", clientCommandId: "research-context", context: { activeNodeId: researchQuestionId, quotedNodeIds: [projectEntityId] } });
    const trace = (snapshot.events.find((event) => event.type === "context.ready")?.payload as { trace: { projectionHash: string; includedNodeIds: string[] } }).trace;
    expect(trace.projectionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(trace.includedNodeIds).toHaveLength(2);
    expect(snapshot.run.status).toBe("completed");
    expect((await app.inject({ method: "GET", url: `/api/v1/chat-sessions?projectId=${projectId}` })).json()).toMatchObject([{ id: sessionId, canvasContext: { activeNodeId: researchQuestionId, quotedNodeIds: [projectEntityId] } }]);
    expect((await app.inject({ method: "PUT", url: `/api/v1/chat-sessions/${sessionId}/context`, payload: { activeNodeId: "missing", quotedNodeIds: [] } })).statusCode).toBe(400);
    await app.close();

    const restored = createApp({ dataRoot });
    expect((await restored.inject({ method: "GET", url: `/api/v1/chat-sessions/${sessionId}/context` })).json()).toMatchObject({ projectId, activeNodeId: researchQuestionId, quotedNodeIds: [projectEntityId] });
    expect((await restored.inject({ method: "GET", url: `/api/projects/${projectId}/research-graph/layout?view=all` })).json()).toMatchObject({ revision: 1, viewport: { x: 12, y: 34, zoom: 0.8 } });
    await restored.close();
  });

  it("completes a project-scoped approval, runner, reviewer and settlement loop", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "xiling-project-loop-"));
    const app = createApp({ dataRoot, connectorMode: "fixture" });
    const project = await app.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "闭环项目", description: "fixture", researchQuestion: "数据链路是否可复现？" } });
    const projectId = project.json().id as string;
    const session = await app.inject({ method: "POST", url: "/api/v1/chat-sessions", payload: { projectId, title: "闭环验收" } });
    const request = { connectorId: "argo-gdac", datasetId: "argo-fixture", variables: ["TEMP", "PSAL", "PRES"], region: { west: 140, east: 150, south: 30, north: 40 }, depth: { min: 0, max: 200 }, time: { start: "2023-01-01", end: "2023-02-01" }, outputFormat: "NetCDF" };
    const created = await app.inject({ method: "POST", url: "/api/v1/research-workflows", payload: { projectId, sessionId: session.json().id, sourceCallId: "tool-call-fixture", request } });
    expect(created.json()).toMatchObject({ status: "draft", projectId });
    const action = (name: string, scopedProjectId = projectId) => app.inject({ method: "POST", url: `/api/v1/research-workflows/${created.json().id}/${name}`, payload: { projectId: scopedProjectId } });
    expect((await action("run")).statusCode).toBe(409);
    expect((await action("probe")).json()).toMatchObject({ status: "pending_approval", preflight: { estimatedBytes: expect.any(Number) } });
    expect((await action("approve", "ocean-heatwave")).statusCode).toBe(404);
    expect((await action("approve")).json()).toMatchObject({ status: "approved" });
    const completed = await action("run");
    expect(completed.json()).toMatchObject({ status: "completed", settledAt: expect.any(String), datasetArtifact: { uri: expect.stringMatching(/^artifact:\/\/sha256\/[a-f0-9]{64}$/) }, run: { status: "succeeded", artifactUris: expect.arrayContaining([expect.stringMatching(/^artifact:\/\/sha256\/[a-f0-9]{64}$/)]) }, review: { verdict: "rejected" } });
    expect((await app.inject({ method: "GET", url: `/api/v1/artifacts?projectId=${projectId}` })).json()).toHaveLength(4);
    expect((await app.inject({ method: "GET", url: `/api/v1/attention?projectId=${projectId}` })).json()).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "review", sourceId: completed.json().review.id, targetView: "canvas" })]));
    const artifactUri = completed.json().run.artifactUris[1] as string;
    expect((await app.inject({ method: "GET", url: `/api/v1/artifact-content?projectId=ocean-heatwave&uri=${encodeURIComponent(artifactUri)}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/v1/artifact-content?projectId=${projectId}&uri=${encodeURIComponent(artifactUri)}` })).statusCode).toBe(200);
    const researchGraph = await app.inject({ method: "GET", url: `/api/projects/${projectId}/research-graph` });
    expect(researchGraph.statusCode, researchGraph.body).toBe(200);
    expect(researchGraph.json().nodes.map((node: { kind: string }) => node.kind)).toEqual(expect.arrayContaining(["Project", "ResearchQuestion", "ResearchPlan", "Dataset", "DatasetSnapshot", "Approval", "ResearchRun", "Artifact", "ArtifactVersion", "ReviewReport", "LifecycleEvent"]));
    expect(researchGraph.json().relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "USED", sourceId: completed.json().run.id }),
      expect.objectContaining({ kind: "GENERATED", sourceId: completed.json().run.id }),
      expect.objectContaining({ kind: "EVALUATES", sourceId: completed.json().review.id, targetId: completed.json().run.id }),
    ]));
    expect((await app.inject({ method: "GET", url: `/api/v1/project-items?projectId=${projectId}` })).json()).toHaveLength(0);
    expect((await app.inject({ method: "GET", url: `/api/v1/wiki/pages?projectId=${projectId}` })).json()).toHaveLength(0);
    await app.close();
  });

  it("persists Gate 4 projects, wiki revisions and projected literature evidence", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "xiling-gate4-knowledge-"));
    const first = createApp({ dataRoot });
    const projects = await first.inject({ method: "GET", url: "/api/v1/projects" });
    const projectRows = (projects.json() as Array<{ id: string; status: string }>).sort((a, b) => a.id.localeCompare(b.id));
    expect(projectRows).toMatchObject([{ id: "free-exploration", status: "active" }, { id: "ocean-heatwave", status: "active" }]);

    const item = await first.inject({ method: "POST", url: "/api/v1/project-items", payload: { projectId: "ocean-heatwave", kind: "experiment", title: "敏感性实验", notes: "MLD 阈值" } });
    expect(item.statusCode).toBe(201);
    const updated = await first.inject({ method: "PATCH", url: `/api/v1/project-items/${item.json().id}`, payload: { status: "running" } });
    expect(updated.json()).toMatchObject({ status: "running" });

    const page = await first.inject({ method: "POST", url: "/api/v1/wiki/pages", payload: { projectId: "ocean-heatwave", title: "机制证据", markdown: "# 机制证据\n\n初稿" } });
    expect(page.statusCode).toBe(201);
    const revision = await first.inject({ method: "POST", url: `/api/v1/wiki/pages/${page.json().id}/revisions`, payload: { markdown: "# 机制证据\n\n第二版" } });
    expect(revision.json()).toMatchObject({ revisionCount: 2, currentRevision: { version: 2 } });
    expect((await first.inject({ method: "GET", url: "/api/v1/wiki/search?projectId=ocean-heatwave&q=%E7%AC%AC%E4%BA%8C%E7%89%88" })).json()).toMatchObject([{ pageId: page.json().id, version: 2 }]);
    expect((await first.inject({ method: "POST", url: `/api/v1/wiki/pages/${page.json().id}/revisions/1/restore` })).json()).toMatchObject({ revisionCount: 3, currentRevision: { version: 3, markdown: expect.stringContaining("初稿") } });

    const paperId = "paper-persistence";
    const paper = { id: paperId, title: "Persistent evidence record", year: 2025, authors: ["Lin"], citationCount: 1, references: [], source: "fixture" };
    expect((await first.inject({ method: "POST", url: "/api/v1/evidence", payload: { projectId: "ocean-heatwave", paper } })).statusCode).toBe(201);
    expect((await first.inject({ method: "POST", url: "/api/v1/evidence", payload: { projectId: "ocean-heatwave", paper } })).json()).toMatchObject({ paper: { id: paperId }, stance: "insufficient", confidence: 0.5 });
    expect((await first.inject({ method: "POST", url: `/api/v1/canvas/papers/${paperId}` })).statusCode).toBe(404);
    await first.close();

    const restored = createApp({ dataRoot });
    expect((await restored.inject({ method: "GET", url: "/api/v1/evidence?projectId=ocean-heatwave" })).json()).toHaveLength(1);
    expect((await restored.inject({ method: "GET", url: `/api/v1/wiki/pages/${page.json().id}` })).json()).toMatchObject({ revisionCount: 3 });
    const projected = await restored.inject({ method: "GET", url: "/api/projects/ocean-heatwave/research-graph?view=evidence" });
    expect(projected.json().nodes).toEqual(expect.arrayContaining([expect.objectContaining({ id: expect.stringContaining("evidence-assertion:"), kind: "EvidenceAssertion", stance: "insufficient", confidence: 0.5 })]));
    expect(projected.json().relations).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "BASED_ON" }), expect.objectContaining({ kind: "EVALUATES", targetId: "research-question:ocean-heatwave" })]));
    const overview = await restored.inject({ method: "GET", url: "/api/projects/ocean-heatwave/overview" });
    expect(overview.statusCode, overview.body).toBe(200);
    expect(overview.json()).toMatchObject({ project: { id: "ocean-heatwave" }, researchGraph: { nodes: expect.any(Array), relations: expect.any(Array) }, workflows: expect.any(Array), generatedAt: expect.any(String) });
    expect(overview.json().items).toEqual(expect.arrayContaining([expect.objectContaining({ id: item.json().id })]));
    expect(overview.json().evidence).toEqual(expect.arrayContaining([expect.objectContaining({ paper: expect.objectContaining({ id: paperId }) })]));
    await restored.close();
  });

  it("requires an accepted proposal before evidence can assert a durable claim revision", async () => {
    const app = createApp({ dataRoot: await mkdtemp(join(tmpdir(), "xiling-claim-evidence-")) });
    const proposal = await app.inject({ method: "POST", url: "/api/projects/ocean-heatwave/research-graph/proposals", payload: { type: "create_claim", title: "增强层结延长暖异常", summary: "适用于弱风和浅混合层条件。" } });
    expect(proposal.statusCode, proposal.body).toBe(201);
    const before = await app.inject({ method: "GET", url: "/api/projects/ocean-heatwave/research-graph?view=evidence" });
    expect(before.json().nodes).not.toEqual(expect.arrayContaining([expect.objectContaining({ kind: "ClaimRevision", title: "增强层结延长暖异常" })]));
    const accepted = await app.inject({ method: "POST", url: `/api/projects/ocean-heatwave/research-graph/proposals/${proposal.json().id}/decision`, payload: { decision: "accept" } });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const claimRevisionId = accepted.json().appliedEntityIds.find((id: string) => id.includes(":r1"));
    const evidence = await app.inject({ method: "POST", url: "/api/v1/evidence", payload: {
      projectId: "ocean-heatwave",
      paper: { id: "paper-claim-1", title: "Stratification and marine heatwaves", year: 2025, authors: ["Lin"], citationCount: 3, references: [], source: "fixture", url: "https://example.invalid/paper-claim-1" },
      note: "观测支持该条件性主张", sourceQuote: "Stronger stratification prolonged the surface anomaly.", sourceLocator: "https://example.invalid/paper-claim-1#page=4", limitations: "仅覆盖夏季观测", stance: "supports", confidence: 0.75, claimRevisionId,
    } });
    expect(evidence.statusCode, evidence.body).toBe(201);
    const graph = await app.inject({ method: "GET", url: "/api/projects/ocean-heatwave/research-graph?view=evidence" });
    expect(graph.json().relations).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "ASSERTS", targetId: claimRevisionId })]));
    expect(graph.json().nodes).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "SourceFragment", summary: "Stronger stratification prolonged the surface anomaly." })]));
    await app.close();
  });

  it("stores provider credentials without returning secret values and updates connector readiness", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "xiling-settings-"));
    const first = createApp({ dataRoot });
    const initial = await first.inject({ method: "GET", url: "/api/settings/providers" });
    expect(initial.json()).toHaveLength(15);
    const saved = await first.inject({ method: "PUT", url: "/api/settings/providers/copernicus-marine", payload: { values: { username: "fixture-user", password: "fixture-password" } } });
    expect(saved.json()).toMatchObject({ configured: true, source: "local", configuredFields: expect.arrayContaining(["username", "password"]) });
    expect(saved.body).not.toContain("fixture-password");
    const connectors = await first.inject({ method: "GET", url: "/api/v1/connectors" });
    expect(connectors.json().find((item: { id: string }) => item.id === "copernicus-marine")).toMatchObject({ credentialConfigured: true, credentialSource: "local" });
    await first.close();

    const restored = createApp({ dataRoot });
    expect((await restored.inject({ method: "GET", url: "/api/settings/providers" })).json().find((item: { id: string }) => item.id === "copernicus-marine")).toMatchObject({ configured: true, source: "local" });
    expect((await restored.inject({ method: "DELETE", url: "/api/settings/providers/copernicus-marine" })).json()).toMatchObject({ configured: false, source: "none" });
    await restored.close();
  });

  it("exposes installed Skill metadata without loading or returning Skill bodies", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "xiling-skill-settings-"));
    const app = createApp({ dataRoot });
    const response = await app.inject({ method: "GET", url: "/api/settings/skills" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ strategy: "lazy", skills: expect.arrayContaining([
      expect.objectContaining({ name: "literature-evidence", version: "1.0.0", loading: "on-demand", capabilities: expect.arrayContaining([expect.objectContaining({ id: "literature.search", toolName: "search_literature" })]) }),
    ]) });
    expect(response.body).not.toContain("<skill");
    expect(response.body).not.toContain("SKILL.md");
    expect(response.body).not.toContain('"path"');
    await app.close();
  });

  it("requires a real primary route and never exposes a product offline mode", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "xiling-model-settings-"));
    const first = createApp({ dataRoot, fixtureModel: false });
    const initial = await first.inject({ method: "GET", url: "/api/settings/models" });
    expect(initial.json()).toMatchObject({ runtime: { ready: false, reason: "selection_required", roleRoutes: {} }, catalog: expect.any(Array) });
    expect(initial.body).not.toContain('"mode"');
    const model = initial.json().catalog[0] as { providerId: "openai" | "anthropic" | "google" | "openrouter"; id: string };
    const blockedSave = await first.inject({ method: "PUT", url: "/api/settings/models", payload: { primary: { providerId: model.providerId, modelId: model.id, reasoning: "low" }, roleRoutes: {} } });
    expect(blockedSave.statusCode).toBe(400);
    const unconfiguredSession = await createAgentChatSession(first, "ocean-heatwave", "缺少主模型");
    const blocked = await runAgentTurn(first, { projectId: "ocean-heatwave", sessionId: unconfiguredSession.id, prompt: "不会发出公网请求", clientCommandId: "without-route" });
    expect(blocked.run).toMatchObject({ status: "failed", error: "selection_required" });
    expect((await first.inject({ method: "PUT", url: `/api/settings/providers/${model.providerId}`, payload: { values: { apiKey: "fixture-key" } } })).statusCode).toBe(200);
    const configured = await first.inject({ method: "PUT", url: "/api/settings/models", payload: { primary: { providerId: model.providerId, modelId: model.id, reasoning: "low" }, roleRoutes: { "research-explorer": { providerId: model.providerId, modelId: model.id, reasoning: "medium" } } } });
    expect(configured.json()).toMatchObject({ ready: true, reason: "ready", primary: { providerId: model.providerId, modelId: model.id }, roleRoutes: { "research-explorer": { modelId: model.id } } });
    await first.close();

    const restored = createApp({ dataRoot, fixtureModel: false });
    expect((await restored.inject({ method: "GET", url: "/api/settings/models" })).json()).toMatchObject({ runtime: { ready: true, primary: { modelId: model.id }, roleRoutes: { "research-explorer": { modelId: model.id } } } });
    await restored.close();
  });

  it("searches literature through the provider boundary and reuses the projected cache", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "xiling-literature-api-")); let calls = 0;
    const literatureFetch: typeof fetch = async (input) => {
      calls += 1; expect(String(input)).toContain("api.semanticscholar.org/graph/v1/paper/search");
      return new Response(JSON.stringify({ data: [
        { paperId: "seed-live", title: "Observed marine heatwave stratification", year: 2024, authors: [{ name: "Lin" }], citationCount: 21, references: [{ paperId: "shared" }], url: "https://example.test/seed" },
        { paperId: "related-live", title: "Mixed layer response", year: 2023, authors: [{ name: "Chen" }], citationCount: 13, references: [{ paperId: "shared" }], url: "https://example.test/related" },
      ] }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const app = createApp({ dataRoot, literatureFetch });
    const first = await app.inject({ method: "GET", url: "/api/v1/literature/search?q=marine%20heatwave&limit=20" });
    expect(first.statusCode).toBe(200); expect(first.json()).toMatchObject({ provider: "semantic-scholar", cache: "miss", papers: expect.any(Array), graph: { provider: "semantic-scholar", nodes: expect.any(Array) } });
    expect(first.body).not.toContain("ignoredAbstract");
    const cached = await app.inject({ method: "GET", url: "/api/v1/literature/search?q=marine%20heatwave&limit=20" });
    expect(cached.json()).toMatchObject({ cache: "hit", sourceHash: first.json().sourceHash }); expect(calls).toBe(1);
    await app.close();
  });
});
