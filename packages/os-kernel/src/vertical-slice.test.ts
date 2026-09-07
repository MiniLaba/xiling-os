// §57 推荐的第一条 Vertical Slice（端到端）：
//   创建 Main Agent Identity → 绑定 Plugin → 创建 Workspace → 激活（Session）
//   → 用户提出 Goal → 创建 Task → Agent Runtime 执行 → 调用 Tool → 产生 Artifact
//   → 触发一次 Approval → Generative UI 展示 Approval → 用户批准
//   → Task Completed → Agent suspend → 重启系统 → 恢复 Agent + Task + Artifact + Memory
// 以及第二个 Agent 的 A2A 委托切片（Capability 衰减 + Context 隔离传递）。

import test from "node:test";
import assert from "node:assert/strict";
import { newId } from "@xiling/os-domain";
import type { AgentRuntime, RunRequest, RuntimeEvent } from "@xiling/os-runtime";
import { OSKernel, recoverFromEvents } from "./index.js";

/**
 * 场景 Runtime：模拟一个两阶段执行的真实 Harness ——
 * 第一轮执行工具、请求批准（GenUI 审批面板）后挂起；
 * 批准后第二轮直接产出报告并完成。
 */
function scenarioRuntime(runCounts: Map<string, number>): AgentRuntime {
  return {
    name: "scenario",
    async activate() {},
    async *run(request: RunRequest): AsyncIterable<RuntimeEvent> {
      const count = (runCounts.get(request.goal) ?? 0) + 1;
      runCounts.set(request.goal, count);
      yield { type: "run.started", runId: request.runId };
      yield { type: "step.started", runId: request.runId, stepId: "s1" };
      if (count === 1) {
        yield { type: "tool.requested", runId: request.runId, stepId: "s1", toolCallId: newId("call"), name: "data.compile", input: { rows: 42 } };
        yield { type: "tool.completed", runId: request.runId, stepId: "s1", toolCallId: newId("call"), output: { rows: 42 } };
        // 先给出审批面板（GenUI），再正式请求批准
        yield {
          type: "ui.requested",
          runId: request.runId,
          surface: {
            kind: "approval",
            title: "确认生成分析报告",
            data: { tool: "data.compile", rows: 42 },
            actions: [{ id: "approve", label: "批准", command: "task.approve" }],
            lifecycle: "task",
          },
        };
        yield { type: "approval.requested", runId: request.runId, action: "report.publish", resource: "report/q3", reason: "对外发布需要用户确认" };
        return;
      }
      yield {
        type: "artifact.produced",
        runId: request.runId,
        artifact: { name: "q3-report.md", type: "report", mimeType: "text/markdown", content: "# Q3 分析\n结论：增长稳健。" },
      };
      yield { type: "run.completed", runId: request.runId, summary: "报告已生成" };
    },
    async interrupt() {},
    async suspend() {},
    async resume() {},
  };
}

test("§57 垂直切片：单 Agent 全链路 + 重启恢复", async () => {
  const persisted: string[] = [];
  const runCounts = new Map<string, number>();
  const kernel = new OSKernel({ eventHooks: { append: (event) => persisted.push(JSON.stringify(event)) } });
  kernel.runtimes.register(scenarioRuntime(runCounts));
  kernel.scheduler.setRunner({ run: async (taskId) => { await kernel.runner.executeTask(taskId); } });

  // 1. 创建 Main Agent Identity + 绑定 Plugin
  const mainAgent = await kernel.agents.create({
    name: "Main Agent",
    isMainAgent: true,
    runtimeName: "scenario",
    pluginBindings: [{ pluginId: "research-basic" }],
    allowedActions: ["task.create", "report.publish", "memory.write"],
    systemInstructions: "你是用户的主要操作入口。",
  });
  assert.equal(mainAgent.isMainAgent, true);

  // 2. 创建 Workspace + 写入一条语义记忆
  const workspace = await kernel.workspaces.create(mainAgent.id, "/Users/demo/xiling-workspace");
  await kernel.memories.write({
    agentId: mainAgent.id,
    type: "semantic",
    content: "用户偏好简洁的中文报告",
    dedupeKey: "report-style",
    provenance: { origin: "user" },
  });

  // 3. 激活（≈ 进程启动）
  const activation = await kernel.agents.activate(mainAgent.id);
  assert.equal(activation.state, "idle");

  // 4. 用户提出 Goal → 创建 Task → 调度执行
  const task = await kernel.tasks.create({
    goal: "汇总 Q3 数据并生成分析报告",
    ownerAgentId: mainAgent.id,
    assignedAgentId: mainAgent.id,
    outputContract: { requiredArtifactTypes: ["report"] },
    ctx: { actor: "user" },
  });
  await kernel.scheduler.tick();

  // 5. 第一轮执行结束于等待批准 + 生成审批 UI
  const afterRun1 = kernel.tasks.get(task.id);
  assert.equal(afterRun1.state, "waiting_approval");
  const pending = kernel.approvals.pending();
  assert.equal(pending.length, 1);
  const surfaces = kernel.ui.openSurfaces();
  assert.equal(surfaces.length, 1);
  assert.equal(surfaces[0]!.kind, "approval");
  assert.equal(surfaces[0]!.taskId, task.id);

  // 6. 用户批准 → 任务回队 → 第二轮执行 → 完成 + 产出 report Artifact
  await kernel.approvals.decide(pending[0]!.approvalId, "approved", "user-1");
  assert.equal(kernel.tasks.get(task.id).state, "queued");
  await kernel.scheduler.tick();
  const completed = kernel.tasks.get(task.id);
  assert.equal(completed.state, "completed");
  const reportRefs = completed.outputArtifacts;
  assert.equal(reportRefs.length, 1);
  const report = kernel.artifacts.get(reportRefs[0]!.artifactId);
  assert.equal(report.type, "report");
  assert.equal(report.provenance.creatorAgentId, mainAgent.id);
  assert.equal(report.taskId, task.id);

  // 7. Agent suspend（无任务即挂起，不占常驻）
  await kernel.agents.suspend(mainAgent.id);
  assert.equal(kernel.agents.findActiveActivation(mainAgent.id)?.state, "suspended");

  // 8. 重启系统：从事件流恢复
  const restored = new OSKernel();
  restored.events.hydrate(persisted.map((line) => JSON.parse(line)));
  const recovery = recoverFromEvents(restored, restored.events.all());

  // Agent 身份、工作区、记忆、任务、产物全部还在
  const restoredAgent = recovery.projection.agents.get(mainAgent.id);
  assert.ok(restoredAgent, "Agent Identity 在重启后仍然存在");
  assert.equal(restoredAgent.isMainAgent, true);
  assert.deepEqual(restoredAgent.pluginBindings, [{ pluginId: "research-basic" }]);
  assert.ok([...recovery.projection.workspaces.values()].some((ws) => ws.workspaceId === workspace.workspaceId));
  const restoredMemories = [...recovery.projection.memories.values()].filter((r) => r.agentId === mainAgent.id && r.supersededBy === undefined);
  assert.equal(restoredMemories.length, 1);
  const restoredTask = recovery.projection.tasks.get(task.id);
  assert.equal(restoredTask?.state, "completed");
  const restoredReport = recovery.projection.artifacts.get(reportRefs[0]!.artifactId);
  assert.equal(restoredReport?.type, "report");
  // 审批决定也被恢复
  assert.equal([...recovery.projection.approvals.values()][0]?.state, "approved");
});

test("§57 垂直切片（第二步）：A2A 委托 Worker Agent + Capability 衰减", async () => {
  const kernel = new OSKernel();
  let workerRuns = 0;
  const workerRuntime: AgentRuntime = {
    name: "worker-runtime",
    async activate() {},
    async *run(request: RunRequest): AsyncIterable<RuntimeEvent> {
      workerRuns += 1;
      // 受托方只能看到 ContextBundle 里的信息（不含委托方会话）
      assert.equal(request.contextBundle?.summary, "Q3 销售数据已整理完毕");
      yield { type: "run.started", runId: request.runId };
      yield {
        type: "artifact.produced",
        runId: request.runId,
        artifact: { name: "chart.png", type: "image", mimeType: "image/png", content: "PNGDATA" },
      };
      yield { type: "run.completed", runId: request.runId };
    },
    async interrupt() {},
    async suspend() {},
    async resume() {},
  };
  kernel.runtimes.register(workerRuntime);
  kernel.scheduler.setRunner({ run: async (taskId) => { await kernel.runner.executeTask(taskId); } });

  const mainAgent = await kernel.agents.create({
    name: "Main", isMainAgent: true, runtimeName: "scenario",
    allowedActions: ["report.publish"],
  });
  // 给 Main 一个 dummy runtime 执行父任务（简单完成）
  kernel.runtimes.register({
    name: "scenario",
    async activate() {},
    async *run(request: RunRequest): AsyncIterable<RuntimeEvent> {
      yield { type: "run.started", runId: request.runId };
      yield { type: "run.completed", runId: request.runId };
    },
    async interrupt() {}, async suspend() {}, async resume() {},
  });
  const worker = await kernel.agents.create({
    name: "Chart Worker", runtimeName: "worker-runtime",
    allowedActions: ["report.publish"],
  });

  // Main 持有的授权（用户签发）
  const owned = await kernel.capabilities.grant({
    issuer: "user",
    subject: mainAgent.id,
    action: "report.publish",
    resource: "reports/*",
  });

  // 用户目标 → 父任务
  const parentTask = await kernel.tasks.create({
    goal: "生成 Q3 销售报告",
    ownerAgentId: mainAgent.id,
    assignedAgentId: mainAgent.id,
    ctx: { actor: "user" },
  });

  // A2A 委托：显式最小上下文包 + 衰减授权（带 30 分钟期限）
  const delegation = await kernel.a2a.delegate({
    fromAgentId: mainAgent.id,
    toAgentId: worker.id,
    parentTaskId: parentTask.id,
    goal: "根据销售数据生成图表",
    context: { summary: "Q3 销售数据已整理完毕", constraints: ["图表用中文标签"] },
    attenuations: [{ subject: worker.id, action: "report.publish", resource: "reports/q3", expiresInMinutes: 30 }],
  });

  // 衰减授予成立且更窄
  const minted = kernel.capabilities.get(delegation.grants[0]!);
  assert.equal(minted.subject, worker.id);
  assert.equal(minted.resource, "reports/q3");
  assert.equal(minted.taskId, delegation.taskId);
  assert.ok(minted.expiresAt !== undefined);
  // Worker 在子任务作用域内可以发布 reports/q3，但不能发布 reports/other
  assert.equal(kernel.capabilities.check({ subject: worker.id, action: "report.publish", resource: "reports/q3", taskId: delegation.taskId }).allowed, true);
  assert.equal(kernel.capabilities.check({ subject: worker.id, action: "report.publish", resource: "reports/other", taskId: delegation.taskId }).allowed, false);

  // 子任务进入收件箱并执行 → 完成 → 父任务回队 → 执行 → 完成
  const inbox = kernel.a2a.inboxFor(worker.id);
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0]!.goal, "根据销售数据生成图表");

  await kernel.runner.executeTask(delegation.taskId);
  assert.equal(kernel.tasks.get(delegation.taskId).state, "completed");

  // 子任务完成后父任务被唤醒；父任务由调度器推进至完成
  await kernel.scheduler.tick();
  assert.equal(workerRuns, 1);
  assert.equal(kernel.tasks.get(parentTask.id).state, "completed");

  // 子任务的图表产物挂在子任务上，父任务链路可追溯（parentTaskId）
  assert.equal(kernel.tasks.get(delegation.taskId).parentTaskId, parentTask.id);
});

test("OutputContract：缺少必需产物类型时任务失败", async () => {
  const kernel = new OSKernel();
  kernel.runtimes.register({
    name: "lazy",
    async activate() {},
    async *run(request: RunRequest): AsyncIterable<RuntimeEvent> {
      yield { type: "run.started", runId: request.runId };
      // 声明了 requiredArtifactTypes: ["report"] 但什么都没产出
      yield { type: "run.completed", runId: request.runId };
    },
    async interrupt() {}, async suspend() {}, async resume() {},
  });
  kernel.scheduler.setRunner({ run: async (taskId) => { await kernel.runner.executeTask(taskId); } });

  const agent = await kernel.agents.create({ name: "lazy-agent", runtimeName: "lazy", allowedActions: [] });
  const task = await kernel.tasks.create({
    goal: "生成报告",
    ownerAgentId: agent.id,
    assignedAgentId: agent.id,
    outputContract: { requiredArtifactTypes: ["report"] },
  });
  await kernel.scheduler.tick();
  assert.equal(kernel.tasks.get(task.id).state, "failed");
  assert.match(kernel.events.byType("task.failed")[0]?.payload.reason ?? "", /missing artifact types/);
});
