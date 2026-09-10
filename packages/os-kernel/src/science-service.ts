// ScienceService：科研计算走统一主路径（INTEGRATION.md 的 Task/Session/Artifact/Approval 归一）。
//
// 唯一权威划分：
// - 用户可见的工作单元            → TaskService（本服务创建；不由模型 Scheduler 执行）
// - 本次是否允许执行这个计划      → ApprovalService（资源 = 计划哈希，逐计划一一对应）
// - 计算过程与它的记录 ID         → ScienceExecutionPort（executionId 自己一套，不冒充 Task）
// - 计算产出的科学内容            → ArtifactService（内容寻址 + lineage）
//
// 真实声明（不得用 fixture 成功或宿主裸跑冒充验收）：
// - 没有可用的安全执行适配器时，execute() 明确拒绝并给出原因；界面据此显示"不可执行"。
// - 审批必须匹配当前计划哈希；计划变了要重新审批。计划快照在执行前重新校验哈希，防篡改。
// - 同一个任务不可重复执行：第一次 execute 后任务离开 queued，第二次直接拒绝。

import { createHash } from "node:crypto";
import { OsError, correlationFor, entityNotFound, isTerminalTaskState } from "@xiling/os-domain";
import type { AgentId, ApprovalId, ArtifactRef, OSOperationContext, SessionId, Task, TaskId } from "@xiling/os-domain";
import type { KernelServices } from "./kernel-services.js";
import type { OSKernel } from "./kernel.js";

export type ScienceJsonValue = null | boolean | number | string | ScienceJsonValue[] | { [key: string]: ScienceJsonValue };

/**
 * 执行计划 = 用户批准的对象。它自带脚本哈希、输入哈希、环境与资源上限，
 * 因此"批准过的东西"和"将要执行的东西"是同一个封闭描述。
 */
export interface ScienceExecutionPlan {
  projectId: string;
  recipe: { id: string; version: string };
  /** 已解析的输入：URI + 内容哈希。未解析的输入不允许进入审批。 */
  inputs: Array<{ name: string; uri: string; sha256: string }>;
  code: { uri: string; sha256: string };
  parameters: Record<string, ScienceJsonValue>;
  randomSeed: number;
  environment: { imageDigest: string; lockUri?: string | undefined };
  resources: { cpu: number; memoryBytes: number; timeoutMs: number };
  network: { mode: "none" | "allowlist"; hosts?: string[] | undefined };
}

export type ScienceExecutionSpec = ScienceExecutionPlan & { planHash: string };

export interface ScienceExecutionOutput {
  name: string;
  mimeType: string;
  kind: string;
  content: string;
}

export interface ScienceExecutionResult {
  outputs: ScienceExecutionOutput[];
  exitCode: number;
  startedAt: string;
  finishedAt: string;
  environmentDigest: string;
  logPath?: string | undefined;
}

/** 适配器的真实隔离声明。界面直接展示它，不允许营销化改写。 */
export interface ScienceExecutionAdapterDeclaration {
  id: string;
  label: string;
  /** 本机现在是否真的可以安全执行不可信代码。 */
  available: boolean;
  /** 不可执行时的具体原因（给用户看，不是给日志看）。 */
  reason?: string | undefined;
  isolation: {
    filesystem: "none" | "read-only" | "workspace";
    network: "none" | "allowlist";
    resourceLimits: boolean;
    processLimit: boolean;
  };
  implementationVersion: string;
}

export interface ScienceExecutionPort {
  declarations(): ScienceExecutionAdapterDeclaration[];
  /** 用指定适配器执行；适配器不可用时必须抛错，不得回退到宿主裸跑。 */
  run(spec: ScienceExecutionSpec, adapterId: string, signal: AbortSignal): Promise<{ executionId: string; result: ScienceExecutionResult }>;
  /** 把上一进程遗留的 running/queued 记录标记为失败，返回条数。 */
  recoverInterrupted(): number;
}

export interface ScienceServiceOptions {
  execution: ScienceExecutionPort;
  now?: (() => string) | undefined;
}

/**
 * 默认执行端口：明确"不可执行"。产品在通过系统级沙箱验收前不得换成宿主裸跑，
 * 也不要假装有隔离。界面读 declarations() 就能显示真实原因。
 */
export function unavailableScienceExecutionPort(reason = "本机尚未接入通过安全验收的系统级执行沙箱（无 Docker/WSL 回退）"): ScienceExecutionPort {
  return {
    declarations: () => [{
      id: "unavailable",
      label: "安全执行后端未安装",
      available: false,
      reason,
      isolation: { filesystem: "none", network: "none", resourceLimits: false, processLimit: false },
      implementationVersion: "0.0.0",
    }],
    run: async () => { throw new OsError("invalid_command", reason); },
    recoverInterrupted: () => 0,
  };
}

export interface ScienceExecutionSummary {
  taskId: TaskId;
  executionId: string;
  projectId: string;
  planHash: string;
  adapterId: string;
  status: "cancelled" | "succeeded" | "failed";
  artifacts: ArtifactRef[];
  error?: string | undefined;
}

export class ScienceService {
  private readonly summaries = new Map<TaskId, ScienceExecutionSummary>();
  private readonly active = new Map<TaskId, AbortController>();
  /** 启动时回收的上一进程遗留执行记录条数（诊断用，不是成功指标）。 */
  readonly recovered: number;

  constructor(
    private readonly kernel: OSKernel,
    private readonly services: KernelServices,
    private readonly options: ScienceServiceOptions,
  ) {
    this.recovered = this.options.execution.recoverInterrupted();
  }

  /** 真实适配器清单；调用方直接展示，不得隐藏"不可执行"。 */
  adapters(): ScienceExecutionAdapterDeclaration[] {
    return this.options.execution.declarations();
  }

  /** 选择适配器：显式指定优先，否则取第一个真正可用的。都不行则给出原因。 */
  selectAdapter(preferred?: string): { declaration: ScienceExecutionAdapterDeclaration } | { unavailableReason: string } {
    const declarations = this.adapters();
    if (preferred !== undefined) {
      const match = declarations.find((item) => item.id === preferred);
      if (!match) return { unavailableReason: `执行适配器 ${preferred} 未安装` };
      if (!match.available) return { unavailableReason: match.reason ?? `执行适配器 ${match.label} 当前不可用` };
      return { declaration: match };
    }
    const usable = declarations.find((item) => item.available);
    if (usable) return { declaration: usable };
    const reasons = declarations.map((item) => `${item.label}：${item.reason ?? "不可用"}`);
    return {
      unavailableReason: reasons.length > 0
        ? `没有可用的安全执行后端（${reasons.join("；")}）`
        : "没有配置任何安全执行后端",
    };
  }

  /** 计划规范化哈希：审批匹配与幂等都以它为准。 */
  planHashOf(plan: ScienceExecutionPlan): string {
    return sciencePlanHash(plan);
  }

  /**
   * 登记一次科研计算：创建用户可见任务并绑定计划快照与哈希。
   * 不执行任何计算，也不经过模型运行时。
   */
  async plan(input: {
    goal: string;
    plan: ScienceExecutionPlan;
    ownerAgentId: AgentId;
    projectId: string;
    sessionId?: SessionId | undefined;
    ctx?: OSOperationContext | undefined;
  }): Promise<{ task: Task; planHash: string; replayed: boolean }> {
    if (input.plan.projectId !== input.projectId) {
      throw new OsError("permission_denied", "执行计划的所属项目与请求项目不一致");
    }
    assertExecutableContract(input.plan);
    const planHash = sciencePlanHash(input.plan);
    const existing = [...this.services.projection.tasks.values()].find(
      (task) => task.constraints.science?.planHash === planHash && task.goal === input.goal,
    );
    if (existing) return { task: existing, planHash, replayed: true };

    const task = await this.services.tasks.create({
      goal: input.goal,
      sessionId: input.sessionId,
      ownerAgentId: input.ownerAgentId,
      constraints: { science: { projectId: input.projectId, planHash, plan: structuredClone(input.plan) } },
      outputContract: { requiredArtifactTypes: ["dataset", "report"] },
      ctx: input.ctx,
    });
    // 计划登记后停在 created：还没有开始这一轮执行，也还没有请求审批。
    return { task, planHash, replayed: false };
  }

  /**
   * 请求执行审批：资源就是计划哈希，计划改动即失效。
   * 状态语义与模型 Run Loop 一致 —— 任务先进入 running（这一轮已开始、执行到需要决定的那一步），
   * 再挂起为 waiting_approval；用户批准后回到 queued 等待显式 execute。
   */
  async requestApproval(taskId: TaskId, reason: string, ctx?: OSOperationContext | undefined) {
    const task = this.services.tasks.get(taskId);
    const science = requireScienceBinding(task);
    if (task.state === "created" || task.state === "queued") {
      this.services.tasks.transition(taskId, { type: "task.started", payload: { taskId, runId: `science-plan:${science.planHash.slice(0, 16)}` } }, ctx);
    } else if (task.state !== "running") {
      throw new OsError("illegal_transition", `任务 ${taskId} 当前状态 ${task.state} 不能请求执行审批`);
    }
    return this.services.approvals.request({
      taskId,
      agentId: task.assignedAgentId ?? task.ownerAgentId,
      action: "science.execute",
      resource: `plan://${science.planHash}`,
      reason,
      ctx,
    });
  }

  /** 用户决定。拒绝即任务失败；批准后任务回到 queued，等待显式 execute。 */
  async decide(approvalId: ApprovalId, decision: "approved" | "rejected", decidedBy: string, ctx?: OSOperationContext | undefined) {
    const approval = this.services.projection.approvals.get(approvalId);
    if (!approval) throw entityNotFound("approval", approvalId);
    if (approval.action !== "science.execute") {
      throw new OsError("invalid_command", "该审批不属于科学执行，不能由科研服务决定");
    }
    return this.services.approvals.decide(approvalId, decision, decidedBy, ctx);
  }

  /**
   * 执行计划。前置条件全部满足才动手：
   * 1. 任务带科学绑定且处于 queued（审批已通过）；
   * 2. 存在针对当前计划哈希的 approved 审批；
   * 3. 计划快照哈希自校验一致（防事后篡改）；
   * 4. 有真正可用的安全执行适配器。
   */
  async execute(taskId: TaskId, ctx?: OSOperationContext | undefined): Promise<ScienceExecutionSummary> {
    const task = this.services.tasks.get(taskId);
    const science = requireScienceBinding(task);
    if (task.state !== "queued") {
      const previous = this.summaries.get(taskId);
      if (previous) return previous;
      throw new OsError("illegal_transition", `任务 ${taskId} 当前状态 ${task.state} 不能执行；科学执行需要先通过审批`);
    }
    const approval = [...this.services.projection.approvals.values()].find(
      (item) => item.taskId === taskId && item.action === "science.execute"
        && item.resource === `plan://${science.planHash}` && item.state === "approved",
    );
    if (!approval) {
      throw new OsError("permission_denied", "当前计划没有有效的执行审批；计划或参数变化后必须重新审批");
    }
    const plan = readPlanSnapshot(science);
    if (sciencePlanHash(plan) !== science.planHash) {
      throw new OsError("permission_denied", "计划快照与已批准哈希不一致；不得按改动后的参数执行旧审批");
    }
    const selection = this.selectAdapter(science.adapterId);
    if ("unavailableReason" in selection) {
      // 不可执行就如实失败，不用 fixture 成功或宿主裸跑顶替。
      await this.services.tasks.fail(taskId, selection.unavailableReason, ctx);
      throw new OsError("invalid_command", selection.unavailableReason);
    }

    const agentId = task.assignedAgentId ?? task.ownerAgentId;
    const spec: ScienceExecutionSpec = { ...plan, planHash: science.planHash };
    this.services.tasks.transition(taskId, { type: "task.started", payload: { taskId, runId: `science-${approval.approvalId}` } }, ctx);
    const controller = new AbortController();
    this.active.set(taskId, controller);
    try {
      const executed = await this.options.execution.run(spec, selection.declaration.id, controller.signal);
      const artifacts = await this.registerOutputs(taskId, agentId, science.projectId, science.planHash, executed.executionId, selection.declaration.id, executed.result, ctx);
      // 与模型 Run Loop 同一套 OutputContract 语义：声明了的产物类型必须真的产出，
      // 否则任务失败而不是"看起来完成"。
      const required = task.outputContract?.requiredArtifactTypes ?? [];
      const produced = artifacts.map((ref) => this.services.projection.artifacts.get(ref.artifactId)?.type);
      const missing = required.filter((type) => !produced.includes(type as never));
      if (missing.length > 0) {
        const reason = `执行完成但缺少声明的产物类型：${missing.join("、")}`;
        this.summaries.set(taskId, {
          taskId,
          executionId: executed.executionId,
          projectId: science.projectId,
          planHash: science.planHash,
          adapterId: selection.declaration.id,
          status: "failed",
          artifacts,
          error: reason,
        });
        await this.services.tasks.fail(taskId, reason, ctx);
        return this.summaries.get(taskId)!;
      }
      const summary: ScienceExecutionSummary = {
        taskId,
        executionId: executed.executionId,
        projectId: science.projectId,
        planHash: science.planHash,
        adapterId: selection.declaration.id,
        status: "succeeded",
        artifacts,
      };
      this.summaries.set(taskId, summary);
      this.kernel.emit("task.science_bound", {
        taskId,
        binding: { ...science, adapterId: selection.declaration.id, executionId: executed.executionId },
      }, correlationFor({ taskId, agentId }), ctx);
      await this.services.tasks.complete(taskId, ctx);
      return summary;
    } catch (error) {
      const cancelled = controller.signal.aborted;
      const reason = cancelled ? "科学执行已取消" : error instanceof Error ? error.message : String(error);
      const summary: ScienceExecutionSummary = {
        taskId,
        executionId: `failed:${taskId}`,
        projectId: science.projectId,
        planHash: science.planHash,
        adapterId: selection.declaration.id,
        status: cancelled ? "cancelled" : "failed",
        artifacts: [],
        error: reason,
      };
      this.summaries.set(taskId, summary);
      if (!isTerminalTaskState(this.services.tasks.get(taskId).state)) await this.services.tasks.fail(taskId, reason, ctx);
      return summary;
    } finally {
      this.active.delete(taskId);
    }
  }

  /** 取消一次正在进行的科学执行：只有真正支持中断的适配器能收敛。 */
  async cancel(taskId: TaskId, reason: string, ctx?: OSOperationContext | undefined): Promise<void> {
    if (!this.active.has(taskId)) throw new OsError("invalid_command", "该科学执行当前不在运行");
    this.abortRunning(taskId);
    await this.services.tasks.cancel(taskId, reason, ctx);
  }

  /**
   * 中断正在运行的适配器调用（不迁移任务状态）。
   * 由 TaskService.cancel 调用：取消的入口保持唯一，驱动方按绑定类型分派。
   */
  abortRunning(taskId: TaskId): boolean {
    const controller = this.active.get(taskId);
    if (!controller) return false;
    controller.abort("cancelled by user");
    return true;
  }

  summaryOf(taskId: TaskId): ScienceExecutionSummary | undefined {
    return this.summaries.get(taskId);
  }

  /** 按项目列出科学执行任务（界面/审计用；不复制 Task 事实）。 */
  listForProject(projectId: string): Array<{ task: Task; summary?: ScienceExecutionSummary | undefined }> {
    return [...this.services.projection.tasks.values()]
      .filter((task) => task.constraints.science?.projectId === projectId)
      .map((task) => ({ task, summary: this.summaries.get(task.id) }));
  }

  private async registerOutputs(
    taskId: TaskId,
    agentId: AgentId,
    projectId: string,
    planHash: string,
    executionId: string,
    adapterId: string,
    result: ScienceExecutionResult,
    ctx?: OSOperationContext | undefined,
  ): Promise<ArtifactRef[]> {
    const refs: ArtifactRef[] = [];
    for (const output of result.outputs) {
      const artifact = await this.services.artifacts.create({
        name: output.name,
        type: output.kind === "dataset" ? "dataset" : "report",
        mimeType: output.mimeType,
        content: output.content,
        creatorAgentId: agentId,
        taskId,
        metadata: {
          science: {
            projectId,
            planHash,
            executionId,
            adapterId,
            environmentDigest: result.environmentDigest,
            exitCode: result.exitCode,
          },
        },
        ctx,
      });
      refs.push({ artifactId: artifact.artifactId, version: artifact.version });
    }
    return refs;
  }
}

export function sciencePlanHash(plan: ScienceExecutionPlan): string {
  return createHash("sha256").update(canonicalScienceJson(plan as unknown as ScienceJsonValue)).digest("hex");
}

/** 规范化 JSON：对象键排序，保证同一计划在任何序列化顺序下哈希一致。 */
export function canonicalScienceJson(value: ScienceJsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalScienceJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalScienceJson(value[key]!)}`).join(",")}}`;
}

function requireScienceBinding(task: Task) {
  const science = task.constraints.science;
  if (!science) throw new OsError("invalid_command", `任务 ${task.id} 不是科学执行任务`);
  return science;
}

/** 计划必须自带可核验的哈希与资源上限，否则不允许进入审批。 */
function assertExecutableContract(plan: ScienceExecutionPlan): void {
  if (!/^[0-9a-f]{64}$/.test(plan.code.sha256)) throw new OsError("invalid_command", "计划必须携带脚本的 sha256 内容哈希");
  if (!plan.code.uri.trim()) throw new OsError("invalid_command", "计划缺少脚本资源 URI");
  for (const input of plan.inputs) {
    if (!/^[0-9a-f]{64}$/.test(input.sha256)) throw new OsError("invalid_command", `输入 ${input.name} 缺少 sha256 内容哈希`);
    if (!input.uri.trim()) throw new OsError("invalid_command", `输入 ${input.name} 缺少资源 URI`);
  }
  if (!Number.isInteger(plan.resources.timeoutMs) || plan.resources.timeoutMs <= 0) throw new OsError("invalid_command", "计划必须声明正的超时上限");
  if (!Number.isInteger(plan.resources.memoryBytes) || plan.resources.memoryBytes <= 0) throw new OsError("invalid_command", "计划必须声明内存上限");
  if (!Number.isFinite(plan.resources.cpu) || plan.resources.cpu <= 0) throw new OsError("invalid_command", "计划必须声明 CPU 上限");
  if (!plan.environment.imageDigest.trim()) throw new OsError("invalid_command", "计划必须声明执行环境摘要");
  if (plan.network.mode === "allowlist" && (plan.network.hosts ?? []).length === 0) throw new OsError("invalid_command", "allowlist 网络模式必须列出主机");
}

function readPlanSnapshot(science: { plan: unknown }): ScienceExecutionPlan {
  const plan = science.plan;
  if (plan === null || typeof plan !== "object") throw new OsError("invalid_command", "任务缺少执行计划快照");
  return plan as ScienceExecutionPlan;
}
