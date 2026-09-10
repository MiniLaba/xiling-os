// Context Compiler + Budget Manager 测试（指南 §38/§39）。

import test from "node:test";
import assert from "node:assert/strict";
import { agentId as makeAgentId, memoryRecordId as makeMemoryRecordId } from "@xiling/os-domain";
import { DEFAULT_CONTEXT_BUDGET, compileContext, estimateTokens, renderCompiledContext } from "./context-compiler.js";

function memory(id: string, content: string) {
  return {
    id: makeMemoryRecordId(id),
    agentId: makeAgentId("agent_1"),
    type: "semantic" as const,
    content,
    dedupeKey: id,
    provenance: { origin: "user" as const },
    createdAt: "2026-09-01T00:00:00.000Z",
  };
}

test("预算分配：各片段上限 = 窗口 × 比例", () => {
  const compiled = compileContext({
    modelWindowTokens: 10_000,
    systemPolicy: "系统策略",
    task: { taskId: "task_1", goal: "目标" },
  });
  const system = compiled.sections.find((section) => section.name === "system-policy")!;
  assert.equal(system.budgetTokens, 1_000);
  const task = compiled.sections.find((section) => section.name === "task")!;
  assert.equal(task.budgetTokens, 1_500);
});

test("超预算片段被截断且显式标注，不静默丢弃", () => {
  const compiled = compileContext({
    modelWindowTokens: 100, // 极小窗口 → 每段上限极小
    task: { taskId: "task_1", goal: "这是一个非常长的目标".repeat(50) },
  });
  const task = compiled.sections.find((section) => section.name === "task")!;
  assert.match(task.content, /\[已按上下文预算截断\]/);
  assert.ok(task.tokens <= task.budgetTokens + 10); // 近似不超预算
});

test("provenance：记忆片段携带记录 ID，可追溯来源", () => {
  const compiled = compileContext({
    modelWindowTokens: 8_000,
    task: { taskId: "task_1", goal: "x" },
    memories: [memory("mem_1", "用户偏好简洁报告"), memory("mem_2", "项目使用 PostgreSQL")],
  });
  const memorySection = compiled.sections.find((section) => section.name === "memory")!;
  assert.equal(memorySection.provenance.source, "memory");
  assert.deepEqual(memorySection.provenance.refs, ["mem_1", "mem_2"]);
  assert.match(memorySection.content, /用户偏好简洁报告/);
  assert.match(memorySection.content, /PostgreSQL/);
});

test("检索记忆进入上下文时保留相关度、置信度与时效，而非只塞正文", () => {
  const record = memory("mem_scored", "可复用分析步骤");
  const compiled = compileContext({
    modelWindowTokens: 8_000,
    task: { taskId: "task_1", goal: "x" },
    memoryHits: [{ record, relevance: 0.76, confidence: 0.88, freshness: { status: "aging", ageDays: 400 }, matchedTerms: ["分析"], retrievedAt: "2026-09-04T00:00:00.000Z" }],
  });
  const section = compiled.sections.find((item) => item.name === "memory")!;
  assert.match(section.content, /相关度 0\.76/);
  assert.match(section.content, /置信度 0\.88/);
  assert.match(section.content, /aging\/400天/);
});

test("空片段不产生 section；A2A 委托包进入编译结果", () => {
  const compiled = compileContext({
    modelWindowTokens: 8_000,
    task: { taskId: "task_1", goal: "x" },
    delegationBundle: { summary: "委托方摘要", constraints: ["只允许读"] },
  });
  assert.ok(!compiled.sections.some((section) => section.name === "conversation"));
  const a2a = compiled.sections.find((section) => section.name === "a2a-context-package")!;
  assert.equal(a2a.provenance.source, "a2a");
  assert.match(a2a.content, /委托方摘要/);
  assert.match(a2a.content, /只允许读/);
});

test("totalTokens 汇总与渲染", () => {
  const compiled = compileContext({
    modelWindowTokens: 8_000,
    systemPolicy: "policy",
    task: { taskId: "task_1", goal: "goal" },
  });
  assert.equal(compiled.totalTokens, compiled.sections.reduce((total, section) => total + section.tokens, 0));
  const rendered = renderCompiledContext(compiled);
  assert.match(rendered, /^## system-policy/);
  assert.match(rendered, /## task/);
});

test("estimateTokens 与默认预算 sanity", () => {
  assert.equal(estimateTokens("abcdefgh"), 4);
  assert.ok(DEFAULT_CONTEXT_BUDGET.system + DEFAULT_CONTEXT_BUDGET.task + DEFAULT_CONTEXT_BUDGET.conversation + DEFAULT_CONTEXT_BUDGET.memory + DEFAULT_CONTEXT_BUDGET.artifact + DEFAULT_CONTEXT_BUDGET.tool <= 1.0001);
});

test("同一预算桶内的多片段共享上限，不随插件数量放大", () => {
  const compiled = compileContext({
    modelWindowTokens: 10_000,
    systemPolicy: "policy".repeat(1_000),
    agentInstructions: "agent".repeat(1_000),
    pluginInstructions: Array.from({ length: 8 }, (_, index) => ({ pluginId: `p${index}`, instructions: "plugin".repeat(1_000) })),
    task: { taskId: "task_1", goal: "goal" },
  });
  const systemBucket = compiled.sections.filter((section) => ["system-policy", "agent-config"].includes(section.name) || section.name.startsWith("plugin:"));
  assert.ok(systemBucket.reduce((total, section) => total + section.budgetTokens, 0) <= 1_000);
  assert.ok(compiled.totalTokens <= compiled.modelWindowTokens);
});
