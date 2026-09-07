// PluginService 测试（指南 §20/§21）：清单注册、绑定校验、能力目录、事件驱动重放。

import test from "node:test";
import assert from "node:assert/strict";
import { agentId as makeAgentId, OsError } from "@xiling/os-domain";
import type { AgentPluginManifest } from "@xiling/os-domain";
import { OSKernel } from "./kernel.js";

function manifest(overrides: Partial<AgentPluginManifest> = {}): AgentPluginManifest {
  return {
    id: "github",
    version: "1.0.0",
    runtime: { entry: "./index.js" },
    provides: [{ action: "github.repo.write", description: "写仓库" }],
    permissions: ["github.repo.write"],
    ...overrides,
  };
}

test("注册清单 → 能力目录可发现（§21 谁拥有 capability）", () => {
  const kernel = new OSKernel();
  kernel.plugins.register(manifest());
  const discovered = kernel.capabilities.discover("github.");
  assert.ok(discovered.some((descriptor) => descriptor.action === "github.repo.write"));
});

test("绑定成功：事件驱动写入投影，重放后绑定仍在", async () => {
  const persisted: string[] = [];
  const kernel = new OSKernel({ eventHooks: { append: (event) => persisted.push(JSON.stringify(event)) } });
  kernel.plugins.register(manifest());
  const agent = await kernel.agents.create({
    name: "coder",
    runtimeName: "scripted",
    allowedActions: ["github.repo.write"],
  });
  await kernel.plugins.bindToAgent(agent.id, "github");
  assert.deepEqual(kernel.agents.get(agent.id).pluginBindings, [{ pluginId: "github", version: "1.0.0" }]);

  // 重放一致性：绑定是事件事实，不是内存突变
  const replayed = OSKernel.replayProjection(kernel.events.all());
  assert.deepEqual(replayed.agents.get(agent.id)?.pluginBindings, [{ pluginId: "github", version: "1.0.0" }]);
  void persisted;
});

test("绑定被拒：插件请求的权限超出 Agent 策略天花板", async () => {
  const kernel = new OSKernel();
  kernel.plugins.register(manifest({ permissions: ["production.deploy"] }));
  const agent = await kernel.agents.create({ name: "limited", runtimeName: "scripted", allowedActions: ["repo.read"] });
  await assert.rejects(
    () => kernel.plugins.bindToAgent(agent.id, "github"),
    (error: unknown) => error instanceof OsError && error.code === "permission_denied",
  );
});

test("绑定被拒：readOnly Agent 不能绑要求 memory.write 的插件", async () => {
  const kernel = new OSKernel();
  kernel.plugins.register(manifest({ memory: { write: true } }));
  const agent = await kernel.agents.create({
    name: "reader",
    runtimeName: "scripted",
    allowedActions: [],
    memoryPolicy: { readOnly: true },
  });
  await assert.rejects(
    () => kernel.plugins.bindToAgent(agent.id, "github"),
    (error: unknown) => error instanceof OsError && error.code === "permission_denied",
  );
});

test("依赖解析：requires 的插件必须已注册", async () => {
  const kernel = new OSKernel();
  kernel.plugins.register(manifest({ id: "dependent", requires: ["missing-base"], permissions: [] }));
  const agent = await kernel.agents.create({ name: "a", runtimeName: "scripted", allowedActions: [] });
  await assert.rejects(
    () => kernel.plugins.bindToAgent(agent.id, "dependent"),
    (error: unknown) => error instanceof OsError && error.code === "entity_not_found",
  );
});

test("解绑：事件驱动移除绑定且可重放", async () => {
  const kernel = new OSKernel();
  kernel.plugins.register(manifest());
  const agent = await kernel.agents.create({ name: "c", runtimeName: "scripted", allowedActions: ["github.repo.write"] });
  await kernel.plugins.bindToAgent(agent.id, "github");
  await kernel.plugins.unbindFromAgent(agent.id, "github");
  assert.equal(kernel.agents.get(agent.id).pluginBindings.length, 0);
  const replayed = OSKernel.replayProjection(kernel.events.all());
  assert.equal(replayed.agents.get(agent.id)?.pluginBindings.length, 0);
});

test("通配符策略：allowedActions 的 ':*' 覆盖插件请求", async () => {
  const kernel = new OSKernel();
  kernel.plugins.register(manifest({ permissions: ["github.repo.read"] }));
  const agent = await kernel.agents.create({ name: "w", runtimeName: "scripted", allowedActions: ["github.repo:*"] });
  await kernel.plugins.bindToAgent(agent.id, "github");
  assert.equal(kernel.agents.get(agent.id).pluginBindings.length, 1);
  void makeAgentId;
});

test("受管插件生命周期：安装、启用、停用、升级、回滚均为可重放事实", async () => {
  const kernel = new OSKernel();
  const calls: string[] = [];
  kernel.plugins.setLifecycleHost({
    async prepare(value) { calls.push(`prepare:${value.version}`); },
    async activate(value) { calls.push(`activate:${value.version}`); },
    async deactivate(id) { calls.push(`deactivate:${id}`); },
    async remove(id) { calls.push(`remove:${id}`); },
  });
  await kernel.plugins.install(manifest(), { enable: true });
  assert.equal(kernel.plugins.listInstallations()[0]?.state, "enabled");
  await kernel.plugins.disable("github");
  assert.equal(kernel.plugins.isEnabled("github"), false);
  await kernel.plugins.enable("github");
  await kernel.plugins.upgrade(manifest({ version: "2.0.0" }));
  assert.equal(kernel.plugins.get("github").version, "2.0.0");
  assert.equal(kernel.plugins.listInstallations()[0]?.history.length, 1);
  await kernel.plugins.rollback("github");
  assert.equal(kernel.plugins.get("github").version, "1.0.0");
  assert.equal(kernel.plugins.listInstallations()[0]?.history.length, 0);
  assert.ok(calls.includes("activate:2.0.0"));

  const restored = new OSKernel();
  restored.events.hydrate(kernel.events.all());
  restored.plugins.restoreInstalledCatalog();
  assert.equal(restored.plugins.get("github").version, "1.0.0");
  assert.equal(restored.plugins.listInstallations()[0]?.state, "enabled");
});

test("禁用插件不进入能力目录；仍绑定时拒绝卸载", async () => {
  const kernel = new OSKernel();
  kernel.plugins.setLifecycleHost({ async prepare() {}, async activate() {}, async deactivate() {}, async remove() {} });
  await kernel.plugins.install(manifest(), { enable: true });
  const agent = await kernel.agents.create({ name: "agent", runtimeName: "scripted", allowedActions: ["github.repo.write"] });
  await kernel.plugins.bindToAgent(agent.id, "github");
  assert.equal(kernel.resolver.catalogFor(agent.id).length, 1);
  await kernel.plugins.disable("github");
  assert.equal(kernel.resolver.catalogFor(agent.id).length, 0);
  await assert.rejects(() => kernel.plugins.remove("github"), /still bound/);
  await kernel.plugins.unbindFromAgent(agent.id, "github");
  await kernel.plugins.remove("github");
  assert.equal(kernel.plugins.listInstallations().length, 0);
  assert.equal(kernel.capabilities.discover("github.").length, 0);
});

test("升级激活失败会恢复旧版本运行态并记录失败，不篡改当前版本", async () => {
  const kernel = new OSKernel();
  const activated: string[] = [];
  kernel.plugins.setLifecycleHost({
    async prepare() {},
    async activate(value) {
      activated.push(value.version);
      if (value.version === "2.0.0") throw new Error("broken plugin");
    },
    async deactivate() {},
    async remove() {},
  });
  await kernel.plugins.install(manifest(), { enable: true });
  await assert.rejects(() => kernel.plugins.upgrade(manifest({ version: "2.0.0" })), /broken plugin/);
  assert.deepEqual(activated, ["1.0.0", "2.0.0", "1.0.0"]);
  assert.equal(kernel.plugins.get("github").version, "1.0.0");
  assert.equal(kernel.plugins.listInstallations()[0]?.state, "enabled");
  assert.equal(kernel.plugins.listInstallations()[0]?.lastError?.operation, "upgrade");
});
