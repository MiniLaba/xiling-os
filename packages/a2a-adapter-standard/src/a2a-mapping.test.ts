// A2A 标准映射测试：内部模型 → wire 模型的往返一致性 + Extension 边界。

import test from "node:test";
import assert from "node:assert/strict";
import {
  a2aMessageToBundle, bundleToA2AMessage, fromA2ATaskState, toA2ATask, toA2ATaskState, toAgentCard,
} from "./a2a-mapping.js";
import { agentId as makeAgentId, delegationId, grantId as makeGrantId, taskId as makeTaskId } from "@xiling/os-domain";
import type { DelegationRequest, Task } from "@xiling/os-domain";

function fakeDelegation(): DelegationRequest {
  return {
    delegationId: delegationId("dlg_1"),
    fromAgentId: makeAgentId("agent_main"),
    toAgentId: makeAgentId("agent_worker"),
    taskId: makeTaskId("task_9"),
    goal: "生成图表",
    context: {
      summary: "Q3 数据已就绪",
      facts: [{ key: "region", value: "日本", sourceRef: "memory:mem_1" }],
      constraints: ["中文标签"],
    },
    inputArtifacts: [],
    capabilityGrantIds: [makeGrantId("grant_1"), makeGrantId("grant_2")],
  };
}

function fakeTask(state: Task["state"] = "running"): Task {
  return {
    id: makeTaskId("task_9"),
    goal: "生成图表",
    ownerAgentId: makeAgentId("agent_main"),
    assignedAgentId: makeAgentId("agent_worker"),
    dependsOnTaskIds: [],
    state,
    inputArtifacts: [],
    outputArtifacts: [{ artifactId: "art_7", version: 3 }],
    constraints: {},
    createdAt: new Date().toISOString(),
  };
}

test("状态映射覆盖全部内部状态", () => {
  assert.equal(toA2ATaskState("created"), "submitted");
  assert.equal(toA2ATaskState("queued"), "submitted");
  assert.equal(toA2ATaskState("running"), "working");
  assert.equal(toA2ATaskState("waiting_input"), "input-required");
  assert.equal(toA2ATaskState("waiting_approval"), "working");
  assert.equal(toA2ATaskState("completed"), "completed");
  assert.equal(toA2ATaskState("failed"), "failed");
  assert.equal(toA2ATaskState("cancelled"), "canceled");
});

test("ContextBundle → A2A message：text/data parts 且保留溯源", () => {
  const message = bundleToA2AMessage(fakeDelegation().context);
  assert.equal(message.role, "agent");
  assert.equal(message.parts[0]!.kind, "text");
  assert.equal(message.parts[0]!.text, "Q3 数据已就绪");
  const factPart = message.parts[1]!;
  assert.equal(factPart.kind, "data");
  assert.deepEqual(factPart.data, { key: "region", value: "日本", sourceRef: "memory:mem_1" });
  const last = message.parts.at(-1)!;
  assert.equal(last.kind, "text");
  assert.match(last.text ?? "", /中文标签/);
});

test("DelegationRequest + Task → A2A Task：Extension 只进 metadata", () => {
  const wire = toA2ATask(fakeDelegation(), fakeTask("completed"));
  assert.equal(wire.id, "task_9");
  assert.equal(wire.contextId, "dlg_1");
  assert.equal(wire.status.state, "completed");
  assert.equal(wire.artifacts?.length, 1);
  const part = wire.artifacts?.[0]!.parts[0]!;
  assert.equal(part.kind, "data");
  assert.deepEqual(part.data, { artifactId: "art_7", version: 3, uri: "artifact://art_7/version/3" });
  // Capability Grant 是 OS Extension：只出现在 metadata，外部对端可忽略
  assert.deepEqual(wire.metadata?.capabilityGrantIds, [makeGrantId("grant_1"), makeGrantId("grant_2")]);
});

test("AgentCard：skills 来自能力目录，插件作为 tags", () => {
  const card = toAgentCard({
    id: makeAgentId("agent_main"),
    name: "Main Agent",
    isMainAgent: true,
    modelPolicy: {},
    pluginBindings: [{ pluginId: "github", version: "1.0" }],
    memoryPolicy: {},
    workspacePolicy: {},
    permissionPolicy: { allowedActions: ["github.repo.write", "task.delegate"] },
    runtimeName: "dsh",
    createdAt: new Date().toISOString(),
    version: 2,
  }, { url: "https://os.local/agents/main" });
  assert.equal(card.name, "Main Agent");
  assert.equal(card.capabilities.streaming, true);
  assert.deepEqual(card.skills.map((skill) => skill.id), ["github.repo.write", "task.delegate"]);
  assert.deepEqual(card.skills[0]!.tags, ["github"]);
  assert.equal(card.url, "https://os.local/agents/main");
});

test("wire → 内部往返：message 解回 ContextBundle 语义等价", () => {
  const original = fakeDelegation().context;
  const message = bundleToA2AMessage(original);
  const restored = a2aMessageToBundle(message);
  assert.equal(restored.summary, original.summary);
  assert.deepEqual(restored.constraints, original.constraints);
  assert.deepEqual(restored.facts?.map((fact) => ({ key: fact.key, value: fact.value })), [{ key: "region", value: "日本" }]);
});

test("wire 状态 → 内部回执状态", () => {
  assert.equal(fromA2ATaskState("working"), "accepted");
  assert.equal(fromA2ATaskState("input-required"), "pending");
  assert.equal(fromA2ATaskState("completed"), "completed");
  assert.equal(fromA2ATaskState("failed"), "failed");
  assert.equal(fromA2ATaskState("canceled"), "cancelled");
  assert.equal(fromA2ATaskState("submitted"), "accepted");
});
