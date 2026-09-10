import type { AppManifest, DesktopPreferences, DesktopWindowState, WorkspaceEntry, WorkspacePage, WorkspacePreview } from "./types.js";

export interface CoreRequest {
  type: "core-request";
  id: string;
  method: CoreMethod;
  params: unknown;
}

export interface CoreResponse {
  type: "core-response";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface CoreEvent {
  type: "core-event";
  topic: "workspace.changed" | "os.changed";
  payload: { rootId: string } | { seq: number; eventType: string };
}

export type CoreMethod =
  | "research.knowledge"
  | "os.voice"
  | "os.apps.manage"
  | "system.ping"
  | "apps.list"
  | "workspace.get"
  | "workspace.set"
  | "workspace.list"
  | "workspace.page"
  | "workspace.search"
  | "workspace.mkdir"
  | "workspace.rename"
  | "workspace.move"
  | "workspace.preview"
  | "workspace.import"
  | "workspace.resolve"
  | "workspace.resolveWrite"
  | "windows.list"
  | "windows.save"
  | "preferences.get"
  | "preferences.set"
  | "os.status"
  | "os.snapshot"
  | "os.goal.submit"
  | "os.science.plan"
  | "os.science.approval.request"
  | "os.science.execute"
  | "os.task.cancel"
  | "os.task.retry"
  | "os.task.priority.set"
  | "os.artifact.get"
  | "os.artifact.saveAnswer"
  | "os.memory.manage"
  | "os.runtime.enable"
  | "os.artifact.import"
  | "os.approval.decide"
  | "os.ui.action"
  | "os.models.list"
  | "os.models.register"
  | "os.agent.model.set"
  | "os.credentials.list"
  | "os.credentials.set"
  | "os.credentials.clear"
  | "os.credentials.test"
  | "network.authorize";

export interface OsTaskView {
  canCancelRunning?: boolean;
  id: string;
  goal: string;
  state: string;
  statusReason?: string;
  retryOfTaskId?: string;
  parentTaskId?: string;
  assignedAgentId?: string;
  assignedAgentName?: string;
  delegationState?: string;
  outputArtifacts: Array<{ artifactId: string; version: number }>;
  createdAt: string;
  completedAt?: string;
  priority?: number;
  activatedPluginIds?: string[];
  contextTokens?: number;
  model?: { providerId: string; modelId: string; capabilitySource: string };
}

export interface OsSnapshot {
  mainAgentId?: string;
  runtimeName?: string;
  preferredModel?: { providerId: string; modelId: string };
  tasks: OsTaskView[];
  messages: Array<{ id: string; taskId: string; role: string; text: string; createdAt: string }>;
  approvals: Array<{ approvalId: string; taskId: string; action: string; resource: string; reason?: string; state: string; createdAt: string }>;
  surfaces: Array<{ id: string; taskId?: string; kind: string; componentVersion: number; title?: string; data: unknown; actions: Array<{ id: string; label: string; command: string; inputSchema?: unknown }> }>;
  artifacts: Array<{ artifactId: string; taskId?: string; name: string; type: string; mimeType: string; version: number; storageRef: string }>;
}

export interface OsArtifactDetail {
  artifactId: string; taskId?: string; name: string; type: string; mimeType: string; version: number;
  storageRef: string; createdAt: string; content: string; truncated: boolean;
  lineage: Array<{ artifactId: string; version: number; name: string; type: string }>;
}

export interface OsModelView {
  providerId: string;
  modelId: string;
  displayName?: string;
  nativeInputs: Array<"text" | "image" | "audio" | "video">;
  nativeOutputs: Array<"text" | "image">;
  contextWindowTokens: number;
  supportsToolUse: boolean;
  reasoning: boolean;
  source: string;
  verifiedAt?: string;
}

export interface OsAgentModelView {
  agentId: string;
  name: string;
  main: boolean;
  preferred?: { providerId: string; modelId: string };
}

export interface CredentialFieldView { id: string; label: string; secret: boolean; placeholder: string }
export interface CredentialProviderView {
  id: string; title: string; description: string; configured: boolean;
  source: "environment" | "local" | "none"; configuredFields: string[]; fields: CredentialFieldView[];
}
export interface ModelConnectionTestView {
  ok: boolean; providerId: string; modelId: string; latencyMs: number; message: string; testedAt: string;
}

export interface SafeWorkspaceRoot {
  id: string;
  label: string;
}

export interface CoreResultMap {
  "research.knowledge": import("./research-types.js").ResearchKnowledgeResult;
  "os.voice": import("./voice-types.js").VoiceResult;
  "os.apps.manage": unknown;
  "system.ping": { schemaVersion: number };
  "apps.list": AppManifest[];
  "workspace.get": SafeWorkspaceRoot | null;
  "workspace.set": SafeWorkspaceRoot;
  "workspace.list": WorkspaceEntry[];
  "workspace.page": WorkspacePage;
  "workspace.search": WorkspaceEntry[];
  "workspace.mkdir": WorkspaceEntry;
  "workspace.rename": WorkspaceEntry;
  "workspace.move": WorkspaceEntry;
  "workspace.preview": WorkspacePreview;
  "workspace.import": WorkspaceEntry[];
  "workspace.resolve": { nativePath: string };
  "workspace.resolveWrite": { nativePath: string };
  "windows.list": DesktopWindowState[];
  "windows.save": { saved: true };
  "preferences.get": DesktopPreferences;
  "preferences.set": DesktopPreferences;
  "os.status": {
    ok: boolean;
    mainAgentId?: string;
    agents: number;
    tasks: number;
    artifacts: number;
    eventsReplayed: number;
    error?: string;
  };
  "os.snapshot": OsSnapshot;
  "os.goal.submit": { task: OsTaskView };
  /** 计划登记：返回用户可见任务与计划哈希；不执行计算。 */
  "os.science.plan": { task: OsTaskView; planHash: string; replayed: boolean };
  /** 请求执行审批：资源是计划哈希，计划改动即失效。 */
  "os.science.approval.request": { approvalId: string; state: string; taskId: string };
  /** 沙箱执行：返回执行摘要（含适配器、产物、失败原因）。 */
  "os.science.execute": {
    taskId: string;
    executionId: string;
    projectId: string;
    planHash: string;
    adapterId: string;
    status: "cancelled" | "succeeded" | "failed";
    artifacts: Array<{ artifactId: string; version: number }>;
    error?: string | undefined;
  };
  "os.task.cancel": { task: OsTaskView };
  "os.task.retry": { task: OsTaskView };
  "os.task.priority.set": { task: OsTaskView };
  "os.artifact.get": { artifact: OsArtifactDetail };
  "os.artifact.saveAnswer": { artifactId: string };
  "os.runtime.enable": { runtimeName: string };
  "os.artifact.import": { artifactId: string };
  "os.memory.manage": { records: Array<{ id: string; agentId: string; content: unknown; createdAt: string; provenance: unknown }> };
  "os.approval.decide": { approvalId: string; state: string; taskId: string };
  "os.ui.action": { surfaceId: string; actionId: string; command: string; accepted: true; result?: unknown };
  "os.models.list": { models: OsModelView[]; agents: OsAgentModelView[] };
  "os.models.register": { model: OsModelView };
  "os.agent.model.set": { agent: OsAgentModelView };
  "os.credentials.list": { providers: CredentialProviderView[] };
  "os.credentials.set": { provider: CredentialProviderView };
  "os.credentials.clear": { provider: CredentialProviderView };
  "os.credentials.test": ModelConnectionTestView;
  "network.authorize": { authorized: true };
}
