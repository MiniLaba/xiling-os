// RuntimeManager / Run Loop（指南 §40/§44/§45）：
//   Task Scheduler → activate Agent → RunRequest → Runtime → RuntimeEvents → OS Events
// 职责：
// - 把 Runtime truth 翻译成 OS Domain truth（§7 原则）
// - tool.executed 幂等键 = taskId + toolCallId（§45，防恢复时重复副作用）
// - approval.requested 事件出现 → 任务等待审批（Human-in-the-loop）
// - artifact/ui 事件 → ArtifactService / UISurfaceService
// - run.completed / run.failed → 任务终态 + Agent suspend

import { correlationFor, newId, OsError, runId as makeRunId } from "@xiling/os-domain";
import type { AgentId, ContextBundle, ModelRequirement, NativeInputModality, NativeOutputModality, OSOperationContext, ResolvedModelRoute, RunId, Task, TaskId } from "@xiling/os-domain";
import type { AgentRuntime, RuntimeEvent } from "@xiling/os-runtime";
import { compileContext } from "./context-compiler.js";
import { OS_TOOL, taskTools } from "./runtime-tools.js";
import type { KernelServices } from "./kernel-services.js";
import type { OSKernel } from "./kernel.js";

export class RuntimeManager {
  private readonly active = new Map<TaskId, { runId: RunId; runtime: AgentRuntime; cancelling: boolean }>();
  constructor(
    private readonly kernel: OSKernel,
    private readonly services: KernelServices,
  ) {}

  /**
   * 执行一个已指派的任务：激活 Agent → 消费 Runtime 事件流 → 驱动 OS 事件。
   * 返回任务终态。Scheduler 串行调用（本实现不做并发，防重入即可）。
   */
  async executeTask(taskIdValue: TaskId, ctx?: OSOperationContext | undefined): Promise<{ state: string; artifacts: string[] }> {
    if (this.active.has(taskIdValue)) throw new OsError("illegal_transition", "任务已在执行，禁止重复启动");
    const task = this.services.tasks.get(taskIdValue);
    if (task.assignedAgentId === undefined) throw new OsError("invalid_command", `task ${taskIdValue} has no assignee`);
    const agentId = task.assignedAgentId;
    const definition = this.services.agents.get(agentId);
    const runtime = this.services.runtimes.get(task.constraints.runtimeBinding?.name ?? definition.runtimeName);
    if (!runtime) {
      await this.services.tasks.fail(taskIdValue, `运行时 ${definition.runtimeName} 未配置；不会模拟执行`, ctx);
      await this.reportLocalDelegationOutcome(taskIdValue, agentId, "failed", ctx);
      return { state: "failed", artifacts: [] };
    }

    // 模型能力在任务进入 running 前校验。不支持的原生模态直接失败，不做转码、抽帧或降级。
    let modelRoute: ResolvedModelRoute;
    try {
      const requirement = modelRequirementFor(task, this.services.projection.artifacts, runtime.supportsHostTools ? Boolean(task.outputContract?.requiredArtifactTypes?.length) : this.services.resolver.resolveForTask(agentId, task.goal).length > 0);
      assertRuntimeModalities(runtime, requirement);
      const binding = task.constraints.runtimeBinding;
      modelRoute = this.services.models.resolve(binding ? { ...definition.modelPolicy, preferred: { providerId: binding.providerId, modelId: binding.modelId }, fallbacks: [] } : definition.modelPolicy, requirement);
      if (binding && (modelRoute.address.providerId !== binding.providerId || modelRoute.address.modelId !== binding.modelId)) throw new Error("所选语音模型不支持所需能力；不会降级或切换模型");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.services.tasks.fail(taskIdValue, reason, ctx);
      await this.reportLocalDelegationOutcome(taskIdValue, agentId, "failed", ctx);
      return { state: "failed", artifacts: [] };
    }

    const activation = await this.services.agents.ensureActivation(agentId, ctx);
    this.services.agents.setActivationState(activation.activationId, "running", ctx);

    const runIdValue = makeRunId(newId("run"));
    this.services.tasks.transition(taskIdValue, { type: "task.started", payload: { taskId: taskIdValue, runId: runIdValue } }, ctx);

    const artifacts: string[] = [];
    this.active.set(taskIdValue, { runId: runIdValue, runtime, cancelling: false });
    let finalState = "failed";
    try {
      for await (const event of this.consume(runtime, runIdValue, taskIdValue, agentId, modelRoute, artifacts, ctx)) {
        // 消费由生成器驱动；事件处理在 consume 内完成
        void event;
      }
      finalState = this.services.tasks.get(taskIdValue).state;
      await this.reportLocalDelegationOutcome(taskIdValue, agentId, finalState, ctx);
    } catch (error) {
      if (!this.active.get(taskIdValue)?.cancelling && this.services.tasks.get(taskIdValue).state === "running") {
        await this.services.tasks.fail(taskIdValue, error instanceof Error ? error.message : String(error), ctx);
        await this.reportLocalDelegationOutcome(taskIdValue, agentId, "failed", ctx);
      }
      finalState = this.services.tasks.get(taskIdValue).state;
      if (!this.active.get(taskIdValue)?.cancelling) throw error;
    } finally {
      this.active.delete(taskIdValue);
      const stillActive = this.services.agents.findActiveActivation(agentId);
      if (stillActive !== undefined) {
        const current = this.services.projection.activations.get(stillActive.activationId);
        if (current !== undefined && current.state === "running") {
          this.services.agents.setActivationState(stillActive.activationId, "idle", ctx);
        }
      }
    }
    return { state: finalState, artifacts };
  }

  private async *consume(
    runtime: AgentRuntime,
    runIdValue: RunId,
    taskIdValue: TaskId,
    agentId: AgentId,
    modelRoute: ResolvedModelRoute,
    artifacts: string[],
    ctx?: OSOperationContext | undefined,
  ): AsyncGenerator<RuntimeEvent> {
    const task = this.services.tasks.get(taskIdValue);
    // A2A 委托的任务：把发送方显式构造的 ContextBundle 传给 Runtime（§10）
    const delegation = [...this.services.projection.inbox.values()].find((entry) => entry.taskId === taskIdValue);
    // Context Compiler（§38/§39）：系统策略 + Agent 配置 + 任务 + 检索记忆 + A2A 包，
    // 每段带预算与 provenance，合并后经 contextBundle 投递。
    const definition = this.services.agents.get(agentId);
    const capabilityCatalog = this.services.resolver.catalogFor(agentId);
    const resolvedCapabilities = runtime.supportsHostTools ? [] : this.services.resolver.resolveForTask(agentId, task.goal);
    const boundPlugins = resolvedCapabilities.map((entry) => entry.manifest);
    const artifactSummaries = task.inputArtifacts.flatMap((ref) => {
      const artifact = this.services.projection.artifacts.get(ref.artifactId);
      return artifact === undefined ? [] : [{
        artifactId: artifact.artifactId,
        name: artifact.name,
        summary: `${artifact.type} · ${artifact.mimeType} · ${artifact.storageRef}`,
      }];
    });
    const recentConversation = this.services.projection.messages
      .filter((message) => {
        if (message.agentId !== agentId) return false;
        const source = this.services.projection.tasks.get(message.taskId);
        return task.sessionId === undefined ? message.taskId === task.id : source?.sessionId === task.sessionId;
      })
      .slice(-12)
      .map((message) => `${message.role}: ${message.text}`);
    const compiled = compileContext({
      modelWindowTokens: Math.min(definition.modelPolicy.windowTokens ?? modelRoute.capabilities.contextWindowTokens, modelRoute.capabilities.contextWindowTokens),
      agentInstructions: definition.systemInstructions,
      pluginInstructions: runtime.supportsHostTools || capabilityCatalog.length === 0 ? [] : [{
        pluginId: "capability-catalog",
        instructions: capabilityCatalog.map((entry) =>
          `${resolvedCapabilities.some((resolved) => resolved.pluginId === entry.pluginId) ? "已激活" : "可按需激活"} [${entry.pluginId}] ${entry.actions.join(", ")}；${entry.summary}`,
        ).join("\n"),
      }],
      task: { taskId: taskIdValue, goal: task.goal, submittedInputs: (task.submittedInputs ?? []).map(({ id, payload }) => ({ id, payload })) },
      recentConversation: runtime.ownsSessionHistory ? [] : recentConversation,
      memoryHits: this.services.memories.retrieve(agentId, task.goal, { limit: 8 }),
      artifacts: artifactSummaries,
      delegationBundle: delegation?.delegation.context,
    });
    const contextBundle: ContextBundle = {
      ...(delegation?.delegation.context ?? {}),
      facts: [
        ...(runtime.supportsHostTools ? [{ key: "task-output-artifacts", value: JSON.stringify(task.outputArtifacts), sourceRef: `task://${task.id}` }] : []),
        ...task.dependsOnTaskIds.map((id) => {
          const child = this.services.tasks.get(id);
          return { key: `delegated-task:${id}`, value: JSON.stringify({ state: child.state, goal: child.goal, outputArtifacts: child.outputArtifacts, reason: child.statusReason }), sourceRef: `task://${id}` };
        }),
        ...(delegation?.delegation.context?.facts ?? []),
        ...compiled.sections.map((section) => ({
          key: section.name,
          value: section.content,
          sourceRef: `${section.provenance.source}${section.provenance.refs.length > 0 ? `:${section.provenance.refs.join(",")}` : ""}`,
        })),
      ],
    };
    // Only ship executable schemas. Legacy plugin tools remain with legacy/test adapters.
    const tools = runtime.supportsHostTools ? (modelRoute.capabilities.supportsToolUse ? [OS_TOOL] : []) : boundPlugins.flatMap((plugin) => plugin.tools ?? []);
    const executor = taskTools(this.kernel, { agentId, taskId: taskIdValue, runId: runIdValue });
    this.kernel.emit("context.compiled", {
      receipt: {
        id: newId("ctx"),
        runId: runIdValue,
        taskId: taskIdValue,
        agentId,
        totalTokens: compiled.totalTokens,
        modelWindowTokens: compiled.modelWindowTokens,
        model: modelRoute.address,
        modelCapabilitySource: modelRoute.capabilities.source,
        nativeInputs: modelRoute.capabilities.nativeInputs,
        nativeOutputs: modelRoute.capabilities.nativeOutputs,
        sections: compiled.sections.map((section) => ({
          name: section.name,
          tokens: section.tokens,
          budgetTokens: section.budgetTokens,
          source: section.provenance.source,
          refs: section.provenance.refs,
        })),
        activatedPluginIds: resolvedCapabilities.map((entry) => entry.pluginId),
        toolNames: tools.map((tool) => tool.name),
        createdAt: new Date().toISOString(),
      },
    }, correlationFor({ taskId: taskIdValue, agentId, runId: runIdValue }), ctx);
    const events = runtime.run({
      sessionId: task.sessionId,
      runId: runIdValue,
      activationId: this.services.agents.findActiveActivation(agentId)?.activationId ?? (await this.services.agents.ensureActivation(agentId, ctx)).activationId,
      agentId,
      taskId: taskIdValue,
      goal: task.goal,
      modelRoute,
      contextBundle,
      inputArtifacts: task.inputArtifacts,
      tools,
      executeTool: async (name, input, callId) => {
        if (this.active.get(taskIdValue)?.cancelling) throw new Error("Task is cancelling");
        return executor(name, input, callId);
      },
    });

    let stepCounter = 0;
    for await (const event of events) {
      if (this.active.get(taskIdValue)?.cancelling) return;
      switch (event.type) {
        case "run.started":
          break;
        case "step.started":
          stepCounter += 1;
          break;
        case "model.requested":
        case "model.completed":
          // Runtime truth：详细轨迹由 Harness 持久化（§7），OS 不复制第二套
          break;
        case "tool.requested":
          // 幂等检查：同 key 重放不再执行（§45）
          if (this.services.projection.executedSideEffects.has(idempotencyKey(taskIdValue, event.toolCallId))) {
            throw new OsError("duplicate_side_effect", `tool call ${event.toolCallId} already executed for task ${taskIdValue}`);
          }
          break;
        case "tool.completed": {
          if (runtime.supportsHostTools) break; // host gateway already committed authoritative receipt
          this.kernel.emit("tool.executed", {
            taskId: taskIdValue,
            toolCallId: event.toolCallId,
            name: "tool",
            idempotencyKey: idempotencyKey(taskIdValue, event.toolCallId),
            output: event.output,
          }, correlationFor({ taskId: taskIdValue, agentId, runId: runIdValue }), ctx);
          break;
        }
        case "artifact.produced": {
          const artifact = await this.services.artifacts.create({
            name: event.artifact.name,
            type: event.artifact.type,
            mimeType: event.artifact.mimeType,
            content: event.artifact.content,
            creatorAgentId: agentId,
            taskId: taskIdValue,
            derivedFrom: event.artifact.derivedFromArtifactIds?.map((id) => ({ artifactId: id, version: 1 })),
            ctx,
          });
          artifacts.push(artifact.artifactId);
          break;
        }
        case "approval.requested": {
          await this.services.approvals.request({
            taskId: taskIdValue,
            agentId,
            action: event.action,
            resource: event.resource,
            reason: event.reason,
            ctx,
          });
          // 审批期间让出控制权：Run Loop 终止，用户决定后任务 requeue 重新执行
          return;
        }
        case "ui.requested": {
          const surface = await this.services.ui.present({
            agentId,
            taskId: taskIdValue,
            kind: event.surface.kind,
            componentVersion: event.surface.componentVersion,
            title: event.surface.title,
            data: event.surface.data,
            actions: event.surface.actions,
            lifecycle: event.surface.lifecycle,
            ctx,
          });
          void surface;
          break;
        }
        case "message":
          this.kernel.emit("agent.message", {
            message: {
              id: newId("msg"),
              taskId: taskIdValue,
              runId: runIdValue,
              agentId,
              role: "assistant",
              text: event.text,
              createdAt: new Date().toISOString(),
            },
          }, correlationFor({ taskId: taskIdValue, agentId, runId: runIdValue }), ctx);
          break;
        case "run.completed": {
          if (["waiting_dependency", "waiting_input"].includes(this.services.tasks.get(taskIdValue).state)) return;
          // OutputContract 校验（若声明了 requiredArtifactTypes）
          const contract = this.services.tasks.get(taskIdValue).outputContract;
          const produced = this.services.tasks.get(taskIdValue).outputArtifacts
            .map((ref) => this.services.projection.artifacts.get(ref.artifactId))
            .filter((artifact) => artifact !== undefined);
          if (contract?.requiredArtifactTypes !== undefined) {
            const missing = contract.requiredArtifactTypes.filter((type) => !produced.some((artifact) => artifact.type === type));
            if (missing.length > 0) {
              await this.services.tasks.fail(taskIdValue, `output contract violated: missing artifact types ${missing.join(", ")}`, ctx);
              return;
            }
          }
          await this.services.tasks.complete(taskIdValue, ctx);
          return;
        }
        case "run.failed": {
          await this.services.tasks.fail(taskIdValue, event.reason, ctx);
          return;
        }
      }
      yield event;
    }
    // 事件流耗尽但任务未到终态 → 失败（防挂死）
    const state = this.services.tasks.get(taskIdValue).state;
    if (state === "running" && !this.active.get(taskIdValue)?.cancelling) {
      await this.services.tasks.fail(taskIdValue, "runtime ended without completion", ctx);
    }
  }

  /** 供测试/调试：中断一次运行（协作式中断由适配器实现） */
  async cancelRunningTask(taskId: TaskId): Promise<void> {
    const active = this.active.get(taskId);
    if (!active || !active.runtime.supportsCancellation) {
      throw new OsError("invalid_command", "当前运行时没有可验证的安全取消能力");
    }
    active.cancelling = true;
    try { await active.runtime.interrupt(active.runId); }
    catch (error) { active.cancelling = false; throw error; }
  }

  async interrupt(agentId: AgentId, runIdValue: RunId): Promise<void> {
    const definition = this.services.agents.get(agentId);
    const runtime = this.services.runtimes.get(definition.runtimeName);
    await runtime?.interrupt(runIdValue);
  }

  private async reportLocalDelegationOutcome(taskIdValue: TaskId, agentId: AgentId, state: string, ctx?: OSOperationContext | undefined): Promise<void> {
    const entry = [...this.services.projection.inbox.values()].find((candidate) => candidate.taskId === taskIdValue);
    if (entry === undefined || entry.state === "completed" || entry.state === "failed" || entry.state === "cancelled") return;
    if (state !== "completed" && state !== "failed" && state !== "cancelled") return;
    const task = this.services.tasks.get(taskIdValue);
    await this.services.a2a.reportStatus({
      delegationId: entry.delegationId,
      taskId: taskIdValue,
      fromAgentId: agentId,
      state,
      outputArtifacts: task.outputArtifacts,
      reason: state === "failed" ? "delegated runtime failed" : undefined,
    }, ctx);
  }
}

function modelRequirementFor(task: Task, artifacts: Map<string, { mimeType: string }>, hasTools: boolean): ModelRequirement {
  const inferredInputs = new Set<NativeInputModality>(["text"]);
  for (const ref of task.inputArtifacts) {
    const mimeType = artifacts.get(ref.artifactId)?.mimeType;
    if (mimeType?.startsWith("image/")) inferredInputs.add("image");
    if (mimeType?.startsWith("audio/")) inferredInputs.add("audio");
    if (mimeType?.startsWith("video/")) inferredInputs.add("video");
  }
  for (const modality of task.modelRequirements?.nativeInputs ?? []) inferredInputs.add(modality);
  const inferredOutputs = new Set<NativeOutputModality>(task.modelRequirements?.nativeOutputs ?? ["text"]);
  if (task.outputContract?.requiredArtifactTypes?.includes("image") === true) inferredOutputs.add("image");
  return {
    ...task.modelRequirements,
    nativeInputs: [...inferredInputs],
    nativeOutputs: [...inferredOutputs],
    toolUse: task.modelRequirements?.toolUse ?? hasTools,
  };
}

function assertRuntimeModalities(runtime: AgentRuntime, requirement: ModelRequirement): void {
  const inputs = runtime.nativeInputModalities ?? ["text"];
  const outputs = runtime.nativeOutputModalities ?? ["text"];
  const missingInputs = (requirement.nativeInputs ?? ["text"]).filter((item) => !inputs.includes(item));
  const missingOutputs = (requirement.nativeOutputs ?? ["text"]).filter((item) => !outputs.includes(item));
  if (missingInputs.length > 0 || missingOutputs.length > 0) {
    throw new OsError(
      "invalid_command",
      `运行适配器 ${runtime.name} 不能原生传递所需模态${missingInputs.length > 0 ? `；输入 ${missingInputs.join(",")}` : ""}${missingOutputs.length > 0 ? `；输出 ${missingOutputs.join(",")}` : ""}`,
    );
  }
}

function idempotencyKey(taskIdValue: TaskId, toolCallId: string): string {
  return `${taskIdValue}:${toolCallId}`;
}
