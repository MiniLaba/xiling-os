// ProjectionEngine（指南 §2.6/§44）：
// OS 投影只从事件流派生，绝不做绕过事件的可变写。重启恢复 = replay(events)。
// 这是 Replay / Crash Recovery 不变量的机制保证。

import type {
  ActivationId, AgentId, AgentActivation, AgentDefinition, A2AInboxEntry, ApprovalId, ApprovalRequest,
  Artifact, CapabilityGrant, DelegationId, GrantId, MemoryRecord, MemoryRecordId,
  Task, TaskId, UISurface, Workspace, WorkspaceMount,
  AgentMessage,
  AgentSession,
  ContextReceipt,
  PluginInstallation,
  ModelCapabilityDeclaration,
  AppInstance,
} from "@xiling/os-domain";
import type { OSEvent } from "@xiling/os-domain";

export interface OSProjection {
  apps: Map<string, AppInstance>;
  agents: Map<AgentId, AgentDefinition>;
  sessions: Map<string, AgentSession>;
  activations: Map<ActivationId, AgentActivation>;
  tasks: Map<TaskId, Task>;
  artifacts: Map<string, Artifact>;
  memories: Map<MemoryRecordId, MemoryRecord>;
  grants: Map<GrantId, CapabilityGrant>;
  workspaces: Map<string, Workspace>;
  mounts: WorkspaceMount[];
  inbox: Map<DelegationId, A2AInboxEntry>;
  approvals: Map<ApprovalId, ApprovalRequest>;
  surfaces: Map<string, UISurface>;
  messages: AgentMessage[];
  contextReceipts: Map<string, ContextReceipt>;
  pluginInstallations: Map<string, PluginInstallation>;
  modelDeclarations: Map<string, ModelCapabilityDeclaration>;
  /** 幂等索引：已执行过的外部副作用 key（指南 §45） */
  executedSideEffects: Set<string>;
}

export function emptyProjection(): OSProjection {
  return {
    apps: new Map(),
    agents: new Map(),
    sessions: new Map(),
    activations: new Map(),
    tasks: new Map(),
    artifacts: new Map(),
    memories: new Map(),
    grants: new Map(),
    workspaces: new Map(),
    mounts: [],
    inbox: new Map(),
    approvals: new Map(),
    surfaces: new Map(),
    messages: [],
    contextReceipts: new Map(),
    pluginInstallations: new Map(),
    modelDeclarations: new Map(),
    executedSideEffects: new Set(),
  };
}

/** 纯函数投影：同一事件序列永远得到同一状态（Replay 不变量）。 */
export function applyEvent(state: OSProjection, event: OSEvent): OSProjection {
  switch (event.type) {
    case "app.installed":
    case "app.upgraded": {
      state.apps.set(event.payload.instance.id, structuredClone(event.payload.instance));
      state.agents.set(event.payload.agent.id, structuredClone(event.payload.agent));
      if (event.type === "app.upgraded") {
        for (const activation of state.activations.values()) {
          if (activation.agentId === event.payload.agent.id) activation.state = "stopped";
        }
      }
      break;
    }
    case "app.updated": {
      state.apps.set(event.payload.instance.id, structuredClone(event.payload.instance));
      break;
    }
    case "agent.created": {
      const { definition } = event.payload;
      state.agents.set(definition.id, definition);
      break;
    }
    case "agent.runtime_updated": {
      const definition = state.agents.get(event.payload.agentId);
      if (definition) { definition.runtimeName = event.payload.runtimeName; definition.version++; }
      for (const activation of state.activations.values()) if (activation.agentId === event.payload.agentId) activation.state = "stopped";
      break;
    }
    case "agent.activated": {
      const { activation } = event.payload;
      state.activations.set(activation.activationId, { ...activation });
      break;
    }
    case "agent.state_changed": {
      const { activationId, state: agentState } = event.payload;
      const activation = state.activations.get(activationId);
      if (activation) activation.state = agentState;
      break;
    }
    case "agent.model_policy_updated": {
      const definition = state.agents.get(event.payload.agentId);
      if (definition) {
        definition.modelPolicy = structuredClone(event.payload.modelPolicy);
        definition.version += 1;
      }
      break;
    }
    case "agent.plugin_bound": {
      const { agentId, binding } = event.payload;
      const definition = state.agents.get(agentId);
      if (definition) {
        definition.pluginBindings = [...definition.pluginBindings.filter((existing) => existing.pluginId !== binding.pluginId), structuredClone(binding)];
      }
      break;
    }
    case "agent.plugin_unbound": {
      const { agentId, pluginId } = event.payload;
      const definition = state.agents.get(agentId);
      if (definition) {
        definition.pluginBindings = definition.pluginBindings.filter((existing) => existing.pluginId !== pluginId);
      }
      break;
    }
    case "agent.message": {
      state.messages.push(structuredClone(event.payload.message));
      break;
    }
    case "session.opened": {
      const { session } = event.payload;
      state.sessions.set(session.id, structuredClone(session));
      break;
    }
    case "session.closed": {
      const session = state.sessions.get(event.payload.sessionId);
      if (session) {
        session.state = event.payload.state;
        session.lastActiveAt = event.occurredAt;
        session.endedAt = event.occurredAt;
      }
      break;
    }
    case "context.compiled": {
      state.contextReceipts.set(event.payload.receipt.runId, structuredClone(event.payload.receipt));
      break;
    }
    case "model.registered": {
      const declaration = structuredClone(event.payload.declaration);
      state.modelDeclarations.set(`${declaration.address.providerId}/${declaration.address.modelId}`, declaration);
      break;
    }
    case "model.removed": {
      state.modelDeclarations.delete(`${event.payload.address.providerId}/${event.payload.address.modelId}`);
      break;
    }
    case "plugin.installed": {
      state.pluginInstallations.set(event.payload.installation.pluginId, structuredClone(event.payload.installation));
      break;
    }
    case "plugin.enabled": {
      const installation = state.pluginInstallations.get(event.payload.pluginId);
      if (installation) {
        installation.state = "enabled";
        installation.updatedAt = event.occurredAt;
        installation.lastError = undefined;
      }
      break;
    }
    case "plugin.disabled": {
      const installation = state.pluginInstallations.get(event.payload.pluginId);
      if (installation) {
        installation.state = "disabled";
        installation.updatedAt = event.occurredAt;
      }
      break;
    }
    case "plugin.upgraded": {
      const installation = state.pluginInstallations.get(event.payload.pluginId);
      if (installation) {
        installation.history.push(structuredClone(installation.manifest));
        installation.manifest = structuredClone(event.payload.manifest);
        installation.updatedAt = event.occurredAt;
        installation.lastError = undefined;
      }
      break;
    }
    case "plugin.rolled_back": {
      const installation = state.pluginInstallations.get(event.payload.pluginId);
      if (installation) {
        installation.manifest = structuredClone(event.payload.manifest);
        installation.history = installation.history.slice(0, -1);
        installation.updatedAt = event.occurredAt;
        installation.lastError = undefined;
      }
      break;
    }
    case "plugin.operation_failed": {
      const installation = state.pluginInstallations.get(event.payload.pluginId);
      if (installation) installation.lastError = { operation: event.payload.operation, reason: event.payload.reason, at: event.occurredAt };
      break;
    }
    case "plugin.removed": {
      state.pluginInstallations.delete(event.payload.pluginId);
      break;
    }
    case "task.created": {
      const { task } = event.payload;
      state.tasks.set(task.id, structuredClone(task));
      if (task.sessionId !== undefined) {
        const session = state.sessions.get(task.sessionId);
        if (session && !session.taskIds.includes(task.id)) {
          session.taskIds.push(task.id);
          session.lastActiveAt = event.occurredAt;
        }
      }
      break;
    }
    case "task.assigned": {
      const { taskId, assignedAgentId } = event.payload;
      const task = state.tasks.get(taskId);
      if (task) task.assignedAgentId = assignedAgentId;
      break;
    }
    case "task.started": {
      const { taskId } = event.payload;
      setTaskState(state, taskId, "running");
      const task = state.tasks.get(taskId);
      if (task) task.statusReason = undefined;
      break;
    }
    case "task.requeued": {
      const { taskId } = event.payload;
      setTaskState(state, taskId, "queued");
      const task = state.tasks.get(taskId);
      if (task) task.statusReason = event.payload.reason;
      break;
    }
    case "task.waiting_input": {
      const { taskId } = event.payload;
      setTaskState(state, taskId, "waiting_input");
      const task = state.tasks.get(taskId);
      if (task) task.statusReason = event.payload.reason;
      break;
    }
    case "task.waiting_dependency": {
      const { taskId, dependsOnTaskIds } = event.payload;
      const task = state.tasks.get(taskId);
      if (task) task.dependsOnTaskIds = [...new Set([...task.dependsOnTaskIds, ...dependsOnTaskIds])];
      setTaskState(state, taskId, "waiting_dependency");
      if (task) task.statusReason = `等待 ${dependsOnTaskIds.length} 个依赖任务`;
      break;
    }
    case "task.waiting_approval": {
      const { taskId } = event.payload;
      setTaskState(state, taskId, "waiting_approval");
      const task = state.tasks.get(taskId);
      if (task) task.statusReason = "等待用户确认";
      break;
    }
    case "task.artifact_added": {
      const { taskId, artifactId, version } = event.payload;
      const task = state.tasks.get(taskId);
      if (task) {
        task.outputArtifacts = [...task.outputArtifacts, { artifactId, version }];
      }
      break;
    }
    case "task.input_submitted": {
      const task = state.tasks.get(event.payload.taskId);
      if (task) task.submittedInputs = [...(task.submittedInputs ?? []), structuredClone(event.payload.input)];
      break;
    }
    case "task.priority_changed": {
      const task = state.tasks.get(event.payload.taskId);
      if (task) task.constraints.priority = event.payload.priority;
      break;
    }
    case "task.completed": {
      const { taskId } = event.payload;
      const task = state.tasks.get(taskId);
      if (task) {
        task.state = "completed";
        task.completedAt = event.occurredAt;
        task.statusReason = undefined;
      }
      break;
    }
    case "task.failed": {
      const { taskId } = event.payload;
      const task = state.tasks.get(taskId);
      if (task) { task.state = "failed"; task.statusReason = event.payload.reason; }
      break;
    }
    case "task.cancelled": {
      const { taskId } = event.payload;
      const task = state.tasks.get(taskId);
      if (task) { task.state = "cancelled"; task.statusReason = event.payload.reason; }
      break;
    }
    case "artifact.created":
    case "artifact.version_added": {
      const { artifact } = event.payload;
      state.artifacts.set(artifact.artifactId, structuredClone(artifact));
      break;
    }
    case "memory.created": {
      const { record } = event.payload;
      state.memories.set(record.id, structuredClone(record));
      break;
    }
    case "memory.superseded": {
      const { supersededId, byId } = event.payload;
      const superseded = state.memories.get(supersededId);
      if (superseded) superseded.supersededBy = byId;
      break;
    }
    case "memory.deleted": {
      const { recordId } = event.payload;
      state.memories.delete(recordId);
      break;
    }
    case "capability.granted": {
      const { grant } = event.payload;
      state.grants.set(grant.id, structuredClone(grant));
      break;
    }
    case "capability.revoked": {
      const { grantId } = event.payload;
      state.grants.delete(grantId);
      break;
    }
    case "workspace.created": {
      const { workspace } = event.payload;
      state.workspaces.set(workspace.workspaceId, structuredClone(workspace));
      break;
    }
    case "workspace.mounted": {
      const { mount } = event.payload;
      state.mounts.push(structuredClone(mount));
      break;
    }
    case "approval.requested": {
      const { request } = event.payload;
      state.approvals.set(request.approvalId, structuredClone(request));
      break;
    }
    case "approval.decided": {
      const { approvalId, decision, decidedBy } = event.payload;
      const request = state.approvals.get(approvalId);
      if (request) {
        request.state = decision;
        request.decidedAt = event.occurredAt;
        request.decidedBy = decidedBy;
      }
      break;
    }
    case "a2a.delegated": {
      const { delegation } = event.payload;
      state.inbox.set(delegation.delegationId, {
        delegationId: delegation.delegationId,
        taskId: delegation.taskId,
        fromAgentId: delegation.fromAgentId,
        toAgentId: delegation.toAgentId,
        state: "pending",
        receivedAt: event.occurredAt,
        delegation: structuredClone(delegation),
      });
      break;
    }
    case "a2a.status": {
      const { status } = event.payload;
      const entry = state.inbox.get(status.delegationId);
      if (entry) entry.state = status.state;
      break;
    }
    case "ui.presented": {
      const { surface } = event.payload;
      state.surfaces.set(surface.id, structuredClone(surface));
      break;
    }
    case "ui.closed": {
      const { surfaceId } = event.payload;
      const surface = state.surfaces.get(surfaceId);
      if (surface) surface.closedAt = event.occurredAt;
      break;
    }
    case "tool.executed": {
      const { idempotencyKey } = event.payload;
      state.executedSideEffects.add(idempotencyKey);
      break;
    }
    default:
      break;
  }
  return state;
}

function setTaskState(state: OSProjection, taskId: TaskId, next: Task["state"]): void {
  const task = state.tasks.get(taskId);
  if (task) task.state = next;
}

/** 判断任务是否可以调度：依赖全部完成（指南 §42 第 1 步） */
export function taskDependenciesSatisfied(state: OSProjection, task: Task): boolean {
  return task.dependsOnTaskIds.every((dependencyId) => state.tasks.get(dependencyId)?.state === "completed");
}
