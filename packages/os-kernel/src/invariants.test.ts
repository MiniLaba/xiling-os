// AI Runtime Test Harness —— 指南 §50 要求的核心不变量测试。
// 这些测试验证的是系统安全边界，不是普通单元测试：
// Context Isolation / Capability Isolation / Workspace Isolation / Replay /
// Crash Recovery（幂等）/ Plugin 注销 / UI Security / Artifact Provenance。

import test from "node:test";
import assert from "node:assert/strict";
import {
  agentId as makeAgentId, attenuateGrant, grantId as makeGrantId,
  newId, OsError,
} from "@xiling/os-domain";
import type { CapabilityGrant } from "@xiling/os-domain";
import type { AgentRuntime } from "@xiling/os-runtime";
import { OSKernel, recoverFromEvents } from "./index.js";

function grantOf(partial: Partial<CapabilityGrant> & { subject: CapabilityGrant["subject"]; action: string; resource: string }): CapabilityGrant {
  return {
    id: makeGrantId(newId("grant")),
    issuer: "user",
    taskId: undefined,
    constraints: undefined,
    expiresAt: undefined,
    createdAt: new Date().toISOString(),
    ...partial,
  };
}

test("Context Isolation：Agent B 无法搜索/导出 Agent A 的记忆", async () => {
  const kernel = new OSKernel();
  const agentA = await kernel.agents.create({ name: "A", runtimeName: "scripted", allowedActions: ["memory.write"] });
  const agentB = await kernel.agents.create({ name: "B", runtimeName: "scripted", allowedActions: ["memory.write"] });

  await kernel.memories.write({
    agentId: agentA.id,
    type: "semantic",
    content: { secret: "A 的私有研究笔记" },
    dedupeKey: "notes",
    provenance: { origin: "user" },
  });

  // B 的命名空间里搜不到 A 的内容（物理隔离：查询接口没有跨 Agent 参数）
  const found = kernel.memories.search(agentB.id, "私有研究笔记");
  assert.equal(found.length, 0);

  // B 直接导出 A 的记录 → 拒绝
  const recordId = [...kernel.projection.memories.keys()][0];
  assert.ok(recordId !== undefined);
  await assert.rejects(
    () => kernel.memories.exportForDelegation(agentB.id, [recordId]),
    (error: unknown) => error instanceof OsError && error.code === "permission_denied",
  );
});

test("Capability Isolation：delegated ⊆ owned（越界衰减被拒绝）", () => {
  const owned = grantOf({
    subject: makeAgentId("agent_main"),
    action: "github.repo.write:*",
    resource: "repo/project-x",
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  });

  // 资源越界：owned 只覆盖 repo/project-x，请求 repo/other
  assert.throws(
    () => attenuateGrant(owned, { subject: makeAgentId("agent_worker"), action: "github.repo.write", resource: "repo/other" }, () => newId("grant")),
    /attenuation denied/,
  );

  // 时间越界：请求比 owned 更长的有效期 → 被截断到 owned 的有效期
  const shortened = attenuateGrant(
    owned,
    { subject: makeAgentId("agent_worker"), action: "github.repo.write", resource: "repo/project-x", expiresInMinutes: 999 },
    () => newId("grant"),
  );
  assert.ok(new Date(shortened.expiresAt!) <= new Date(owned.expiresAt!));
  assert.equal(shortened.issuer, owned.subject);
  // 裸 action 被 ":*" 通配覆盖
  assert.equal(shortened.action, "github.repo.write");
});

test("Capability：过期授权不再覆盖", () => {
  const expired = grantOf({
    subject: makeAgentId("agent_a"),
    action: "artifact.read",
    resource: "*",
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  const kernel = new OSKernel();
  kernel.emit("capability.granted", { grant: expired });
  const verdict = kernel.capabilities.check({ subject: expired.subject, action: "artifact.read", resource: "anything" });
  assert.equal(verdict.allowed, false);
});

test("Workspace Isolation：mount 外不可访问，路径逃逸被拒绝", async () => {
  const kernel = new OSKernel();
  const owner = await kernel.agents.create({ name: "owner", runtimeName: "scripted", allowedActions: [] });
  const worker = await kernel.agents.create({ name: "worker", runtimeName: "scripted", allowedActions: [] });
  const workspace = await kernel.workspaces.create(owner.id, "/tmp/xiling-ws");
  const task = await kernel.tasks.create({ goal: "demo", ownerAgentId: owner.id });

  // 只挂载 frontend 子树
  await kernel.workspaces.mount({
    sourceWorkspaceId: workspace.workspaceId,
    path: "project/frontend",
    targetAgentId: worker.id,
    access: "read",
    taskId: task.id,
  });

  assert.equal(kernel.workspaces.checkAccess(worker.id, workspace.workspaceId, "project/frontend/src/main.ts", "read").allowed, true);
  assert.equal(kernel.workspaces.checkAccess(worker.id, workspace.workspaceId, "project/backend/secret.pem", "read").allowed, false);
  assert.equal(kernel.workspaces.checkAccess(worker.id, workspace.workspaceId, "project/frontend/index.html", "write").allowed, false);
  // 路径逃逸（../）直接判定为非法
  assert.equal(kernel.workspaces.checkAccess(worker.id, workspace.workspaceId, "../../etc/passwd", "read").allowed, false);
});

test("Replay：相同事件流重建相同投影", async () => {
  const kernel = new OSKernel();
  const agent = await kernel.agents.create({ name: "replay", runtimeName: "scripted", allowedActions: [] });
  await kernel.tasks.create({ goal: "计算任务", ownerAgentId: agent.id });
  await kernel.memories.write({ agentId: agent.id, type: "semantic", content: "事实", dedupeKey: "k1", provenance: { origin: "user" } });

  const events = kernel.events.all();
  const replayed = OSKernel.replayProjection(events);
  assert.equal(replayed.agents.size, kernel.projection.agents.size);
  assert.equal(replayed.tasks.size, kernel.projection.tasks.size);
  assert.equal(replayed.memories.size, kernel.projection.memories.size);
  assert.deepEqual(
    [...replayed.tasks.values()].map((task) => [task.id, task.state]),
    [...kernel.projection.tasks.values()].map((task) => [task.id, task.state]),
  );
});

test("Crash Recovery：重启后幂等键防止副作用重复执行", async () => {
  const persisted: string[] = [];
  const kernel = new OSKernel({ eventHooks: { append: (event) => persisted.push(JSON.stringify(event)) } });
  const agent = await kernel.agents.create({ name: "worker", runtimeName: "scripted", allowedActions: [] });
  kernel.runtimes.register({ name: "scripted", async activate() {}, async *run() {}, async interrupt() {}, async suspend() {}, async resume() {} });
  await kernel.agents.activate(agent.id);
  const task = await kernel.tasks.create({ goal: "发邮件", ownerAgentId: agent.id, assignedAgentId: agent.id });
  const toolCallId = newId("call");

  kernel.emit("tool.executed", {
    taskId: task.id,
    toolCallId,
    name: "email.send",
    idempotencyKey: `${task.id}:${toolCallId}`,
    output: { ok: true },
  });

  // ---- 崩溃重启：从持久化事件恢复 ----
  const restored = new OSKernel();
  for (const line of persisted) restored.events.append(JSON.parse(line));
  const recovery = recoverFromEvents(restored, restored.events.all());
  assert.ok(recovery.eventsReplayed >= 3);
  assert.ok(recovery.projection.executedSideEffects.has(`${task.id}:${toolCallId}`));

  // 恢复后的 Run Loop 重放同一 tool call → duplicate_side_effect（不会发送第二封邮件）
  // 注意 runtime 名必须与事件流里恢复的 agent.runtimeName 一致
  const replayingRuntime: AgentRuntime = {
    name: "scripted",
    async activate() {},
    async *run(request) {
      yield { type: "run.started", runId: request.runId };
      yield { type: "tool.requested", runId: request.runId, stepId: "s1", toolCallId, name: "email.send", input: {} };
      yield { type: "tool.completed", runId: request.runId, stepId: "s1", toolCallId, output: { ok: true } };
      yield { type: "run.completed", runId: request.runId };
    },
    async interrupt() {},
    async suspend() {},
    async resume() {},
  };
  restored.runtimes.register(replayingRuntime);
  restored.scheduler.setRunner({ run: async (runTaskId) => { await restored.runner.executeTask(runTaskId); } });
  await assert.rejects(
    () => restored.runner.executeTask(task.id),
    (error: unknown) => error instanceof OsError && error.code === "duplicate_side_effect",
  );
});

test("UI Security：非法命令与已关闭 Surface 上的动作被拒绝", async () => {
  const kernel = new OSKernel();
  const agent = await kernel.agents.create({ name: "ui-agent", runtimeName: "scripted", allowedActions: [] });

  // Model 试图注入未注册命令 → 拒绝
  await assert.rejects(
    () => kernel.ui.present({
      agentId: agent.id,
      kind: "approval",
      data: {},
      actions: [{ id: "hack", label: "hack", command: "process.exec" as never }],
    }),
    (error: unknown) => error instanceof OsError && error.code === "invalid_command",
  );

  const surface = await kernel.ui.present({
    agentId: agent.id,
    kind: "approval",
    data: { plan: "A" },
    actions: [{ id: "approve", label: "批准", command: "task.approve" }],
  });
  await kernel.ui.close(surface.id, "resolved");

  // 已关闭的 Surface 不能再提交动作（UI 不能绕过生命周期）
  await assert.rejects(
    () => kernel.ui.submitAction(surface.id, "approve", {}),
    (error: unknown) => error instanceof OsError && error.code === "illegal_transition",
  );
});

test("UI Registry：未知组件、错误版本、畸形数据与 action 输入均被拒绝", async () => {
  const kernel = new OSKernel();
  const agent = await kernel.agents.create({ name: "ui-contract-agent", runtimeName: "scripted", allowedActions: [] });
  await assert.rejects(() => kernel.ui.present({ agentId: agent.id, kind: "custom", data: {}, actions: [] }), /未注册/);
  await assert.rejects(() => kernel.ui.present({ agentId: agent.id, kind: "table", componentVersion: 2, data: { columns: [], rows: [] }, actions: [] }), /不支持的 UI 组件版本/);
  await assert.rejects(() => kernel.ui.present({ agentId: agent.id, kind: "table", data: { columns: "bad", rows: [] }, actions: [] }), /不符合可信契约/);

  const surface = await kernel.ui.present({
    agentId: agent.id,
    kind: "form",
    data: { fields: [{ id: "note", label: "说明", type: "text" }] },
    actions: [{ id: "submit", label: "提交", command: "task.submit_input", inputSchema: { type: "object", required: ["note"], additionalProperties: false, properties: { note: { type: "string", maxLength: 20 } } } }],
  });
  await assert.rejects(() => kernel.ui.submitAction(surface.id, "submit", { note: "ok", injected: true }), /输入不符合/);
  await assert.rejects(() => kernel.ui.submitAction(surface.id, "submit", { note: "x".repeat(21) }), /输入不符合/);
  const accepted = await kernel.ui.submitAction(surface.id, "submit", { note: "可以继续" });
  assert.equal(accepted.command, "task.submit_input");
});

test("UI Command：表单补充输入形成任务事实、关闭 Surface 并恢复排队", async () => {
  const kernel = new OSKernel();
  const agent = await kernel.agents.create({ name: "input-agent", runtimeName: "scripted", allowedActions: [] });
  const task = await kernel.tasks.create({ goal: "等待研究范围", ownerAgentId: agent.id, assignedAgentId: agent.id });
  kernel.tasks.transition(task.id, { type: "task.started", payload: { taskId: task.id, runId: "run-input" } });
  kernel.tasks.transition(task.id, { type: "task.waiting_input", payload: { taskId: task.id, reason: "需要海域" } });
  const surface = await kernel.ui.present({
    agentId: agent.id, taskId: task.id, kind: "form",
    data: { fields: [{ id: "region", label: "海域", type: "text" }] },
    actions: [{ id: "continue", label: "继续", command: "task.submit_input", inputSchema: { type: "object", required: ["region"], additionalProperties: false, properties: { region: { type: "string", maxLength: 100 } } } }],
  });
  const outcome = await kernel.ui.executeAction(surface.id, "continue", { region: "南海" }, { actor: "user" });
  assert.equal(outcome.command, "task.submit_input");
  assert.equal(kernel.tasks.get(task.id).state, "queued");
  assert.deepEqual(kernel.tasks.get(task.id).submittedInputs?.[0]?.payload, { region: "南海" });
  assert.equal(kernel.ui.openSurfaces().length, 0);
  await assert.rejects(() => kernel.ui.executeAction(surface.id, "continue", { region: "东海" }, { actor: "user" }), /closed/);
});

test("UI Command：Artifact 选择校验真实 ID 与版本", async () => {
  const kernel = new OSKernel();
  const agent = await kernel.agents.create({ name: "artifact-agent", runtimeName: "scripted", allowedActions: [] });
  const artifact = await kernel.artifacts.create({ name: "result.md", type: "report", mimeType: "text/markdown", content: "ok", creatorAgentId: agent.id });
  const surface = await kernel.ui.present({
    agentId: agent.id, kind: "artifact", data: { artifactId: artifact.artifactId }, lifecycle: "ephemeral",
    actions: [{ id: "open", label: "打开", command: "artifact.select" }],
  });
  await assert.rejects(() => kernel.ui.executeAction(surface.id, "open", { artifactId: artifact.artifactId, version: 99 }, { actor: "user" }), /版本不存在/);
  const outcome = await kernel.ui.executeAction(surface.id, "open", { artifactId: artifact.artifactId, version: 1 }, { actor: "user" });
  assert.deepEqual(outcome.result, { artifactId: artifact.artifactId, version: 1 });
  assert.equal(kernel.ui.openSurfaces().length, 0);
});

test("Artifact Provenance：lineage 可追溯到根", async () => {
  const kernel = new OSKernel();
  const agent = await kernel.agents.create({ name: "analyst", runtimeName: "scripted", allowedActions: [] });

  const dataset = await kernel.artifacts.create({
    name: "dataset.csv",
    type: "dataset",
    mimeType: "text/csv",
    content: "a,b\n1,2",
    creatorAgentId: agent.id,
  });
  const analysis = await kernel.artifacts.create({
    name: "results.json",
    type: "api_result",
    mimeType: "application/json",
    content: "{\"mean\":1.5}",
    creatorAgentId: agent.id,
    derivedFrom: [{ artifactId: dataset.artifactId, version: dataset.version }],
  });
  const report = await kernel.artifacts.create({
    name: "report.md",
    type: "report",
    mimeType: "text/markdown",
    content: "# 结论",
    creatorAgentId: agent.id,
    derivedFrom: [{ artifactId: analysis.artifactId, version: analysis.version }],
  });

  const chain = kernel.artifacts.lineageOf(report.artifactId);
  assert.deepEqual(chain.map((artifact) => artifact.name), ["dataset.csv", "results.json", "report.md"]);
  // 内容寻址
  assert.match(dataset.storageRef, /^blob:\/\/[0-9a-f]{64}$/);
  assert.equal(kernel.artifacts.contentOf(report.artifactId), "# 结论");
});

test("Memory supersede：同 dedupeKey 新记录取代旧记录且可追溯", async () => {
  const kernel = new OSKernel();
  const agent = await kernel.agents.create({ name: "m", runtimeName: "scripted", allowedActions: [] });
  const first = await kernel.memories.write({ agentId: agent.id, type: "semantic", content: "使用 MongoDB", dedupeKey: "db", provenance: { origin: "user" } });
  const second = await kernel.memories.write({ agentId: agent.id, type: "semantic", content: "迁移到 PostgreSQL", dedupeKey: "db", provenance: { origin: "user" } });

  const active = kernel.memories.search(agent.id, "");
  assert.equal(active.length, 1);
  assert.equal(active[0]!.id, second.id);
  const oldRecord = kernel.memories.get(first.id);
  assert.equal(oldRecord.supersededBy, second.id);
});

test("Memory Retrieval：结果携带相关度、置信度、时效和可验证来源", async () => {
  const kernel = new OSKernel();
  const agent = await kernel.agents.create({ name: "m", runtimeName: "scripted", allowedActions: [] });
  const task = await kernel.tasks.create({ goal: "分析盐度跃层", ownerAgentId: agent.id });
  const artifact = await kernel.artifacts.create({ name: "salinity.csv", type: "dataset", mimeType: "text/csv", content: "depth,salinity", creatorAgentId: agent.id, taskId: task.id });
  await kernel.memories.write({
    agentId: agent.id, type: "semantic", content: "盐度跃层位于 50 米附近", dedupeKey: "halocline",
    confidence: 0.82, provenance: { origin: "task", sourceTaskId: task.id, sourceArtifactId: artifact.artifactId },
  });
  await kernel.memories.write({
    agentId: agent.id, type: "episodic", content: "旧航次记录", dedupeKey: "expired",
    expiresAt: "2025-01-01T00:00:00.000Z", provenance: { origin: "user" },
  });

  const hits = kernel.memories.retrieve(agent.id, "盐度 跃层", { now: new Date("2026-09-04T00:00:00.000Z") });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.confidence, 0.82);
  assert.deepEqual(hits[0]!.matchedTerms, ["盐度", "跃层"]);
  assert.equal(hits[0]!.record.provenance.sourceArtifactId, artifact.artifactId);
  assert.ok(hits[0]!.relevance > 0.4);
  await assert.rejects(
    () => kernel.memories.write({ agentId: agent.id, type: "semantic", content: "无来源结论", dedupeKey: "bad", provenance: { origin: "task" } }),
    /requires sourceTaskId/,
  );
});

test("Task 状态机：非法迁移被拒绝", async () => {
  const kernel = new OSKernel();
  const agent = await kernel.agents.create({ name: "t", runtimeName: "scripted", allowedActions: [] });
  const task = await kernel.tasks.create({ goal: "x", ownerAgentId: agent.id });
  // created → completed 是非法迁移（必须经过 queued/running）
  assert.throws(
    () => kernel.tasks.transition(task.id, { type: "task.completed", payload: { taskId: task.id } }),
    /illegal state transition/,
  );
});

test("Task 控制中心：优先级事件可重放，重试创建新任务并保留血缘", async () => {
  const kernel = new OSKernel();
  const agent = await kernel.agents.create({ name: "main", runtimeName: "scripted", allowedActions: [] });
  const original = await kernel.tasks.create({ goal: "分析观测数据", ownerAgentId: agent.id, assignedAgentId: agent.id });

  kernel.tasks.updatePriority(original.id, 5, { actor: "user" });
  assert.equal(kernel.tasks.get(original.id).constraints.priority, 5);
  await kernel.tasks.fail(original.id, "输入文件损坏", { actor: "system" });

  const retried = await kernel.tasks.retry(original.id, { actor: "user" });
  assert.notEqual(retried.id, original.id);
  assert.equal(retried.retryOfTaskId, original.id);
  assert.equal(retried.constraints.priority, 5);
  assert.equal(retried.state, "created");
  assert.throws(() => kernel.tasks.updatePriority(original.id, 10), /terminal task/);

  const restored = new OSKernel();
  restored.events.hydrate(structuredClone(kernel.events.all()));
  assert.equal(restored.tasks.get(original.id).constraints.priority, 5);
  assert.equal(restored.tasks.get(retried.id).retryOfTaskId, original.id);
});

test("Crash Recovery：hydrate 保留事件身份且不会把历史重新持久化", async () => {
  const original = new OSKernel();
  await original.agents.create({ name: "main", runtimeName: "scripted", allowedActions: [] });
  const persisted = structuredClone(original.events.all());

  let appendCalls = 0;
  const restored = new OSKernel({ eventHooks: { append: () => { appendCalls += 1; } } });
  restored.events.hydrate(persisted);

  assert.equal(appendCalls, 0, "恢复历史不能再次写入持久化日志");
  assert.deepEqual(restored.events.all(), persisted, "恢复必须保留 eventId、seq 和时间戳");
  assert.equal(restored.projection.agents.size, 1);

  await restored.agents.create({ name: "worker", runtimeName: "scripted", allowedActions: [] });
  assert.equal(appendCalls, 1, "恢复后的新事件仍正常持久化");
  assert.equal(restored.events.all().at(-1)?.seq, persisted.at(-1)!.seq + 1);
  assert.throws(() => restored.events.hydrate(persisted), /only be hydrated while empty/);
});

test("Crash Recovery：旧版断裂 seq 在内存中修复且不重写来源日志", async () => {
  const source = new OSKernel();
  await source.agents.create({ name: "main", runtimeName: "scripted", allowedActions: [] });
  await source.agents.create({ name: "worker", runtimeName: "scripted", allowedActions: [] });
  const corrupted = structuredClone(source.events.all());
  corrupted[1]!.seq = 1;

  let appendCalls = 0;
  const restored = new OSKernel({ eventHooks: { append: () => { appendCalls += 1; } } });
  restored.events.hydrate(corrupted);

  assert.deepEqual(restored.events.all().map((event) => event.seq), [1, 2]);
  assert.deepEqual(restored.events.all().map((event) => event.eventId), corrupted.map((event) => event.eventId));
  assert.equal(restored.projection.agents.size, 2);
  assert.equal(appendCalls, 0);
});
