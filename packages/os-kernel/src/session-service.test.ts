import test from "node:test";
import assert from "node:assert/strict";
import { OsError } from "@xiling/os-domain";
import { OSKernel } from "./kernel.js";
import type { AgentRuntime, RunRequest } from "@xiling/os-runtime";

test("运行上下文只继承同一 Session 的消息，不串入同 Agent 其他会话", async () => {
  const kernel = new OSKernel();
  const requests: RunRequest[] = [];
  const runtime: AgentRuntime = {
    name: "session-fixture", async activate() {}, async interrupt() {}, async suspend() {}, async resume() {},
    async *run(request) {
      requests.push(request);
      yield { type: "message", runId: request.runId, text: "PRIVATE_FIRST_SESSION" };
      yield { type: "run.completed", runId: request.runId };
    },
  };
  kernel.runtimes.register(runtime);
  const address = { providerId: "test", modelId: "text" };
  kernel.modelCatalog.register({ address, nativeInputs: ["text"], nativeOutputs: ["text"], contextWindowTokens: 8000, source: "user-declared" });
  const agent = await kernel.agents.create({ name: "A", runtimeName: runtime.name, allowedActions: [], modelPolicy: { preferred: address } });
  const a = kernel.sessions.open({ agentId: agent.id });
  const b = kernel.sessions.open({ agentId: agent.id });
  for (const session of [a, b, a]) {
    const task = await kernel.tasks.create({ goal: "continue", sessionId: session.id, ownerAgentId: agent.id, assignedAgentId: agent.id });
    await kernel.runner.executeTask(task.id);
  }
  assert.doesNotMatch(JSON.stringify(requests[1]?.contextBundle), /PRIVATE_FIRST_SESSION/);
  assert.match(JSON.stringify(requests[2]?.contextBundle), /PRIVATE_FIRST_SESSION/);
});

test("Session：同一 Agent 可有多次连续工作，Task 明确归属且可重放", async () => {
  const kernel = new OSKernel();
  const agent = await kernel.agents.create({ name: "Main", isMainAgent: true, runtimeName: "scripted", allowedActions: [] });
  const first = kernel.sessions.open({ agentId: agent.id, title: "安排团建" });
  const second = kernel.sessions.open({ agentId: agent.id, title: "整理项目" });
  const task = await kernel.tasks.create({ goal: "比较三个地点", ownerAgentId: agent.id, sessionId: first.id });

  assert.notEqual(first.id, second.id);
  assert.deepEqual(kernel.sessions.get(first.id).taskIds, [task.id]);
  assert.equal(task.sessionId, first.id);

  const replayed = OSKernel.replayProjection(kernel.events.all());
  assert.deepEqual(replayed.sessions.get(first.id)?.taskIds, [task.id]);
  assert.equal(replayed.tasks.get(task.id)?.sessionId, first.id);
});

test("Session：关闭后不能再接收 Task，且不能跨 Agent 冒用", async () => {
  const kernel = new OSKernel();
  const owner = await kernel.agents.create({ name: "Owner", runtimeName: "scripted", allowedActions: [] });
  const other = await kernel.agents.create({ name: "Other", runtimeName: "scripted", allowedActions: [] });
  const session = kernel.sessions.open({ agentId: owner.id });

  await assert.rejects(
    () => kernel.tasks.create({ goal: "越界", ownerAgentId: other.id, sessionId: session.id }),
    (error: unknown) => error instanceof OsError && error.code === "permission_denied",
  );

  kernel.sessions.close(session.id);
  await assert.rejects(
    () => kernel.tasks.create({ goal: "已关闭", ownerAgentId: owner.id, sessionId: session.id }),
    (error: unknown) => error instanceof OsError && error.code === "illegal_transition",
  );
});
