// UISurfaceService（指南 §28–§32）：
// Generative UI = Declarative UI Model。Renderer 决定如何显示；
// UI action 绝不直接执行——必须回到 Command Bus 并重新过权限（防 Model 借 UI 越权）。

import { correlationFor, entityNotFound, isUICommand, newId, OsError, UI_COMPONENT_VERSION, uiSurfaceId as makeSurfaceId } from "@xiling/os-domain";
import type { AgentId, OSOperationContext, TaskId, UIAction, UICommand, UIComponentVersion, UILifecycle, UISurface, UISurfaceKind } from "@xiling/os-domain";
import type { KernelServices } from "./kernel-services.js";
import type { OSKernel } from "./kernel.js";
import { TrustedUIRegistry } from "./trusted-ui-registry.js";

export interface PresentInput {
  agentId: AgentId;
  taskId?: TaskId | undefined;
  kind: UISurfaceKind;
  componentVersion?: UIComponentVersion | number | undefined;
  title?: string | undefined;
  data: unknown;
  actions: UIAction[];
  lifecycle?: UILifecycle | undefined;
  ctx?: OSOperationContext | undefined;
}

export class UISurfaceService {
  private readonly registry = new TrustedUIRegistry();
  constructor(
    private readonly kernel: OSKernel,
    private readonly services: KernelServices,
  ) {}

  async present(input: PresentInput): Promise<UISurface> {
    for (const action of input.actions) {
      if (!isUICommand(action.command)) {
        throw new OsError("invalid_command", `ui action "${action.id}" uses unknown command "${String(action.command)}"`);
      }
    }
    const componentVersion = input.componentVersion ?? UI_COMPONENT_VERSION;
    this.registry.validate(input.kind, componentVersion, input.data, input.actions);
    const surface: UISurface = {
      id: makeSurfaceId(newId("ui")),
      taskId: input.taskId,
      agentId: input.agentId,
      kind: input.kind,
      componentVersion: UI_COMPONENT_VERSION,
      title: input.title,
      data: input.data,
      actions: input.actions,
      lifecycle: input.lifecycle ?? (input.taskId !== undefined ? "task" : "ephemeral"),
      createdAt: new Date().toISOString(),
    };
    this.kernel.emit("ui.presented", { surface }, correlationFor({ agentId: input.agentId, taskId: input.taskId }), input.ctx);
    return surface;
  }

  async close(surfaceIdValue: string, reason: string, ctx?: OSOperationContext | undefined): Promise<void> {
    if (!this.services.projection.surfaces.has(surfaceIdValue)) throw entityNotFound("ui surface", surfaceIdValue);
    this.kernel.emit("ui.closed", { surfaceId: makeSurfaceId(surfaceIdValue), reason }, {}, ctx);
  }

  openSurfaces(): UISurface[] {
    return [...this.services.projection.surfaces.values()].filter((surface) => surface.closedAt === undefined);
  }

  /**
   * UI Action 回流：前端只发 actionId + typed input。
   * 这里只校验 action 存在且命令合法，然后把命令交给 Kernel 的命令总线；
   * 权限/审批在命令处理器里再次判定（指南 §32）。
   */
  async submitAction(surfaceIdValue: string, actionId: string, input: unknown, ctx?: OSOperationContext | undefined): Promise<{ command: UICommand; surface: UISurface }> {
    const surface = this.services.projection.surfaces.get(surfaceIdValue);
    if (!surface) throw entityNotFound("ui surface", surfaceIdValue);
    if (surface.closedAt !== undefined) throw new OsError("illegal_transition", `ui surface ${surfaceIdValue} is closed`);
    const action = surface.actions.find((candidate) => candidate.id === actionId);
    if (!action) throw new OsError("invalid_command", `action ${actionId} does not exist on surface ${surfaceIdValue}`);
    this.registry.validateActionInput(action.inputSchema, input);
    this.kernel.emit("ui.action", { surfaceId: makeSurfaceId(surfaceIdValue), actionId, command: action.command, input }, correlationFor({ agentId: surface.agentId, taskId: surface.taskId }), ctx);
    return { command: action.command, surface };
  }

  /** 类型化命令分派：先检查当前领域事实，再记录 action，最后执行服务动作。 */
  async executeAction(surfaceIdValue: string, actionId: string, input: unknown, ctx: OSOperationContext): Promise<{ command: UICommand; surface: UISurface; result?: unknown }> {
    if (ctx.actor !== "user") throw new OsError("permission_denied", "可信界面动作只能由用户发起");
    const surface = this.services.projection.surfaces.get(surfaceIdValue);
    if (!surface || surface.closedAt !== undefined) throw surface ? new OsError("illegal_transition", `ui surface ${surfaceIdValue} is closed`) : entityNotFound("ui surface", surfaceIdValue);
    const action = surface.actions.find((candidate) => candidate.id === actionId);
    if (!action) throw new OsError("invalid_command", `action ${actionId} does not exist on surface ${surfaceIdValue}`);

    const task = surface.taskId === undefined ? undefined : this.services.tasks.get(surface.taskId);
    const values = asRecord(input);
    let pending = undefined as ReturnType<KernelServices["approvals"]["pending"]>[number] | undefined;
    if (action.command === "task.approve" || action.command === "task.reject" || action.command === "tool.confirm") {
      if (!task) throw new OsError("invalid_command", `${action.command} requires a task-bound surface`);
      pending = this.services.approvals.pending().find((approval) => approval.taskId === task.id);
      if (!pending) throw new OsError("illegal_transition", "该界面对应的确认已失效");
    }
    if (action.command === "task.submit_input" || action.command === "agent.message") {
      if (!task || task.state !== "waiting_input") throw new OsError("illegal_transition", "任务当前不在等待输入");
      if (action.command === "agent.message" && (typeof values?.text !== "string" || values.text.trim() === "" || values.text.length > 20_000)) {
        throw new OsError("invalid_command", "智能体消息必须是 1–20000 字符的文本");
      }
      if (JSON.stringify(input).length > 64_000) throw new OsError("invalid_command", "任务输入超过 64KB 上限");
    }
    let selectedArtifact = undefined;
    if (action.command === "artifact.select") {
      const surfaceData = asRecord(surface.data);
      const artifactId = typeof values?.artifactId === "string" ? values.artifactId : typeof surfaceData?.artifactId === "string" ? surfaceData.artifactId : undefined;
      if (!artifactId) throw new OsError("invalid_command", "Artifact 选择缺少 artifactId");
      selectedArtifact = this.services.artifacts.get(artifactId);
      if (typeof values?.version === "number" && values.version !== selectedArtifact.version) throw new OsError("invalid_command", "Artifact 版本不存在");
    }

    const accepted = await this.submitAction(surfaceIdValue, actionId, input, ctx);
    if (accepted.command === "task.submit_input" || accepted.command === "agent.message") {
      await this.services.tasks.submitInput(task!.id, input, accepted.surface.id, ctx);
      await this.close(accepted.surface.id, "input-submitted", { actor: "system" });
      await this.services.scheduler.tick({ actor: "system" });
      return { ...accepted, result: { taskId: task!.id, state: this.services.tasks.get(task!.id).state } };
    }
    if (accepted.command === "task.approve" || accepted.command === "task.reject" || accepted.command === "tool.confirm") {
      const decision = accepted.command === "task.reject" || values?.decision === "rejected" ? "rejected" : "approved";
      await this.services.approvals.decide(pending!.approvalId, decision, "desktop-user", ctx);
      await this.close(accepted.surface.id, "approval-decided", { actor: "system" });
      if (decision === "approved") await this.services.scheduler.tick({ actor: "system" });
      return { ...accepted, result: { approvalId: pending!.approvalId, decision } };
    }
    if (accepted.command === "artifact.select") {
      if (accepted.surface.lifecycle === "ephemeral") await this.close(accepted.surface.id, "artifact-selected", { actor: "system" });
      return { ...accepted, result: { artifactId: selectedArtifact!.artifactId, version: selectedArtifact!.version } };
    }
    throw new OsError("invalid_command", `UI command ${accepted.command} has no registered handler`);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
