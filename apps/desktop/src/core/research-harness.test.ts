// 科研 Harness 的启动验收：Pi 是唯一执行者、能力声明真实、重启可恢复。
// 直接启动真实的 OS Kernel Host（不经过 Electron），跑的是真实装配代码路径。

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startOsKernel } from "../os-kernel-host.js";
import type { OsKernelHost } from "../os-kernel-host.js";

async function withKernel(work: (host: OsKernelHost) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "xiling-research-harness-"));
  let host: OsKernelHost | undefined;
  try {
    host = await startOsKernel(directory, { readModelKey: () => undefined });
    await work(host);
  } finally {
    await host?.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
}

function mainRuntimeName(host: OsKernelHost): string | undefined {
  return host.kernel.projection.agents.get(host.mainAgentId as never)?.runtimeName;
}

test("Pi 是唯一科研执行者，DSH 不再注册", async () => {
  await withKernel(async (host) => {
    assert.equal(host.researchHarness.executor, "pi-research");
    assert.equal(host.researchHarness.runtimeRegistered, true);
    assert.equal(host.researchHarness.hostTools, true);
    assert.equal(host.researchHarness.reason, undefined);
    assert.equal(mainRuntimeName(host), "pi-research");

    // 注册表里只有 Pi 与音频适配器：没有第二个模型引擎。
    assert.ok(host.kernel.runtimes.get("pi-research"));
    assert.equal(host.kernel.runtimes.get("deepseek-harness-sdk"), undefined);
    assert.deepEqual([...host.kernel.runtimes.names()].sort(), ["native-audio", "pi-research"]);
  });
});

test("Pi 适配器的能力声明保守：只有文本，并明确声明已接宿主工具", async () => {
  await withKernel(async (host) => {
    const runtime = host.kernel.runtimes.get("pi-research");
    assert.ok(runtime);
    assert.deepEqual([...runtime.nativeInputModalities ?? []], ["text"]);
    assert.deepEqual([...runtime.nativeOutputModalities ?? []], ["text"]);
    // 工具桥已接入：能兑现带工具的任务契约，因此如实声明 true
    assert.equal(runtime.supportsHostTools, true);
    assert.equal(runtime.supportsCancellation, true);
    assert.equal(runtime.ownsSessionHistory, false);
  });
});

test("Main 可被显式绑定到 Pi 执行者，未注册的运行时被拒绝", async () => {
  await withKernel(async (host) => {
    const mainAgentId = host.mainAgentId;
    assert.ok(mainAgentId);
    assert.equal(host.kernel.agents.enableNativeMain(host.researchHarness.executor, { actor: "user" }).runtimeName, "pi-research");
    assert.throws(() => host.kernel.agents.setRuntime(mainAgentId as never, "deepseek-harness-sdk", { actor: "user" }), /未注册/);
  });
});

test("重启后 Main 的执行者绑定来自事件重放，而不是进程内状态", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "xiling-research-harness-restart-"));
  try {
    const first = await startOsKernel(directory, { readModelKey: () => undefined });
    const mainAgentId = first.mainAgentId;
    await first.shutdown();

    const second = await startOsKernel(directory, { readModelKey: () => undefined });
    try {
      assert.equal(second.mainAgentId, mainAgentId);
      assert.equal(second.kernel.projection.agents.get(mainAgentId as never)?.runtimeName, "pi-research");
      assert.equal(second.kernel.projection.agents.size, 1);
    } finally {
      await second.shutdown();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
