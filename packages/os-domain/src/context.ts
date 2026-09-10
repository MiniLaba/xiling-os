import type { AgentId, RunId, TaskId } from "./ids.js";
import type { ModelAddress, ModelCapabilityDeclaration } from "./model.js";

/** 一次运行的上下文审计收据；只保存预算与来源，不复制原始上下文正文。 */
export interface ContextReceipt {
  id: string;
  runId: RunId;
  taskId: TaskId;
  agentId: AgentId;
  totalTokens: number;
  modelWindowTokens: number;
  model: ModelAddress;
  modelCapabilitySource: ModelCapabilityDeclaration["source"];
  nativeInputs: ModelCapabilityDeclaration["nativeInputs"];
  nativeOutputs: ModelCapabilityDeclaration["nativeOutputs"];
  sections: Array<{ name: string; tokens: number; budgetTokens: number; source: string; refs: string[] }>;
  activatedPluginIds: string[];
  toolNames: string[];
  createdAt: string;
}
