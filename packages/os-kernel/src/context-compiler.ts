// Context Compiler + Budget Manager（指南 §38/§39）：
// Agent 每一轮真正看到的上下文由这里构造，而不是 history.slice(-N)。
// 每个片段带预算上限与 provenance（哪个 token 来自什么 source——调试 AI 系统比 log 更重要）。
// 纯函数：确定性、可测试；token 估算用保守的字符近似（模型窗口实际值由调用方传入）。

import type { ContextBundle, MemoryRecord, MemorySearchHit } from "@xiling/os-domain";

/** 预算比例（指南 §39 示例；按模型窗口动态缩放） */
export interface ContextBudget {
  system: number;
  task: number;
  conversation: number;
  memory: number;
  artifact: number;
  tool: number;
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  system: 0.10,
  task: 0.15,
  conversation: 0.25,
  memory: 0.20,
  artifact: 0.20,
  tool: 0.10,
};

export interface ContextSectionProvenance {
  source: "system-policy" | "agent-config" | "plugin" | "task" | "conversation" | "memory" | "artifact" | "a2a" | "tool-runtime";
  /** 具体来源标识（记忆记录 ID / 产物 ID / 委托 ID…） */
  refs: string[];
}

export interface CompiledContextSection {
  name: string;
  content: string;
  /** 预算上限（tokens） */
  budgetTokens: number;
  /** 估算实际占用（tokens，字符近似） */
  tokens: number;
  provenance: ContextSectionProvenance;
}

export interface CompiledContext {
  sections: CompiledContextSection[];
  totalTokens: number;
  modelWindowTokens: number;
}

export interface CompileContextInput {
  modelWindowTokens: number;
  budget?: ContextBudget | undefined;
  systemPolicy?: string | undefined;
  agentInstructions?: string | undefined;
  pluginInstructions?: Array<{ pluginId: string; instructions: string }> | undefined;
  task: { taskId: string; goal: string; constraints?: string[] | undefined; submittedInputs?: Array<{ id: string; payload: unknown }> | undefined };
  recentConversation?: string[] | undefined;
  memories?: MemoryRecord[] | undefined;
  memoryHits?: MemorySearchHit[] | undefined;
  artifacts?: Array<{ artifactId: string; name: string; summary: string }> | undefined;
  /** A2A 委托方显式构造的最小信息包——原样入栈并标注来源（§38） */
  delegationBundle?: ContextBundle | undefined;
  toolRuntime?: string[] | undefined;
}

/** 保守 token 近似：CJK 约 1 token/字，拉丁约 1 token/4 字符；这里统一按 1 token/2 字符估。 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2);
}

function truncateToTokens(text: string, budgetTokens: number): { content: string; tokens: number; truncated: boolean } {
  const maxChars = Math.max(0, budgetTokens * 2);
  if (text.length <= maxChars) return { content: text, tokens: estimateTokens(text), truncated: false };
  const clipped = text.slice(0, maxChars);
  return { content: `${clipped}\n[已按上下文预算截断]`, tokens: estimateTokens(clipped), truncated: true };
}

/**
 * 编译一次运行上下文：每个片段按预算裁剪，全部携带 provenance。
 * 预算内装不下就截断并标注——绝不静默丢弃整段（§39 的确定性策略）。
 */
export function compileContext(input: CompileContextInput): CompiledContext {
  const budget = input.budget ?? DEFAULT_CONTEXT_BUDGET;
  const cap = (fraction: number) => Math.floor(input.modelWindowTokens * fraction);
  const sections: CompiledContextSection[] = [];

  type Draft = { name: string; source: ContextSectionProvenance["source"]; refs: string[]; content?: string | undefined };
  const pushBucket = (fraction: number, drafts: Draft[]): void => {
    const present = drafts.filter((draft): draft is Draft & { content: string } => draft.content !== undefined && draft.content.trim() !== "");
    if (present.length === 0) return;
    const bucketTokens = cap(fraction);
    const perSection = Math.floor(bucketTokens / present.length);
    let remainder = bucketTokens - perSection * present.length;
    for (const draft of present) {
      const budgetTokens = perSection + (remainder > 0 ? 1 : 0);
      remainder = Math.max(0, remainder - 1);
      const clipped = truncateToTokens(draft.content, budgetTokens);
      sections.push({
        name: draft.name,
        content: clipped.content,
        budgetTokens,
        tokens: clipped.tokens,
        provenance: { source: draft.source, refs: draft.refs },
      });
    }
  };

  pushBucket(budget.system, [
    { name: "system-policy", source: "system-policy", refs: [], content: input.systemPolicy },
    { name: "agent-config", source: "agent-config", refs: [], content: input.agentInstructions },
    ...(input.pluginInstructions ?? []).map((plugin): Draft => ({ name: `plugin:${plugin.pluginId}`, source: "plugin", refs: [plugin.pluginId], content: plugin.instructions })),
  ]);

  const taskDrafts: Draft[] = [{
    name: "task",
    source: "task",
    refs: [input.task.taskId],
    content: [
      `目标：${input.task.goal}`,
      ...(input.task.constraints ?? []).map((constraint) => `约束：${constraint}`),
      ...(input.task.submittedInputs ?? []).map((item) => `用户补充输入 [${item.id}]：${JSON.stringify(item.payload)}`),
    ].join("\n"),
  }];
  if (input.delegationBundle !== undefined) {
    const bundle = input.delegationBundle;
    const parts: string[] = [];
    if (bundle.summary !== undefined) parts.push(`委托方摘要：${bundle.summary}`);
    for (const fact of bundle.facts ?? []) parts.push(`事实 ${fact.key}: ${String(fact.value)}`);
    for (const constraint of bundle.constraints ?? []) parts.push(`委托约束：${constraint}`);
    taskDrafts.push({ name: "a2a-context-package", source: "a2a", refs: [], content: parts.join("\n") });
  }
  pushBucket(budget.task, taskDrafts);
  pushBucket(budget.conversation, [{ name: "conversation", source: "conversation", refs: [], content: (input.recentConversation ?? []).join("\n") }]);
  const memoryHits = input.memoryHits ?? (input.memories ?? []).map((record): MemorySearchHit => ({
    record, relevance: 0.5, confidence: record.confidence ?? 0.5,
    freshness: { status: "current", ageDays: 0, expiresAt: record.expiresAt }, matchedTerms: [], retrievedAt: new Date(0).toISOString(),
  }));
  pushBucket(budget.memory, [{
    name: "memory", source: "memory", refs: memoryHits.map((hit) => hit.record.id),
    content: memoryHits.map((hit) => `[${hit.record.type}] ${JSON.stringify(hit.record.content)}（相关度 ${hit.relevance.toFixed(2)}；置信度 ${hit.confidence.toFixed(2)}；时效 ${hit.freshness.status}/${hit.freshness.ageDays}天；来源 ${hit.record.provenance.origin}${hit.record.provenance.sourceTaskId ? ` task:${hit.record.provenance.sourceTaskId}` : ""}${hit.record.provenance.sourceArtifactId ? ` artifact:${hit.record.provenance.sourceArtifactId}` : ""}）`).join("\n"),
  }]);
  pushBucket(budget.artifact, [{
    name: "artifact", source: "artifact", refs: (input.artifacts ?? []).map((artifact) => artifact.artifactId),
    content: (input.artifacts ?? []).map((artifact) => `「${artifact.name}」摘要：${artifact.summary}`).join("\n"),
  }]);
  pushBucket(budget.tool, [{ name: "tool-runtime", source: "tool-runtime", refs: [], content: (input.toolRuntime ?? []).join("\n") }]);

  return {
    sections,
    totalTokens: sections.reduce((total, section) => total + section.tokens, 0),
    modelWindowTokens: input.modelWindowTokens,
  };
}

/** 渲染为投递给 Runtime 的单段文本（Runtime 自身还会套 system prompt，§7）。 */
export function renderCompiledContext(context: CompiledContext): string {
  return context.sections.map((section) => `## ${section.name}\n${section.content}`).join("\n\n");
}
