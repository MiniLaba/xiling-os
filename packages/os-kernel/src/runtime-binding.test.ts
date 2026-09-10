// Agent 运行时绑定的主路径测试（INTEGRATION.md：Pi 是目标默认科研 Harness）。
// 关注点：只允许绑定已注册的真实运行时；运行中不得换引擎；切换事实可重放恢复。

import test from "node:test";
import assert from "node:assert/strict";
import type { AgentRuntime, RunRequest, RuntimeEvent } from "@xiling/os-runtime";
import { OSKernel, OSKernel as Kernel } from "./index.js";

test("已注册的科研运行时可以成为 Agent 的绑定，并写入可重放事件", async () => {
  const kernel = new Kernel();
  kernel.runtimes.register(stubRuntime("stub-runtime"));
  kernel.runtimes.register(stubRuntime("pi-research"));
  const main = await mainAgent(kernel, "stub-runtime");

  assert.equal(kernel.agents.get(main.id).runtimeName, "stub-runtime");
  const bound = kernel.agents.setRuntime(main.id, "pi-research", { actor: "system" });
  assert.equal(bound.runtimeName, "pi-research");

  const replayed = OSKernel.replayProjection(kernel.events.all());
  assert.equal(replayed.agents.get(main.id)?.runtimeName, "pi-research");
});

test("未注册的运行时被拒绝：不允许把 Agent 指向不存在的引擎", async () => {
  const kernel = new Kernel();
  kernel.runtimes.register(stubRuntime("pi-research"));
  const main = await mainAgent(kernel, "pi-research");
  assert.throws(() => kernel.agents.setRuntime(main.id, "not-installed", { actor: "system" }), /未注册/);
  assert.equal(kernel.agents.get(main.id).runtimeName, "pi-research");
});

test("仍有未完成任务时拒绝切换运行时，不把运行中的任务换到另一个引擎", async () => {
  const kernel = new Kernel();
  kernel.runtimes.register(stubRuntime("stub-runtime"));
  kernel.runtimes.register(stubRuntime("pi-research"));
  const main = await mainAgent(kernel, "stub-runtime");
  const task = await kernel.tasks.create({ goal: "整理证据", ownerAgentId: main.id, assignedAgentId: main.id, ctx: { actor: "user" } });

  assert.throws(() => kernel.agents.setRuntime(main.id, "pi-research", { actor: "system" }), /未完成任务/);
  assert.equal(kernel.agents.get(main.id).runtimeName, "stub-runtime");

  await kernel.tasks.fail(task.id, "测试收尾", { actor: "system" });
  assert.equal(kernel.agents.setRuntime(main.id, "pi-research", { actor: "system" }).runtimeName, "pi-research");
});

test("重复绑定同一运行时是幂等的，不产生多余事件", async () => {
  const kernel = new Kernel();
  kernel.runtimes.register(stubRuntime("pi-research"));
  const main = await mainAgent(kernel, "pi-research");
  const before = kernel.events.all().length;
  kernel.agents.setRuntime(main.id, "pi-research", { actor: "system" });
  assert.equal(kernel.events.all().length, before);
});

function stubRuntime(name: string): AgentRuntime {
  return {
    name,
    async activate() {},
    async *run(_request: RunRequest): AsyncIterable<RuntimeEvent> {
      yield { type: "run.failed", runId: _request.runId, reason: "test stub" };
    },
    async interrupt() {},
    async suspend() {},
    async resume() {},
  };
}

async function mainAgent(kernel: OSKernel, runtimeName: string) {
  return kernel.agents.create({
    name: "Main Agent",
    isMainAgent: true,
    runtimeName,
    allowedActions: ["task.create"],
    ctx: { actor: "system" },
  });
}
