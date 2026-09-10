// 科研执行统一主路径测试。
// 覆盖：审批门禁、计划哈希绑定、执行适配器真实声明、产物登记、幂等、取消、契约校验。
// 适配器是结构化 stub —— 这里验证的是服务语义，不是真实沙箱能力（真实沙箱另有验收）。

import test from "node:test";
import assert from "node:assert/strict";
import type { AgentDefinition, ApprovalId } from "@xiling/os-domain";
import {
  OSKernel, ScienceService, canonicalScienceJson, sciencePlanHash,
} from "./index.js";
import type {
  ScienceExecutionAdapterDeclaration, ScienceExecutionPlan, ScienceExecutionPort, ScienceExecutionResult, ScienceExecutionSpec,
} from "./index.js";

const AVAILABLE: ScienceExecutionAdapterDeclaration = {
  id: "sandbox-stub",
  label: "测试隔离适配器",
  available: true,
  isolation: {
    filesystem: "workspace",
    network: "none",
    resourceLimits: true,
    processLimit: true,
    enforced: ["写入仅限 scratch", "网络拒绝"],
    notEnforced: ["内存上限"],
  },
  implementationVersion: "test-1",
};

const UNAVAILABLE: ScienceExecutionAdapterDeclaration = {
  id: "host-runner",
  label: "宿主裸跑",
  available: false,
  reason: "未通过系统级沙箱验收",
  isolation: {
    filesystem: "none",
    network: "none",
    resourceLimits: false,
    processLimit: false,
    enforced: [],
    notEnforced: ["文件系统隔离", "网络隔离", "资源上限", "进程限制"],
  },
  implementationVersion: "test-0",
};

function port(
  declarations: ScienceExecutionAdapterDeclaration[],
  result: ScienceExecutionResult = sampleResult(),
  overrides: Partial<ScienceExecutionPort> = {},
): ScienceExecutionPort & { runs: ScienceExecutionSpec[]; recovered: number } {
  const runs: ScienceExecutionSpec[] = [];
  const state = { runs, recovered: 0 };
  return {
    ...state,
    get runs() { return runs; },
    get recovered() { return state.recovered; },
    declarations: () => declarations,
    run: async (spec) => { runs.push(spec); return { executionId: "exec-1", result }; },
    recoverInterrupted: () => 3,
    ...overrides,
  } as ScienceExecutionPort & { runs: ScienceExecutionSpec[]; recovered: number };
}

function sampleResult(): ScienceExecutionResult {
  return {
    outputs: [
      { name: "profiles.nc.manifest.json", mimeType: "application/json", kind: "dataset", content: "{\"profiles\":12}" },
      { name: "mld-report.md", mimeType: "text/markdown", kind: "report", content: "# 混合层深度\n结论：…" },
    ],
    exitCode: 0,
    startedAt: "2026-09-10T00:00:00.000Z",
    finishedAt: "2026-09-10T00:00:05.000Z",
    environmentDigest: "sha256:env",
  };
}

function samplePlan(overrides: Partial<ScienceExecutionPlan> = {}): ScienceExecutionPlan {
  return {
    projectId: "prj-1",
    recipe: { id: "mixed-layer-depth", version: "1.0.0" },
    inputs: [{ name: "profiles", uri: "artifact://dataset/1/version/1", sha256: "a".repeat(64) }],
    code: { uri: "artifact://recipe/mld/version/1", sha256: "b".repeat(64) },
    parameters: { threshold: 0.03, method: "temperature" },
    randomSeed: 7,
    environment: { imageDigest: "sha256:env" },
    resources: { cpu: 1, memoryBytes: 512 * 1024 * 1024, timeoutMs: 60_000 },
    network: { mode: "none" },
    ...overrides,
  };
}

async function withKernel<T>(
  execution: ScienceExecutionPort,
  work: (kernel: OSKernel, agent: AgentDefinition) => Promise<T>,
): Promise<T> {
  const kernel = new OSKernel({ scienceExecution: execution });
  const agent = await kernel.agents.create({
    name: "Main Agent", isMainAgent: true, runtimeName: "pi-research",
    allowedActions: ["task.create"], ctx: { actor: "system" },
  });
  return work(kernel, agent);
}

async function planAndApprove(kernel: OSKernel, agent: AgentDefinition, plan = samplePlan()) {
  const planned = await kernel.science.plan({ goal: "计算混合层深度", plan, ownerAgentId: agent.id, projectId: plan.projectId, ctx: { actor: "user" } });
  const approval = await kernel.science.requestApproval(planned.task.id, "需要下载并执行计算脚本", { actor: "user" });
  await kernel.science.decide(approval.approvalId, "approved", "test-user", { actor: "user" });
  return { ...planned, approvalId: approval.approvalId };
}

test("适配器声明如实暴露：不可用时给出具体原因，不是空数组", async () => {
  await withKernel(port([UNAVAILABLE]), async (kernel) => {
    const declarations = kernel.science.adapters();
    assert.equal(declarations.length, 1);
    assert.equal(declarations[0]?.available, false);
    assert.match(declarations[0]?.reason ?? "", /沙箱/);
    const selection = kernel.science.selectAdapter();
    assert.ok("unavailableReason" in selection);
  });
});

test("启动时回收上一进程遗留的执行记录，并在诊断里如实计数", async () => {
  await withKernel(port([AVAILABLE]), async (kernel) => {
    assert.equal(kernel.science.recovered, 3);
  });
});

test("计划缺少脚本哈希或资源上限时不允许进入审批", async () => {
  await withKernel(port([AVAILABLE]), async (kernel, agent) => {
    await assert.rejects(
      kernel.science.plan({ goal: "无哈希计划", plan: samplePlan({ code: { uri: "artifact://x", sha256: "nope" } }), ownerAgentId: agent.id, projectId: "prj-1" }),
      /sha256/,
    );
    await assert.rejects(
      kernel.science.plan({ goal: "无资源上限", plan: samplePlan({ resources: { cpu: 1, memoryBytes: 512 * 1024 * 1024, timeoutMs: 0 } }), ownerAgentId: agent.id, projectId: "prj-1" }),
      /超时上限/,
    );
    assert.equal(kernel.projection.tasks.size, 0);
  });
});

test("计划所属项目与请求项目不一致时拒绝（跨项目不得借用计划）", async () => {
  await withKernel(port([AVAILABLE]), async (kernel, agent) => {
    await assert.rejects(
      kernel.science.plan({ goal: "跨项目", plan: samplePlan({ projectId: "prj-2" }), ownerAgentId: agent.id, projectId: "prj-1" }),
      /项目不一致/,
    );
  });
});

test("未经审批不得执行：计划登记后不能直接执行", async () => {
  await withKernel(port([AVAILABLE]), async (kernel, agent) => {
    const planned = await kernel.science.plan({ goal: "未审批", plan: samplePlan(), ownerAgentId: agent.id, projectId: "prj-1" });
    assert.equal(kernel.tasks.get(planned.task.id).state, "created");
    await assert.rejects(kernel.science.execute(planned.task.id), /不能执行/);
  });
});

test("审批通过后执行：任务完成、产物按科学执行元数据登记", async () => {
  const execution = port([AVAILABLE]);
  await withKernel(execution, async (kernel, agent) => {
    const { task, planHash } = await planAndApprove(kernel, agent);
    const summary = await kernel.science.execute(task.id);

    assert.equal(summary.status, "succeeded");
    assert.equal(summary.executionId, "exec-1");
    assert.equal(summary.planHash, planHash);
    assert.equal(summary.adapterId, "sandbox-stub");
    assert.equal(summary.artifacts.length, 2);
    assert.equal(kernel.tasks.get(task.id).state, "completed");
    assert.equal(execution.runs.length, 1);
    assert.equal(execution.runs[0]?.planHash, planHash);

    const dataset = kernel.projection.artifacts.get(summary.artifacts[0]!.artifactId);
    assert.equal(dataset?.type, "dataset");
    const science = dataset?.metadata.science as Record<string, unknown>;
    assert.equal(science.planHash, planHash);
    assert.equal(science.executionId, "exec-1");
    assert.equal(science.adapterId, "sandbox-stub");
    // 执行记录 ID 与任务 ID 不同：两者不互相冒充。
    assert.notEqual(summary.executionId, task.id);
    // 产物走内容寻址，可回答"这份结论来自什么内容"。
    assert.match(dataset?.storageRef ?? "", /^blob:\/\/[0-9a-f]{64}$/);
  });
});

test("没有可用安全执行后端时任务明确失败，不产生产物也不裸跑", async () => {
  const execution = port([UNAVAILABLE], sampleResult(), {
    run: async () => { throw new Error("宿主裸跑必须不可达"); },
  });
  await withKernel(execution, async (kernel, agent) => {
    const { task } = await planAndApprove(kernel, agent);
    await assert.rejects(kernel.science.execute(task.id), /未通过系统级沙箱验收|没有可用的安全执行后端/);
    assert.equal(kernel.tasks.get(task.id).state, "failed");
    assert.match(kernel.tasks.get(task.id).statusReason ?? "", /未通过系统级沙箱验收/);
    assert.equal(execution.runs.length, 0);
    assert.equal(kernel.projection.artifacts.size, 0);
  });
});

test("执行完成但缺少声明产物类型时任务失败，不算完成", async () => {
  const execution = port([AVAILABLE], { ...sampleResult(), outputs: [sampleResult().outputs[1]!] });
  await withKernel(execution, async (kernel, agent) => {
    const { task } = await planAndApprove(kernel, agent);
    const summary = await kernel.science.execute(task.id);
    assert.equal(summary.status, "failed");
    assert.match(summary.error ?? "", /缺少声明的产物类型/);
    assert.equal(kernel.tasks.get(task.id).state, "failed");
  });
});

test("计划快照被事后篡改时拒绝执行，不按新参数套用旧审批", async () => {
  await withKernel(port([AVAILABLE]), async (kernel, agent) => {
    const { task } = await planAndApprove(kernel, agent);
    const binding = kernel.tasks.get(task.id).constraints.science!;
    // 直接篡改计划参数而不改哈希（模拟绕过审批改参数）
    const tampered = { ...(binding.plan as ScienceExecutionPlan), parameters: { threshold: 0.5, method: "temperature" } };
    (kernel.tasks.get(task.id).constraints as { science: unknown }).science = { ...binding, plan: tampered };
    assert.notEqual(sciencePlanHash(tampered), binding.planHash);
    await assert.rejects(kernel.science.execute(task.id), /计划快照与已批准哈希不一致/);
  });
});

test("重复执行同一任务返回既有结果，不重复调用适配器", async () => {
  const execution = port([AVAILABLE]);
  await withKernel(execution, async (kernel, agent) => {
    const { task } = await planAndApprove(kernel, agent);
    const first = await kernel.science.execute(task.id);
    const second = await kernel.science.execute(task.id);
    assert.deepEqual(second, first);
    assert.equal(execution.runs.length, 1);
    assert.equal(kernel.projection.artifacts.size, 2);
  });
});

test("同一计划的重复登记被识别为幂等重放，不产生第二个任务", async () => {
  await withKernel(port([AVAILABLE]), async (kernel, agent) => {
    const plan = samplePlan();
    const input = { goal: "计算混合层深度", plan, ownerAgentId: agent.id, projectId: "prj-1" };
    const first = await kernel.science.plan(input);
    const second = await kernel.science.plan(input);
    assert.equal(first.replayed, false);
    assert.equal(second.replayed, true);
    assert.equal(second.task.id, first.task.id);
    assert.equal(kernel.projection.tasks.size, 1);
  });
});

test("模型 Scheduler 不会拾取科学执行任务", async () => {
  await withKernel(port([AVAILABLE]), async (kernel, agent) => {
    const { task } = await planAndApprove(kernel, agent);
    assert.equal(kernel.tasks.get(task.id).state, "queued");
    assert.equal(kernel.scheduler.pickNext(), undefined);
    assert.deepEqual(kernel.scheduler.listRunnableFor(agent.id), []);
  });
});

test("拒绝审批后任务失败，且不能被 execute 复活", async () => {
  await withKernel(port([AVAILABLE]), async (kernel, agent) => {
    const planned = await kernel.science.plan({ goal: "被拒绝的计算", plan: samplePlan(), ownerAgentId: agent.id, projectId: "prj-1" });
    const approval = await kernel.science.requestApproval(planned.task.id, "需要执行脚本", { actor: "user" });
    await kernel.science.decide(approval.approvalId, "rejected", "test-user", { actor: "user" });
    assert.equal(kernel.tasks.get(planned.task.id).state, "failed");
    await assert.rejects(kernel.science.execute(planned.task.id), /不能执行|审批/);
  });
});

test("另一个计划的审批不能授权当前计划", async () => {
  await withKernel(port([AVAILABLE]), async (kernel, agent) => {
    const first = await kernel.science.plan({ goal: "计划 A", plan: samplePlan(), ownerAgentId: agent.id, projectId: "prj-1" });
    const second = await kernel.science.plan({ goal: "计划 B", plan: samplePlan({ parameters: { threshold: 0.9, method: "temperature" } }), ownerAgentId: agent.id, projectId: "prj-1" });
    const approval = await kernel.science.requestApproval(first.task.id, "批准 A", { actor: "user" });
    await kernel.science.decide(approval.approvalId, "approved", "test-user", { actor: "user" });
    // B 也进入排队（例如被别的流程 requeue），但没有属于 B 的计划哈希审批。
    kernel.tasks.transition(second.task.id, { type: "task.requeued", payload: { taskId: second.task.id, reason: "测试：模拟排队" } }, { actor: "system" });
    assert.equal(kernel.tasks.get(second.task.id).state, "queued");
    await assert.rejects(kernel.science.execute(second.task.id), /没有有效的执行审批/);
    // A 的审批仍然只对 A 有效。
    assert.equal((await kernel.science.execute(first.task.id)).status, "succeeded");
  });
});

test("非科学执行的审批不能由科研服务决定", async () => {
  await withKernel(port([AVAILABLE]), async (kernel, agent) => {
    const planned = await kernel.science.plan({ goal: "普通计算", plan: samplePlan(), ownerAgentId: agent.id, projectId: "prj-1" });
    // 通用 ApprovalService 要求任务已经在 running；先让这一轮开始，再请求发布审批。
    kernel.tasks.transition(planned.task.id, { type: "task.started", payload: { taskId: planned.task.id, runId: "run-test" } }, { actor: "system" });
    const approval = await kernel.approvals.request({ taskId: planned.task.id, agentId: agent.id, action: "report.publish", resource: "report/1" });
    await assert.rejects(kernel.science.decide(approval.approvalId as ApprovalId, "approved", "test-user"), /不属于科学执行/);
    assert.equal(kernel.projection.approvals.get(approval.approvalId)?.state, "pending");
  });
});

test("取消运行中的科学执行：状态为 cancelled，不冒充成功", async () => {
  const execution = port([AVAILABLE], sampleResult(), {
    run: async (spec, _adapterId, signal) => await new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      void spec;
    }),
  });
  await withKernel(execution, async (kernel, agent) => {
    const { task } = await planAndApprove(kernel, agent);
    const running = kernel.science.execute(task.id);
    await kernel.science.cancel(task.id, "用户取消", { actor: "user" });
    const summary = await running;
    assert.equal(summary.status, "cancelled");
    assert.match(summary.error ?? "", /取消/);
  });
});

test("计划哈希对键序不敏感，对取值敏感", () => {
  const a = samplePlan({ parameters: { threshold: 0.03, method: "temperature" } });
  const b = samplePlan({ parameters: { method: "temperature", threshold: 0.03 } });
  assert.equal(sciencePlanHash(a), sciencePlanHash(b));
  assert.equal(canonicalScienceJson({ b: 1, a: [2, { d: null, c: true }] }), '{"a":[2,{"c":true,"d":null}],"b":1}');
  assert.notEqual(sciencePlanHash(a), sciencePlanHash(samplePlan({ parameters: { threshold: 0.04, method: "temperature" } })));
});

test("按项目列出科学执行任务，摘要与任务事实分开", async () => {
  await withKernel(port([AVAILABLE]), async (kernel, agent) => {
    const { task } = await planAndApprove(kernel, agent);
    await kernel.science.execute(task.id);
    const listed = kernel.science.listForProject("prj-1");
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.task.id, task.id);
    assert.equal(listed[0]?.summary?.status, "succeeded");
    assert.equal(kernel.science.listForProject("prj-2").length, 0);
  });
});

test("ScienceService 可直接构造（宿主可注入自己的执行端口）", () => {
  const execution = port([AVAILABLE]);
  const kernel = new OSKernel();
  const service = new ScienceService(kernel, kernel.services, { execution });
  assert.equal(service.recovered, 3);
  assert.equal(service.adapters()[0]?.id, "sandbox-stub");
});
