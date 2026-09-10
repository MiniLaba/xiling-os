// 科研 Harness 主路径的启动验收：默认路线、能力声明与重启恢复。
// 直接启动真实的 OS Kernel Host（不经过 Electron），因此这里跑的是真实装配代码路径，
// 不是 stub。Pi 包与 DSH 适配器都是真实注册；模型凭据缺失只影响单次轮次，
// 不影响"哪条科研路线在生效"这一事实的上报。

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

test("默认科研主路径绑定 Pi，并如实上报请求路线与可用性", async () => {
  await withKernel(async (host) => {
    delete process.env.XILING_RESEARCH_HARNESS;
    assert.equal(host.researchHarness.requested, "pi");
    assert.equal(host.researchHarness.piAvailable, true);
    assert.equal(host.researchHarness.active, "pi-research");
    assert.equal(mainRuntimeName(host), "pi-research");
    // DSH 仍作为并列适配器注册，是适配器而不是第二个产品后端。
    assert.ok(host.kernel.runtimes.get("deepseek-harness-sdk"));
    assert.ok(host.kernel.runtimes.get("pi-research"));
  });
});

test("Pi 适配器的能力声明保守：只有文本、不自称已接宿主工具", async () => {
  await withKernel(async (host) => {
    const runtime = host.kernel.runtimes.get("pi-research");
    assert.ok(runtime);
    assert.deepEqual([...runtime.nativeInputModalities ?? []], ["text"]);
    assert.deepEqual([...runtime.nativeOutputModalities ?? []], ["text"]);
    assert.notEqual(runtime.supportsHostTools, true);
    assert.equal(runtime.supportsCancellation, true);
  });
});

test("显式要求 DSH 时不会被静默换成 Pi", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "xiling-research-harness-dsh-"));
  let host: OsKernelHost | undefined;
  process.env.XILING_RESEARCH_HARNESS = "dsh";
  try {
    host = await startOsKernel(directory, { readModelKey: () => undefined });
    assert.equal(host.researchHarness.requested, "dsh");
    assert.equal(host.researchHarness.active, "deepseek-harness-sdk");
    assert.equal(mainRuntimeName(host), "deepseek-harness-sdk");
    assert.equal(host.kernel.runtimes.get("pi-research"), undefined);
  } finally {
    delete process.env.XILING_RESEARCH_HARNESS;
    await host?.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test("重启后 Main 的科研运行时绑定来自事件重放，而不是进程内状态", async () => {
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
