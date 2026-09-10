import test from "node:test";
import assert from "node:assert/strict";
import {
  agentId, delegationId, taskId,
} from "@xiling/os-domain";
import type { DelegationRequest, Task } from "@xiling/os-domain";
import { A2AStandardClient } from "./a2a-transport.js";
import type { A2APeer, A2ATransport, A2ATransportUpdate } from "./a2a-transport.js";

const peer: A2APeer = { id: "remote-lab", endpoint: "https://agents.example.test/a2a" };

function fixture(): { delegation: DelegationRequest; task: Task } {
  const delegation: DelegationRequest = {
    delegationId: delegationId("dlg_1"),
    fromAgentId: agentId("agent_main"),
    toAgentId: agentId("agent_remote"),
    taskId: taskId("task_1"),
    goal: "核对数据",
    context: { summary: "只发送必要摘要" },
    inputArtifacts: [],
    capabilityGrantIds: [],
  };
  return {
    delegation,
    task: {
      id: delegation.taskId,
      goal: delegation.goal,
      ownerAgentId: delegation.fromAgentId,
      assignedAgentId: delegation.toAgentId,
      dependsOnTaskIds: [],
      state: "created",
      inputArtifacts: [],
      outputArtifacts: [],
      constraints: {},
      createdAt: new Date().toISOString(),
    },
  };
}

function transportFor(updates: A2ATransportUpdate[], onCancel: (reason?: string) => void = () => undefined): A2ATransport {
  return {
    async *sendTask() { for (const update of updates) yield update; },
    async cancelTask(_peer, _taskId, reason) { onCancel(reason); },
  };
}

test("远端进度与终态被归一化，ArtifactRef 经过身份和版本校验", async () => {
  const { delegation, task } = fixture();
  const statuses: string[] = [];
  const client = new A2AStandardClient(transportFor([
    { task: { id: task.id, contextId: delegation.delegationId, status: { state: "working" } } },
    { task: {
      id: task.id,
      contextId: delegation.delegationId,
      status: { state: "completed", message: { role: "agent", parts: [{ kind: "text", text: "核对完成" }] } },
      artifacts: [{ artifactId: "art_result", parts: [{ kind: "data", data: { artifactId: "art_result", version: 2 } }] }],
    } },
  ]));
  const result = await client.execute({
    peer, delegation, task,
    onStatus(status) { statuses.push(status.state); },
  });
  assert.deepEqual(statuses, ["accepted", "completed"]);
  assert.equal(result.reason, "核对完成");
  assert.deepEqual(result.outputArtifacts, [{ artifactId: "art_result", version: 2 }]);
  assert.equal(result.fromAgentId, delegation.toAgentId);
});

test("错配的 task/context 回执不会串入其他委托", async () => {
  const { delegation, task } = fixture();
  const reports: string[] = [];
  const client = new A2AStandardClient(transportFor([
    { task: { id: "task_other", contextId: delegation.delegationId, status: { state: "completed" } } },
  ]));
  const result = await client.execute({ peer, delegation, task, onStatus(status) { reports.push(status.state); } });
  assert.deepEqual(reports, ["failed"]);
  assert.equal(result.state, "failed");
  assert.match(result.reason ?? "", /task mismatch/);
});

test("畸形 Artifact 回执使委托失败，不把不可信引用交给内核", async () => {
  const { delegation, task } = fixture();
  const client = new A2AStandardClient(transportFor([{ task: {
    id: task.id,
    contextId: delegation.delegationId,
    status: { state: "completed" },
    artifacts: [{ artifactId: "art_safe", parts: [{ kind: "data", data: { artifactId: "art_spoof", version: 1 } }] }],
  } }]));
  const result = await client.execute({ peer, delegation, task, onStatus() {} });
  assert.equal(result.state, "failed");
  assert.deepEqual(result.outputArtifacts, []);
  assert.match(result.reason ?? "", /identity mismatch/);
});

test("AbortSignal 触发远端取消，并只产生一个取消终态", async () => {
  const { delegation, task } = fixture();
  const controller = new AbortController();
  const states: string[] = [];
  let cancelCount = 0;
  const transport: A2ATransport = {
    async *sendTask(_peer, _task, signal) {
      yield { task: { id: task.id, contextId: delegation.delegationId, status: { state: "working" } } };
      controller.abort();
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    },
    async cancelTask() { cancelCount += 1; },
  };
  const result = await new A2AStandardClient(transport).execute({
    peer, delegation, task, signal: controller.signal,
    onStatus(status) { states.push(status.state); },
  });
  assert.equal(result.state, "cancelled");
  assert.equal(cancelCount, 1);
  assert.deepEqual(states, ["accepted", "cancelled"]);
});
