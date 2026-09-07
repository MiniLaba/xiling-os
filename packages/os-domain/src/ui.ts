// Generative UI 领域模型（指南 §28/§29/§31/§32）：
// Declarative UI Model，而不是任意前端代码。Renderer 决定如何显示，
// 前端只能发回 actionId + typed input，且 action 必须重新经过命令总线与权限系统。

import type { AgentId, TaskId, UiSurfaceId } from "./ids.js";

export type UISurfaceKind =
  | "table"
  | "form"
  | "approval"
  | "comparison"
  | "diff"
  | "chart"
  | "artifact"
  | "task_board"
  | "custom";

/** Renderer 与 Kernel 共同支持的声明式组件协议版本。 */
export const UI_COMPONENT_VERSION = 1 as const;
export type UIComponentVersion = typeof UI_COMPONENT_VERSION;

/** UI 可以触发的 OS 命令是封闭枚举（§29）——不存在"执行 Model 任意 JavaScript" */
export type UICommand =
  | "task.submit_input"
  | "task.approve"
  | "task.reject"
  | "artifact.select"
  | "tool.confirm"
  | "agent.message";

export const UI_COMMANDS: readonly UICommand[] = [
  "task.submit_input",
  "task.approve",
  "task.reject",
  "artifact.select",
  "tool.confirm",
  "agent.message",
];

export function isUICommand(value: string): value is UICommand {
  return (UI_COMMANDS as readonly string[]).includes(value);
}

export interface UIAction {
  id: string;
  label: string;
  command: UICommand;
  /** 描述 action 的输入形状（JSON Schema 片段），供 Renderer 校验 typed input */
  inputSchema?: unknown;
}

export type UILifecycle = "ephemeral" | "task" | "persistent";

export interface UISurface {
  id: UiSurfaceId;
  taskId?: TaskId | undefined;
  agentId: AgentId;
  kind: UISurfaceKind;
  componentVersion: UIComponentVersion;
  title?: string | undefined;
  data: unknown;
  actions: UIAction[];
  lifecycle: UILifecycle;
  createdAt: string;
  closedAt?: string | undefined;
}
