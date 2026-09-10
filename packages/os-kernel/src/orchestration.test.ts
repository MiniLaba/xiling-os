import test from "node:test";
import assert from "node:assert/strict";
import { OsError, agentId as makeAgentId, runId as makeRunId } from "@xiling/os-domain";
import type { AgentRuntime, RunRequest, RuntimeEvent } from "@xiling/os-runtime";
import { OSKernel } from "./kernel.js";

const literature = {
  id: "literature",
  version: "1.0.0",
  runtime: { entry: "builtin://literature" },
  provides: [{ action: "literature.search", description: "检索和阅读论文文献" }],
  permissions: ["literature.search"],
  tools: [{ name: "literature_search", description: "搜索论文", inputSchema: { type: "object" } }],
};

const climate = {
  id: "climate-data",
  version: "1.0.0",
  runtime: { entry: "builtin://climate" },
  provides: [{ action: "climate.dataset.read", description: "读取气候数据集" }],
  permissions: ["climate.dataset.read"],
  tools: [{ name: "climate_read", description: "读取气候数据", inputSchema: { type: "object" } }],
};

test("Capability Resolver：只展开任务命中的插件，目录仍保持轻量", async () => {
  const kernel = new OSKernel();
  kernel.plugins.register(literature);
  kernel.plugins.register(climate);
  const agent = await kernel.agents.create({
    name: "main", runtimeName: "scripted", allowedActions: ["literature.search", "climate.dataset.read"],
  });
  await kernel.plugins.bindToAgent(agent.id, literature.id);
  await kernel.plugins.bindToAgent(agent.id, climate.id);

  const catalog = kernel.resolver.catalogFor(agent.id);
  assert.equal(catalog.length, 2);
  assert.ok(catalog.every((entry) => !("tools" in entry)), "常驻目录不得携带工具 schema");
  const resolved = kernel.resolver.resolveForTask(agent.id, "查找并阅读三篇相关论文");
  assert.deepEqual(resolved.map((entry) => entry.pluginId), ["literature"]);
  assert.equal(resolved[0]!.manifest.tools?.length, 1);
});

test("动态 Worker：插件继承受限、记忆隔离、A2A 只传显式 ContextBundle", async () => {
  const kernel = new OSKernel();
  kernel.plugins.register(literature);
  const main = await kernel.agents.create({
    name: "main", runtimeName: "scripted", allowedActions: ["literature.search", "memory.write"],
  });
  await kernel.plugins.bindToAgent(main.id, literature.id);
  await kernel.memories.write({
    agentId: main.id, type: "semantic", content: "Main 私有笔记", dedupeKey: "private", provenance: { origin: "user" },
  });
  const delegated = await kernel.orchestrator.delegateToNewWorker({
    fromAgentId: main.id,
    name: "临时文献 Worker",
    goal: "检索三篇论文",
    context: { summary: "只研究指定主题", constraints: ["只返回题录"] },
    pluginIds: [literature.id],
  });

  const worker = kernel.agents.get(delegated.workerAgentId);
  assert.equal(worker.isMainAgent, false);
  assert.deepEqual(worker.pluginBindings.map((item) => item.pluginId), [literature.id]);
  assert.equal(kernel.memories.search(worker.id, "私有笔记").length, 0);
  const inbox = kernel.projection.inbox.get(delegated.delegationId as never);
  assert.equal(inbox?.delegation.context.summary, "只研究指定主题");
  assert.equal(JSON.stringify(inbox?.delegation.context).includes("Main 私有笔记"), false);

  await assert.rejects(
    () => kernel.orchestrator.delegateToNewWorker({
      fromAgentId: main.id, name: "越权 Worker", goal: "读取气候数据", context: {}, pluginIds: ["climate-data"],
    }),
    (error: unknown) => error instanceof OsError && error.code === "permission_denied",
  );
});

test("Agent 模型策略更新是可重放领域事实", async () => {
  const kernel = new OSKernel();
  const agent = await kernel.agents.create({ name: "main", runtimeName: "scripted", allowedActions: [] });
  const updated = kernel.agents.updateModelPolicy(agent.id, {
    preferred: { providerId: "lab", modelId: "reasoner-v2" },
    fallbacks: [{ providerId: "lab", modelId: "fast-v1" }],
  });
  assert.equal(updated.version, 2);
  const replayed = OSKernel.replayProjection(kernel.events.all());
  assert.deepEqual(replayed.agents.get(agent.id)?.modelPolicy, updated.modelPolicy);
});

test("运行收据：只记录命中工具与预算来源，不复制上下文正文", async () => {
  const kernel = new OSKernel();
  kernel.plugins.register(literature);
  kernel.plugins.register(climate);
  let receivedTools: string[] = [];
  const runtime: AgentRuntime = {
    name: "capture",
    async activate() {},
    async *run(request: RunRequest): AsyncIterable<RuntimeEvent> {
      receivedTools = request.tools.map((tool) => tool.name);
      yield { type: "run.started", runId: request.runId };
      yield { type: "run.completed", runId: request.runId };
    },
    async interrupt() {}, async suspend() {}, async resume() {},
  };
  kernel.runtimes.register(runtime);
  kernel.scheduler.setRunner({ run: async (taskId) => { await kernel.runner.executeTask(taskId); } });
  const agent = await kernel.agents.create({
    name: "main", runtimeName: runtime.name, allowedActions: ["literature.search", "climate.dataset.read"],
  });
  await kernel.plugins.bindToAgent(agent.id, literature.id);
  await kernel.plugins.bindToAgent(agent.id, climate.id);
  const task = await kernel.tasks.create({ goal: "阅读相关论文", ownerAgentId: agent.id, assignedAgentId: agent.id });
  await kernel.scheduler.tick();

  assert.deepEqual(receivedTools, ["literature_search"]);
  const receipt = [...kernel.projection.contextReceipts.values()][0]!;
  assert.deepEqual(receipt.activatedPluginIds, ["literature"]);
  assert.deepEqual(receipt.toolNames, ["literature_search"]);
  assert.deepEqual(receipt.model, { providerId: "runtime", modelId: "default" });
  assert.equal(receipt.modelCapabilitySource, "runtime-default");
  assert.ok(receipt.sections.every((section) => !("content" in section)));
});

test("运行前原生模态门禁：视频模型不兼容时不启动 Runtime", async () => {
  const kernel = new OSKernel();
  let runCount = 0;
  kernel.runtimes.register({
    name: "capture",
    async activate() {},
    async *run(request: RunRequest): AsyncIterable<RuntimeEvent> {
      runCount += 1;
      yield { type: "run.completed", runId: request.runId };
    },
    async interrupt() {}, async suspend() {}, async resume() {},
  });
  kernel.models.register({
    address: { providerId: "vendor", modelId: "text-only" },
    nativeInputs: ["text"], nativeOutputs: ["text"], contextWindowTokens: 16_000, source: "provider-catalog",
  });
  const agent = await kernel.agents.create({
    name: "main", runtimeName: "capture", allowedActions: [],
    modelPolicy: { preferred: { providerId: "vendor", modelId: "text-only" } },
  });
  const video = await kernel.artifacts.create({
    name: "transect.mp4", type: "generic", mimeType: "video/mp4", content: "fixture", creatorAgentId: agent.id,
  });
  const task = await kernel.tasks.create({
    goal: "分析视频", ownerAgentId: agent.id, assignedAgentId: agent.id,
    inputArtifacts: [{ artifactId: video.artifactId, version: video.version }],
  });
  const result = await kernel.runner.executeTask(task.id);
  assert.equal(result.state, "failed");
  assert.equal(runCount, 0);
  assert.equal(kernel.projection.contextReceipts.size, 0);
});

test("运行前原生模态门禁：模型支持视频但适配器只传文本时仍拒绝", async () => {
  const kernel = new OSKernel();
  let runCount = 0;
  kernel.runtimes.register({
    name: "text-wire",
    nativeInputModalities: ["text"], nativeOutputModalities: ["text"],
    async activate() {},
    async *run(request: RunRequest): AsyncIterable<RuntimeEvent> { runCount += 1; yield { type: "run.completed", runId: request.runId }; },
    async interrupt() {}, async suspend() {}, async resume() {},
  });
  kernel.models.register({
    address: { providerId: "vendor", modelId: "native-video" },
    nativeInputs: ["text", "video"], nativeOutputs: ["text"], contextWindowTokens: 64_000, source: "native-probe",
  });
  const agent = await kernel.agents.create({
    name: "main", runtimeName: "text-wire", allowedActions: [],
    modelPolicy: { preferred: { providerId: "vendor", modelId: "native-video" } },
  });
  const video = await kernel.artifacts.create({ name: "cast.mp4", type: "generic", mimeType: "video/mp4", content: "fixture", creatorAgentId: agent.id });
  const task = await kernel.tasks.create({
    goal: "理解原生视频", ownerAgentId: agent.id, assignedAgentId: agent.id,
    inputArtifacts: [{ artifactId: video.artifactId, version: 1 }],
  });
  const result = await kernel.runner.executeTask(task.id);
  assert.equal(result.state, "failed");
  assert.equal(runCount, 0);
  const failure = [...kernel.events.all()].reverse().find((event) => event.type === "task.failed");
  assert.match(failure?.type === "task.failed" ? failure.payload.reason : "", /不能原生传递.*输入 video/);
});

test("A2A 生命周期：运行中的父任务等待，子任务请求输入后可取消并唤醒父任务", async () => {
  const kernel = new OSKernel();
  const main = await kernel.agents.create({ name: "main", runtimeName: "scripted", allowedActions: [] });
  const worker = await kernel.agents.create({ name: "worker", runtimeName: "scripted", allowedActions: [] });
  const parent = await kernel.tasks.create({ goal: "复合研究", ownerAgentId: main.id, assignedAgentId: main.id });
  kernel.tasks.transition(parent.id, { type: "task.started", payload: { taskId: parent.id, runId: makeRunId("run_parent") } });

  const delegated = await kernel.a2a.delegate({
    fromAgentId: main.id,
    toAgentId: worker.id,
    parentTaskId: parent.id,
    goal: "核对一个子问题",
    context: { summary: "最小上下文" },
  });
  assert.equal(kernel.tasks.get(parent.id).state, "waiting_dependency");

  await kernel.a2a.reportStatus({
    delegationId: delegated.delegationId as never,
    taskId: delegated.taskId,
    fromAgentId: worker.id,
    state: "pending",
    outputArtifacts: [],
    reason: "需要用户补充范围",
  });
  assert.equal(kernel.tasks.get(delegated.taskId).state, "waiting_input");

  await kernel.a2a.cancelDelegation(delegated.delegationId, main.id, "改用另一条路线");
  assert.equal(kernel.tasks.get(delegated.taskId).state, "cancelled");
  assert.equal(kernel.tasks.get(parent.id).state, "queued");
  assert.equal(kernel.projection.inbox.get(delegated.delegationId as never)?.state, "cancelled");
});

test("A2A 回执必须匹配委托的 task 与受托 Agent", async () => {
  const kernel = new OSKernel();
  const main = await kernel.agents.create({ name: "main", runtimeName: "scripted", allowedActions: [] });
  const worker = await kernel.agents.create({ name: "worker", runtimeName: "scripted", allowedActions: [] });
  const delegated = await kernel.a2a.delegate({ fromAgentId: main.id, toAgentId: worker.id, goal: "子任务", context: {} });

  await assert.rejects(
    () => kernel.a2a.reportStatus({
      delegationId: delegated.delegationId as never,
      taskId: delegated.taskId,
      fromAgentId: makeAgentId("agent_spoof"),
      state: "completed",
      outputArtifacts: [],
    }),
    (error: unknown) => error instanceof OsError && error.code === "invalid_command",
  );
  assert.equal(kernel.tasks.get(delegated.taskId).state, "created");
});

test("A2A 外部端口：真实进度经同一 Router 回流并唤醒父任务", async () => {
  const kernel = new OSKernel();
  const main = await kernel.agents.create({ name: "main", runtimeName: "scripted", allowedActions: [] });
  const remote = await kernel.agents.create({ name: "remote", runtimeName: "external-a2a", allowedActions: [] });
  const parent = await kernel.tasks.create({ goal: "汇总远端结果", ownerAgentId: main.id, assignedAgentId: main.id });
  const delegated = await kernel.a2a.delegate({
    fromAgentId: main.id, toAgentId: remote.id, parentTaskId: parent.id, goal: "远端分析", context: { summary: "必要信息" },
  });
  const seen: string[] = [];
  kernel.a2a.registerOutbound(remote.id, {
    async execute(input) {
      seen.push(input.delegation.context.summary ?? "");
      await input.onStatus({
        delegationId: input.delegation.delegationId,
        taskId: input.task.id,
        fromAgentId: remote.id,
        state: "accepted",
        outputArtifacts: [],
      });
      await input.onStatus({
        delegationId: input.delegation.delegationId,
        taskId: input.task.id,
        fromAgentId: remote.id,
        state: "completed",
        outputArtifacts: [],
      });
    },
    async cancel() {},
  });

  await kernel.a2a.dispatch(delegated.delegationId);
  assert.deepEqual(seen, ["必要信息"]);
  assert.equal(kernel.tasks.get(delegated.taskId).state, "completed");
  assert.equal(kernel.tasks.get(parent.id).state, "queued");
  assert.equal(kernel.projection.inbox.get(delegated.delegationId as never)?.state, "completed");
});
