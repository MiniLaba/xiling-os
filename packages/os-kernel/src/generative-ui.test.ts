import test from "node:test";
import assert from "node:assert/strict";
import { OSKernel } from "./kernel.js";
import { taskTools } from "./runtime-tools.js";

test("generated UI is scoped, validated and submits typed input to the same task", async () => {
  const kernel = new OSKernel();
  const agent = await kernel.agents.create({ name: "UI test", runtimeName: "test", allowedActions: ["ui.present"] });
  const task = await kernel.tasks.create({ goal: "Choose an itinerary", ownerAgentId: agent.id, assignedAgentId: agent.id });
  const runId = "run-ui-test" as never;
  kernel.tasks.transition(task.id, { type: "task.started", payload: { taskId: task.id, runId } });
  const execute = taskTools(kernel, { agentId: agent.id, taskId: task.id, runId });
  await assert.rejects(execute("xiling_os", { op: "ui.present", kind: "html", title: "bad", data: {} }, "bad"), /Unsupported/);
  await assert.rejects(execute("xiling_os", { op: "ui.present", kind: "chart", title: "bad", data: { type: "bar", series: [{ label: "bad", value: "NaN" }] } }, "bad-chart"), /契约/);
  const chart = { op: "ui.present", kind: "chart", title: "Budget", data: { type: "bar", series: [{ label: "Travel", value: 300 }, { label: "Food", value: 120 }] } };
  await execute("xiling_os", chart, "chart");
  await execute("xiling_os", chart, "chart");
  assert.equal(kernel.ui.openSurfaces().length, 1, "idempotent tool call");
  const form = await execute("xiling_os", { op: "ui.present", kind: "form", title: "Your choice", data: { fields: [{ id: "pace", label: "Pace", type: "select", options: ["Slow", "Fast"] }, { id: "days", label: "Days", type: "number" }] }, actions: [{ command: "tool.confirm" }] }, "form") as { surfaceId: string };
  assert.equal(kernel.tasks.get(task.id).state, "waiting_input");
  assert.equal(kernel.ui.openSurfaces().find((surface) => surface.id === form.surfaceId)?.actions[0]?.command, "task.submit_input", "host owns actions");
  await assert.rejects(kernel.ui.executeAction(form.surfaceId, "submit", { pace: "unknown", days: 2 }, { actor: "user" }), /结构/);
  // Keep this offline test at the scheduling boundary; the real runtime is tested separately.
  kernel.scheduler.tick = async () => {};
  await kernel.ui.executeAction(form.surfaceId, "submit", { pace: "Slow", days: 2 }, { actor: "user" });
  assert.deepEqual(kernel.tasks.get(task.id).submittedInputs?.at(-1)?.payload, { pace: "Slow", days: 2 });
  assert.ok(!kernel.ui.openSurfaces().some((surface) => surface.id === form.surfaceId));
  await assert.rejects(kernel.ui.executeAction(form.surfaceId, "submit", { pace: "Slow", days: 2 }, { actor: "user" }), /closed/);
});
