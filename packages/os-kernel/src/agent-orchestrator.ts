// 动态 Worker：创建隔离身份，再通过 A2A 最小上下文包委托任务。
// 是否需要 Worker 由 Main Agent/Harness 决定；本服务不靠关键词假装规划。

import { OsError } from "@xiling/os-domain";
import type { AgentId, AttenuationRequest, ContextBundle, ModelPolicy, OSOperationContext, TaskId } from "@xiling/os-domain";
import type { KernelServices } from "./kernel-services.js";

export class AgentOrchestrator {
  constructor(private readonly services: KernelServices) {}

  async delegateToNewWorker(input: {
    fromAgentId: AgentId;
    parentTaskId?: TaskId | undefined;
    name: string;
    goal: string;
    context: ContextBundle;
    pluginIds?: string[] | undefined;
    modelPolicy?: ModelPolicy | undefined;
    attenuations?: Array<Omit<AttenuationRequest, "subject">> | undefined;
    ctx?: OSOperationContext | undefined;
  }): Promise<{ workerAgentId: AgentId; taskId: TaskId; delegationId: string; grantIds: string[] }> {
    const parent = this.services.agents.get(input.fromAgentId);
    const parentBindings = new Set(parent.pluginBindings.map((binding) => binding.pluginId));
    const requestedPlugins = [...new Set(input.pluginIds ?? [])];
    for (const pluginId of requestedPlugins) {
      if (!parentBindings.has(pluginId)) {
        throw new OsError("permission_denied", `delegator ${input.fromAgentId} is not bound to plugin ${pluginId}`);
      }
    }
    const manifests = requestedPlugins.map((pluginId) => this.services.plugins.get(pluginId));
    const allowedActions = [...new Set(manifests.flatMap((manifest) => manifest.permissions ?? []))];
    const worker = await this.services.agents.create({
      name: input.name,
      runtimeName: parent.runtimeName,
      allowedActions,
      modelPolicy: input.modelPolicy ?? parent.modelPolicy,
      memoryPolicy: { retentionDays: 1 },
      workspacePolicy: { root: parent.workspacePolicy.root, mountsAllowed: false },
      systemInstructions: `你是一个按任务创建的隔离 Worker。只完成被委托目标，只通过 Artifact 返回结果，不读取委托方私有会话。`,
      ctx: input.ctx,
    });
    for (const pluginId of requestedPlugins) await this.services.plugins.bindToAgent(worker.id, pluginId, input.ctx);
    const delegated = await this.services.a2a.delegate({
      fromAgentId: input.fromAgentId,
      toAgentId: worker.id,
      parentTaskId: input.parentTaskId,
      goal: input.goal,
      context: input.context,
      attenuations: input.attenuations?.map((request) => ({ ...request, subject: worker.id })),
      ctx: input.ctx,
    });
    return {
      workerAgentId: worker.id,
      taskId: delegated.taskId,
      delegationId: delegated.delegationId,
      grantIds: delegated.grants,
    };
  }
}
