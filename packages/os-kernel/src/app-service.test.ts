import test from "node:test";
import assert from "node:assert/strict";
import type { AppPackage } from "@xiling/os-domain";
import { OSKernel } from "./kernel.js";

const user = { actor: "user" as const };

test("App view filters tasks by both session and owner, and rejects cross-App reads", async () => {
  const kernel = new OSKernel();
  const a = kernel.apps.install(manifest(), [], user);
  const b = kernel.apps.install(manifest(), [], user);
  const first = kernel.apps.open(a.id, user).session;
  const second = kernel.apps.open(a.id, user).session;
  const task = await kernel.apps.submit(a.id, first.id, "visible", user);
  await kernel.apps.submit(a.id, second.id, "private other session", user);
  assert.deepEqual(kernel.apps.view(a.id, first.id, user).tasks.map((item) => item.id), [task.id]);
  assert.throws(() => kernel.apps.view(b.id, first.id, user), /不属于/);
  assert.throws(() => kernel.apps.view(a.id, first.id, { actor: "agent", actorAgentId: b.agentId }), /用户/);
  const copy = kernel.apps.view(a.id, first.id, user); copy.tasks[0]!.goal = "mutated";
  assert.equal(kernel.tasks.get(task.id).goal, "visible");
});

test("direct App submission uses its own session and shared Task service", async () => {
  const kernel = new OSKernel();
  const a = kernel.apps.install(manifest(), [], user);
  const b = kernel.apps.install(manifest(), [], user);
  const session = kernel.apps.open(a.id, user).session;
  const task = await kernel.apps.submit(a.id, session.id, "draft", user);
  assert.equal(task.ownerAgentId, a.agentId);
  assert.equal(task.assignedAgentId, a.agentId);
  assert.equal(kernel.tasks.get(task.id).sessionId, session.id);
  const count = kernel.projection.tasks.size;
  await assert.rejects(() => kernel.apps.submit(b.id, session.id, "cross app", user), /不属于/);
  await assert.rejects(() => kernel.apps.submit(a.id, session.id, "spoof", { actor: "agent", actorAgentId: b.agentId }), /用户/);
  assert.equal(kernel.projection.tasks.size, count);
});
function manifest(): AppPackage {
  return { id: "local.writer", version: "1.0.0", name: "文档", description: "整理文本", runtimeName: "real", instructions: "输出文档", capabilities: ["document.compose"], requestedActions: [], defaultModel: {}, ui: { kind: "agent-chat" } };
}

test("upgrade preserves identity, model policy and sessions across replay", () => {
  const kernel = new OSKernel();
  const app = kernel.apps.install(manifest(), [], user);
  const session = kernel.apps.open(app.id, user).session;
  const preferred = { providerId: "private", modelId: "my-model" };
  kernel.agents.updateModelPolicy(app.agentId, { preferred });
  kernel.apps.setEnabled(app.id, false, user);
  const updated = kernel.apps.upgrade(app.id, { ...manifest(), version: "1.1.0", instructions: "新行为", defaultModel: { primary: "other/model" } }, user);
  assert.equal(updated.agentId, app.agentId);
  assert.equal(updated.history?.[0]?.version, "1.0.0");
  assert.deepEqual(kernel.agents.get(app.agentId).modelPolicy, { preferred });
  assert.equal(kernel.agents.get(app.agentId).systemInstructions, "新行为");
  const recovered = new OSKernel(); recovered.events.hydrate(kernel.events.all());
  recovered.apps.setEnabled(app.id, true, user);
  assert.equal(recovered.apps.open(app.id, user, session.id).session.id, session.id);
  assert.equal(recovered.apps.get(app.id).package.version, "1.1.0");
});

test("unsafe or non-increasing upgrades are rejected before changing facts", () => {
  const kernel = new OSKernel();
  const app = kernel.apps.install(manifest(), [], user);
  kernel.apps.setEnabled(app.id, false, user);
  const count = kernel.events.all().length;
  assert.throws(() => kernel.apps.upgrade(app.id, manifest(), user), /递增/);
  assert.throws(() => kernel.apps.upgrade(app.id, { ...manifest(), version: "2.0.0", requestedActions: ["file.delete"] }, user), /权限/);
  assert.throws(() => kernel.apps.upgrade(app.id, { ...manifest(), version: "2.0.0", runtimeName: "arbitrary" }, user), /引擎/);
  assert.equal(kernel.events.all().length, count);
});

test("uninstall tombstones the instance without deleting durable session data", async () => {
  const kernel = new OSKernel();
  const app = kernel.apps.install(manifest(), [], user);
  const session = kernel.apps.open(app.id, user).session;
  kernel.apps.setEnabled(app.id, false, user);
  kernel.apps.remove(app.id, user);
  assert.equal(kernel.sessions.get(session.id).agentId, app.agentId);
  assert.equal(kernel.apps.discover("document.compose").length, 0);
  assert.throws(() => kernel.apps.setEnabled(app.id, true, user), /卸载/);
  await assert.rejects(() => kernel.agents.ensureActivation(app.agentId), /停用/);
});
test("App install atomically creates persistent Agent without activating a process", () => {
  const kernel = new OSKernel();
  const app = kernel.apps.install(manifest(), [], user);
  assert.equal(kernel.events.all().length, 1);
  assert.equal(kernel.agents.get(app.agentId).name, "文档");
  assert.equal(kernel.projection.activations.size, 0);
  const recovered = new OSKernel();
  recovered.events.hydrate(kernel.events.all());
  assert.equal(recovered.apps.get(app.id).agentId, app.agentId);
  assert.equal(recovered.agents.get(app.agentId).id, app.agentId);
});
test("App sessions are independent, resumable and cannot cross identities", () => {
  const kernel = new OSKernel();
  const a = kernel.apps.install(manifest(), [], user);
  const b = kernel.apps.install(manifest(), [], user);
  const first = kernel.apps.open(a.id, user);
  const second = kernel.apps.open(a.id, user);
  assert.notEqual(first.session.id, second.session.id);
  assert.equal(kernel.apps.open(a.id, user, first.session.id).session.id, first.session.id);
  assert.throws(() => kernel.apps.open(b.id, user, first.session.id), /不属于/);
  kernel.sessions.close(first.session.id);
  assert.throws(() => kernel.apps.open(a.id, user, first.session.id), /已结束/);
});
test("App permission review and management reject unauthorized callers and executable manifests", () => {
  const kernel = new OSKernel();
  assert.throws(() => kernel.apps.install({ ...manifest(), requestedActions: ["file.write"] }, [], user), /权限/);
  assert.throws(() => kernel.apps.install(manifest(), ["file.write"], user), /权限/);
  assert.throws(() => kernel.apps.install(manifest(), [], { actor: "agent" }), /用户/);
  assert.throws(() => kernel.apps.install({ ...manifest(), entry: "evil.js" } as AppPackage, [], user), /不支持字段/);
  assert.equal(kernel.events.all().length, 0);
});
test("disabled App disappears from discovery and cannot bypass through Agent activation", async () => {
  const kernel = new OSKernel();
  const app = kernel.apps.install(manifest(), [], user);
  assert.equal(kernel.apps.discover("document.compose").length, 1);
  kernel.apps.setEnabled(app.id, false, user);
  assert.equal(kernel.apps.discover("document.compose").length, 0);
  assert.throws(() => kernel.apps.open(app.id, user), /停用/);
  await assert.rejects(() => kernel.agents.ensureActivation(app.agentId), /停用/);
  kernel.apps.setEnabled(app.id, true, user);
  assert.equal(kernel.apps.get(app.id).agentId, app.agentId);
  const copy = kernel.apps.get(app.id); copy.package.name = "mutated";
  assert.equal(kernel.apps.get(app.id).package.name, "文档");
});
test("App cannot be disabled while unfinished assigned work exists", async () => {
  const kernel = new OSKernel();
  const app = kernel.apps.install(manifest(), [], user);
  const task = await kernel.tasks.create({ goal: "write", ownerAgentId: app.agentId, assignedAgentId: app.agentId });
  assert.throws(() => kernel.apps.setEnabled(app.id, false, user), /未完成/);
  await kernel.tasks.cancel(task.id, "cancel");
  assert.equal(kernel.apps.setEnabled(app.id, false, user).state, "disabled");
});
