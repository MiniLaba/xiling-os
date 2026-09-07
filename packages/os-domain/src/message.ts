import type { AgentId, RunId, TaskId } from "./ids.js";

/** 面向人的对话投影；Harness 的逐步轨迹仍由 Runtime 自己保存。 */
export interface AgentMessage {
  id: string;
  taskId: TaskId;
  runId: RunId;
  agentId: AgentId;
  role: "assistant" | "system";
  text: string;
  createdAt: string;
}
