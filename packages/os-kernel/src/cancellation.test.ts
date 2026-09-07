import test from "node:test";
import assert from "node:assert/strict";
import type { AgentRuntime, RuntimeEvent } from "@xiling/os-runtime";
import { OSKernel } from "./kernel.js";

test("task cancellation invokes runtime disposal and rejects late success", async () => {
  const kernel = new OSKernel();
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const stopped = new Promise<void>((resolve) => { release = resolve; });
  let interrupted = false;
  const runtime: AgentRuntime = {
    name: "test-cancel", supportsCancellation: true,
    async activate() {}, async suspend() {}, async resume() {},
    async interrupt() { interrupted = true; release(); },
    async *run(request): AsyncIterable<RuntimeEvent> {
      started(); await stopped;
      yield { type: "run.completed", runId: request.runId };
    },
  };
  kernel.runtimes.register(runtime);
  const address = { providerId: "test", modelId: "text" };
  kernel.modelCatalog.register({ address, nativeInputs: ["text"], nativeOutputs: ["text"], contextWindowTokens: 8000, source: "user-declared" });
  const agent = await kernel.agents.create({ name: "A", runtimeName: runtime.name, allowedActions: [], modelPolicy: { preferred: address } });
  const task = await kernel.tasks.create({ goal: "wait", ownerAgentId: agent.id, assignedAgentId: agent.id });
  const execution = kernel.runner.executeTask(task.id);
  await ready;
  await kernel.tasks.cancel(task.id, "user cancelled");
  await execution;
  assert.equal(interrupted, true);
  assert.equal(kernel.tasks.get(task.id).state, "cancelled");
  assert.equal(kernel.events.all().some((event) => event.type === "task.completed"), false);
});

test("missing runtime becomes explicit task failure, not simulated completion", async () => {
  const kernel = new OSKernel();
  const agent = await kernel.agents.create({ name: "A", runtimeName: "unconfigured", allowedActions: [] });
  const task = await kernel.tasks.create({ goal: "write", ownerAgentId: agent.id, assignedAgentId: agent.id });
  assert.equal((await kernel.runner.executeTask(task.id)).state, "failed");
  assert.match(kernel.tasks.get(task.id).statusReason ?? "", /未配置/);
});
