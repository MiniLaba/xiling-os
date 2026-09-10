// Agent 领域模型（指南 §5/§6）：
// AgentDefinition 是长期身份（数据实体），AgentActivation 才是类似进程的运行体。
// Agent 没有预设职业——能力组合（pluginBindings + grants）决定应用形态。

import type { AgentId, ActivationId, TaskId } from "./ids.js";
import type { ModelAddress } from "./model.js";

export type AgentState =
  | "starting"
  | "idle"
  | "running"
  | "waiting_user"
  | "waiting_agent"
  | "suspended"
  | "failed"
  | "stopped";

export interface ModelPolicy {
  /** 旧版字符串地址（`provider/model`）；保留用于事件重放兼容。 */
  primary?: string | undefined;
  /** 首选模型；允许 Main Agent 与每个 Worker 独立设置。 */
  preferred?: ModelAddress | undefined;
  fallbacks?: ModelAddress[] | undefined;
  allowedProviders?: string[] | undefined;
  maxCostPerRun?: number | undefined;
  /** 隐私区：禁止数据离开本机 */
  privacyZone?: boolean | undefined;
  /** 上下文窗口大小（tokens），Context Compiler 据此分配预算 */
  windowTokens?: number | undefined;
}

export interface PluginBinding {
  pluginId: string;
  version?: string | undefined;
  config?: Record<string, unknown> | undefined;
}

export interface MemoryPolicy {
  /** 只读记忆：禁止写入长期记忆 */
  readOnly?: boolean | undefined;
  retentionDays?: number | undefined;
}

export interface WorkspacePolicy {
  root?: string | undefined;
  mountsAllowed?: boolean | undefined;
}

export interface AgentPermissionPolicy {
  /** 该 Agent 可被授予的操作前缀（Capability Registry 的目录来源） */
  allowedActions: string[];
}

export interface AgentDefinition {
  id: AgentId;
  name: string;
  isMainAgent: boolean;
  modelPolicy: ModelPolicy;
  pluginBindings: PluginBinding[];
  memoryPolicy: MemoryPolicy;
  workspacePolicy: WorkspacePolicy;
  permissionPolicy: AgentPermissionPolicy;
  /** 运行引擎名称（内核据此解析 AgentRuntime 适配器） */
  runtimeName: string;
  systemInstructions?: string | undefined;
  createdAt: string;
  version: number;
}

export interface AgentActivation {
  activationId: ActivationId;
  agentId: AgentId;
  state: AgentState;
  hostId: string;
  activeSessionIds: string[];
  currentTaskIds: TaskId[];
  activatedAt: string;
}
