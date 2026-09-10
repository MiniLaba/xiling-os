import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { bundledHarnessLaunch, harnessSessionId, createDefaultHarnessFactory, DeepSeekHarnessSdkRuntimeAdapter } from "@xiling/os-runtime";
import { OSKernel } from "./kernel.js";
import { taskTools } from "./runtime-tools.js";

test("real SDK tool call reaches scoped host and commits a required artifact", { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "xiling-tools-"));
  let calls = 0;
  const endpoint = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    calls++;
    const hasResult = input.messages.some((message: { role: string }) => message.role === "tool");
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const base = { id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture" };
    const delta = hasResult ? { role: "assistant", content: "Created the artifact." } : { role: "assistant", tool_calls: [{ index: 0, id: "call_fixture", type: "function", function: { name: "xiling_os", arguments: JSON.stringify({ input: JSON.stringify({ op: "artifact.create", name: "checklist.md", type: "report", content: "# Checklist\n- Prepare\n- Review" }) }) } }] };
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.end(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: hasResult ? "stop" : "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
  const address = endpoint.address(); assert.ok(address && typeof address !== "string");
  const kernel = new OSKernel();
  const runtime = new DeepSeekHarnessSdkRuntimeAdapter({ supportsHostTools: true, ownsSessionHistory: true, turnTimeoutMs: 15000,
    factory: (route, request, bridge) => {
      assert.ok(request);
      const launch = bundledHarnessLaunch();
      return createDefaultHarnessFactory({ dshBin: launch.command, dshArgs: launch.args, cwd: root, env: {
        PATH: process.env.PATH, HOME: root, TEST_API_KEY: "fixture-only",
        XILING_HARNESS_ROUTE: JSON.stringify({ provider: "fixture", model: "fixture", keyVariable: "TEST_API_KEY", bridge, tools: request.tools,
          profile: { api: "openai-completions", baseURL: `http://127.0.0.1:${address.port}/v1` }, contextWindow: 32000,
          sessionId: harnessSessionId(request), persistenceRoot: path.join(root, "sessions") }),
      } })(route);
    } });
  kernel.runtimes.register(runtime);
  kernel.modelCatalog.register({ address: { providerId: "fixture", modelId: "fixture" }, nativeInputs: ["text"], nativeOutputs: ["text"], contextWindowTokens: 32000, supportsToolUse: true, source: "user-declared" });
  try {
    const agent = await kernel.agents.create({ name: "fixture", runtimeName: runtime.name, allowedActions: ["artifact.create", "artifact.read"], modelPolicy: { preferred: { providerId: "fixture", modelId: "fixture" } } });
    const task = await kernel.tasks.create({ goal: "Deliver a report", ownerAgentId: agent.id, assignedAgentId: agent.id, outputContract: { requiredArtifactTypes: ["report"] } });
    const result = await kernel.runner.executeTask(task.id);
    assert.equal(result.state, "completed", kernel.tasks.get(task.id).statusReason);
    assert.equal(calls, 2);
    const artifact = kernel.tasks.get(task.id).outputArtifacts[0]!;
    assert.match(kernel.artifacts.contentOf(artifact.artifactId), /Checklist/);
    assert.equal(kernel.artifacts.get(artifact.artifactId).metadata.creationMode, "agent-tool");
  } finally { await runtime.close(); endpoint.closeAllConnections(); await new Promise<void>((resolve) => endpoint.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

test("OS tools reject missing policy, out-of-context artifact and stale run", async () => {
  const kernel = new OSKernel();
  const agent = await kernel.agents.create({ name: "restricted", runtimeName: "test", allowedActions: ["artifact.read"] });
  const task = await kernel.tasks.create({ goal: "test", ownerAgentId: agent.id, assignedAgentId: agent.id });
  const runId = "run-tools-test" as never;
  kernel.tasks.transition(task.id, { type: "task.started", payload: { taskId: task.id, runId } });
  const execute = taskTools(kernel, { agentId: agent.id, taskId: task.id, runId });
  await assert.rejects(execute("xiling_os", { op: "artifact.create", name: "x", content: "x" }, "denied"), /未获准/);
  await assert.rejects(execute("xiling_os", { op: "artifact.read", artifactId: "private" }, "private"), /显式/);
  await kernel.tasks.complete(task.id);
  await assert.rejects(execute("xiling_os", { op: "apps.list" }, "late"), /actively owned/);
  assert.equal(kernel.projection.artifacts.size, 0);
});

test("artifact tool derives an immutable lineage only from an explicit input", async () => {
  const kernel = new OSKernel();
  const agent = await kernel.agents.create({ name: "lineage", runtimeName: "test", allowedActions: ["artifact.create", "artifact.read"] });
  const source = await kernel.artifacts.create({ name: "source.md", type: "generic", mimeType: "text/markdown", content: "# Source", creatorAgentId: agent.id });
  const task = await kernel.tasks.create({ goal: "derive", ownerAgentId: agent.id, assignedAgentId: agent.id, inputArtifacts: [{ artifactId: source.artifactId, version: source.version }] });
  const runId = "run-lineage-test" as never;
  kernel.tasks.transition(task.id, { type: "task.started", payload: { taskId: task.id, runId } });
  const execute = taskTools(kernel, { agentId: agent.id, taskId: task.id, runId });
  const result = await execute("xiling_os", { op: "artifact.create", name: "derived.md", type: "report", content: "# Derived", sourceArtifactId: source.artifactId }, "derive-call") as { artifactId: string };
  const derived = kernel.artifacts.get(result.artifactId);
  assert.deepEqual(derived.lineage, [{ artifactId: source.artifactId, version: source.version }]);
  await assert.rejects(execute("xiling_os", { op: "artifact.create", name: "bad.md", content: "bad", sourceArtifactId: "not-visible" }, "bad-call"), /显式/);
});
