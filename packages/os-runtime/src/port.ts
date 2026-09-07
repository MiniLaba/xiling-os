// AgentRuntime 端口（指南 §2.8）：
// DeepSeek Harness 必须放在 Adapter Boundary 后面。OS 只依赖这套稳定接口，
// 未来 Harness API 再变，也只改适配器，不污染 OS Domain。
//
//   AI Native OS ──▶ AgentRuntimePort ──▶ DeepSeekHarnessRuntimeAdapter / ScriptedRuntimeAdapter / …

import type { AgentId, RunId, ActivationId, TaskId, SessionId } from "@xiling/os-domain";
import type { ArtifactType, ContextBundle, UIAction, UIComponentVersion, UILifecycle, UISurfaceKind } from "@xiling/os-domain";
import type { ArtifactRef } from "@xiling/os-domain";
import type { NativeInputModality, NativeOutputModality, ResolvedModelRoute } from "@xiling/os-domain";

export interface RuntimeToolDescriptor {
  name: string;
  description: string;
  inputSchema?: unknown;
}

export interface ActivationSpec {
  activationId: ActivationId;
  agentId: AgentId;
  systemInstructions?: string | undefined;
  tools: RuntimeToolDescriptor[];
}

export interface RunRequest {
  /** Host-owned executor; never serialized to the model or trusted by name alone. */
  executeTool?: ((name: string, input: unknown, callId: string) => Promise<unknown>) | undefined;
  /** 持久连续工作边界；旧无会话任务按 taskId 隔离。 */
  sessionId?: SessionId | undefined;
  runId: RunId;
  activationId: ActivationId;
  agentId: AgentId;
  taskId: TaskId;
  goal: string;
  modelRoute: ResolvedModelRoute;
  /** A2A 委托时由发送方显式构造的最小上下文包；本地发起时可为空 */
  contextBundle?: ContextBundle | undefined;
  inputArtifacts: ArtifactRef[];
  tools: RuntimeToolDescriptor[];
}

export interface RuntimeArtifactDraft {
  name: string;
  type: ArtifactType;
  mimeType: string;
  content: string;
  derivedFromArtifactIds?: string[] | undefined;
}

export interface RuntimeUiDraft {
  kind: UISurfaceKind;
  componentVersion?: UIComponentVersion | number | undefined;
  title?: string | undefined;
  data: unknown;
  actions: UIAction[];
  lifecycle?: UILifecycle | undefined;
}

/**
 * Runtime 事件 = Runtime truth（指南 §7）。
 * OS 事件 = Domain truth。内核把这一层翻译成 OS 事件流。
 */
export type RuntimeEvent =
  | { type: "run.started"; runId: RunId }
  | { type: "step.started"; runId: RunId; stepId: string }
  | { type: "model.requested"; runId: RunId; stepId: string; model?: string | undefined }
  | { type: "model.completed"; runId: RunId; stepId: string }
  | { type: "tool.requested"; runId: RunId; stepId: string; toolCallId: string; name: string; input: unknown }
  | { type: "tool.completed"; runId: RunId; stepId: string; toolCallId: string; output: unknown }
  | { type: "artifact.produced"; runId: RunId; artifact: RuntimeArtifactDraft }
  | { type: "approval.requested"; runId: RunId; action: string; resource: string; reason?: string | undefined }
  | { type: "ui.requested"; runId: RunId; surface: RuntimeUiDraft }
  | { type: "message"; runId: RunId; text: string }
  | { type: "run.completed"; runId: RunId; summary?: string | undefined }
  | { type: "run.failed"; runId: RunId; reason: string };

export interface AgentRuntime {
  readonly supportsHostTools?: boolean;
  readonly ownsSessionHistory?: boolean;
  readonly supportsCancellation?: boolean;
  readonly name: string;
  /** 适配器真正能送入/取回模型的原生模态；省略时保守视为仅文本。 */
  readonly nativeInputModalities?: readonly NativeInputModality[];
  readonly nativeOutputModalities?: readonly NativeOutputModality[];
  activate(spec: ActivationSpec): Promise<void>;
  run(request: RunRequest): AsyncIterable<RuntimeEvent>;
  interrupt(runId: RunId): Promise<void>;
  suspend(agentId: AgentId): Promise<void>;
  resume(agentId: AgentId): Promise<void>;
}
