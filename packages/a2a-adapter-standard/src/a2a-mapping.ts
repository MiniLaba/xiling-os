// 外部 A2A 标准适配器（指南 §12）：
// 内部 A2A 领域模型 ↔ 公开 A2A Protocol 1.0.0 wire 模型的纯映射。
// 原则：内部协议不绑定外部标准；OS 特有的 Capability Grant / Workspace Mount /
// Credential Delegation / Memory Export 永远保留为内部 Extension，不进 wire。

import type {
  A2AStatusEvent, AgentDefinition, ContextBundle, DelegationRequest, TaskState,
} from "@xiling/os-domain";
import type { Task as DomainTask } from "@xiling/os-domain";

// ---------- A2A Protocol 1.0.0 wire 模型（公开标准的稳定子集） ----------

export interface A2APart {
  kind: "text" | "data" | "file";
  text?: string | undefined;
  data?: unknown;
  /** file part：mimeType + (uri | bytes) */
  mimeType?: string | undefined;
  uri?: string | undefined;
}

export interface A2AArtifact {
  artifactId: string;
  name?: string | undefined;
  description?: string | undefined;
  parts: A2APart[];
}

export type A2ATaskState =
  | "submitted"
  | "working"
  | "input-required"
  | "completed"
  | "failed"
  | "canceled";

export interface A2ATask {
  id: string;
  contextId?: string | undefined;
  status: {
    state: A2ATaskState;
    message?: A2AMessage | undefined;
  };
  artifacts?: A2AArtifact[] | undefined;
  /** 内部关联（不进标准字段，便于回程对账） */
  metadata?: Record<string, unknown> | undefined;
}

export interface A2AMessage {
  role: "agent" | "user";
  parts: A2APart[];
  metadata?: Record<string, unknown> | undefined;
}

export interface A2AAgentSkill {
  id: string;
  name: string;
  description?: string | undefined;
  tags?: string[] | undefined;
}

/** AgentCard：外部世界发现本 Agent 的名片 */
export interface A2AAgentCard {
  name: string;
  description?: string | undefined;
  url?: string | undefined;
  version: string;
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
  };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: A2AAgentSkill[];
}

// ---------- 内部 → 标准 ----------

const STATE_MAP: Record<TaskState, A2ATaskState> = {
  created: "submitted",
  queued: "submitted",
  running: "working",
  waiting_input: "input-required",
  waiting_approval: "working",
  waiting_dependency: "submitted",
  completed: "completed",
  failed: "failed",
  cancelled: "canceled",
};

export function toA2ATaskState(state: TaskState): A2ATaskState {
  return STATE_MAP[state];
}

/** ContextBundle → 一条 agent 消息（summary/facts/constraints 都成为带溯源的 part） */
export function bundleToA2AMessage(bundle: ContextBundle): A2AMessage {
  const parts: A2APart[] = [];
  if (bundle.summary !== undefined) {
    parts.push({ kind: "text", text: bundle.summary });
  }
  for (const fact of bundle.facts ?? []) {
    parts.push({ kind: "data", data: { key: fact.key, value: fact.value, sourceRef: fact.sourceRef } });
  }
  if (bundle.constraints !== undefined && bundle.constraints.length > 0) {
    parts.push({ kind: "text", text: `约束：${bundle.constraints.join("；")}` });
  }
  return { role: "agent", parts };
}

/** 内部 DelegationRequest + Task 状态 → 标准 A2A Task */
export function toA2ATask(delegation: DelegationRequest, task: DomainTask, status?: A2AStatusEvent | undefined): A2ATask {
  const message = bundleToA2AMessage(delegation.context);
  const artifacts: A2AArtifact[] = task.outputArtifacts.map((ref) => ({
    artifactId: ref.artifactId,
    name: `artifact-${ref.artifactId}`,
    parts: [{ kind: "data", data: { artifactId: ref.artifactId, version: ref.version, uri: `artifact://${ref.artifactId}/version/${ref.version}` } }],
  }));
  return {
    id: task.id,
    contextId: delegation.delegationId,
    status: {
      state: toA2ATaskState(task.state),
      message: status?.reason !== undefined ? { role: "agent", parts: [{ kind: "text", text: status.reason }] } : message,
    },
    artifacts: artifacts.length > 0 ? artifacts : undefined,
    metadata: {
      fromAgentId: delegation.fromAgentId,
      toAgentId: delegation.toAgentId,
      /** OS Extension 永不进标准字段：只放在 metadata，外部对端可忽略 */
      capabilityGrantIds: delegation.capabilityGrantIds,
    },
  };
}

/** AgentDefinition → 对外 AgentCard（skills 来自能力目录：permissionPolicy.allowedActions + 插件） */
export function toAgentCard(definition: AgentDefinition, options: { url?: string | undefined } = {}): A2AAgentCard {
  return {
    name: definition.name,
    description: definition.systemInstructions !== undefined ? definition.systemInstructions.slice(0, 200) : undefined,
    url: options.url,
    version: String(definition.version),
    capabilities: { streaming: true, pushNotifications: false },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain", "application/json"],
    skills: definition.permissionPolicy.allowedActions.map((action) => ({
      id: action,
      name: action,
      tags: definition.pluginBindings.map((binding) => binding.pluginId),
    })),
  };
}

// ---------- 标准 → 内部（入站最小映射） ----------

/** 标准 A2A Task 状态 → 内部回执状态（reportStatus 可消费的形态） */
export function fromA2ATaskState(state: A2ATaskState): "accepted" | "completed" | "failed" | "cancelled" | "pending" {
  switch (state) {
    case "submitted":
    case "working":
      return "accepted";
    case "input-required":
      return "pending";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "canceled":
      return "cancelled";
  }
}

/** 标准 message → 内部 ContextBundle（最小信息包语义与内部一致） */
export function a2aMessageToBundle(message: A2AMessage): ContextBundle {
  const bundle: ContextBundle = {};
  const facts: NonNullable<ContextBundle["facts"]> = [];
  const constraints: string[] = [];
  for (const part of message.parts) {
    if (part.kind === "text" && part.text !== undefined) {
      if (part.text.startsWith("约束：")) constraints.push(part.text.slice(3));
      else if (bundle.summary === undefined) bundle.summary = part.text;
    }
    if (part.kind === "data") {
      const data = part.data as { key?: unknown; value?: unknown; sourceRef?: unknown } | undefined;
      if (data !== null && typeof data === "object" && typeof data.key === "string") {
        facts.push({
          key: data.key,
          value: data.value,
          sourceRef: typeof data.sourceRef === "string" ? data.sourceRef : undefined,
        });
      }
    }
  }
  if (facts.length > 0) bundle.facts = facts;
  if (constraints.length > 0) bundle.constraints = constraints;
  return bundle;
}
