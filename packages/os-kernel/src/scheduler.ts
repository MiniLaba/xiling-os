// Scheduler（指南 §42）：初期确定性调度，无 AI。
// 1 依赖满足 → 2 有指派对象 → 3 授权可用 → 4 优先级/期限排序 → 交给 Runner 执行。

import { correlationFor } from "@xiling/os-domain";
import type { AgentId, OSOperationContext, Task, TaskId } from "@xiling/os-domain";
import type { KernelServices } from "./kernel-services.js";
import type { OSKernel } from "./kernel.js";
import { taskDependenciesSatisfied } from "./projection.js";

export interface TaskRunner {
  /** 由 Kernel 注入：执行一个已就绪的任务（内部走 RuntimeManager 的 Run Loop） */
  run(taskId: TaskId, ctx: OSOperationContext): Promise<void>;
}

export class Scheduler {
  private runner?: TaskRunner | undefined;
  private ticking = false;

  constructor(
    private readonly kernel: OSKernel,
    private readonly services: KernelServices,
  ) {}

  setRunner(runner: TaskRunner): void {
    this.runner = runner;
  }

  /** 挑选下一个可执行任务：依赖满足 + 已指派 + 授权可判定 */
  pickNext(): Task | undefined {
    const candidates = [...this.services.projection.tasks.values()].filter((task) =>
      (task.state === "created" || task.state === "queued" || task.state === "waiting_dependency")
      && task.assignedAgentId !== undefined
      // 科学执行任务由 ScienceService 驱动（审批 → 安全适配器），绝不由模型 Run Loop 执行：
      // 用模型轮次冒充计算执行会掩盖"本机其实不可执行"的事实。
      && task.constraints.science === undefined,
    );
    const ready = candidates.filter((task) => taskDependenciesSatisfied(this.services.projection, task));
    if (ready.length === 0) return undefined;
    ready.sort((a, b) => {
      const priorityDelta = (b.constraints.priority ?? 0) - (a.constraints.priority ?? 0);
      if (priorityDelta !== 0) return priorityDelta;
      const deadlineA = a.constraints.deadline ?? "9999";
      const deadlineB = b.constraints.deadline ?? "9999";
      return deadlineA.localeCompare(deadlineB);
    });
    return ready[0];
  }

  /** 事件驱动的调度节拍：任何任务事件后调用；串行执行防重入 */
  async tick(ctx?: OSOperationContext | undefined): Promise<void> {
    if (this.ticking || this.runner === undefined) return;
    this.ticking = true;
    try {
      while (true) {
        const task = this.pickNext();
        if (!task) break;
        if (task.state === "waiting_dependency") {
          this.kernel.emit("task.requeued", { taskId: task.id, reason: "dependencies satisfied" }, correlationFor({ taskId: task.id }), ctx);
        }
        try { await this.runner.run(task.id, ctx ?? { actor: "system" }); }
        catch (error) {
          if (!["failed", "cancelled", "completed"].includes(this.services.tasks.get(task.id).state)) await this.services.tasks.fail(task.id, error instanceof Error ? error.message : "执行失败", ctx);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  /** 未就绪但有依赖的任务标记 waiting_dependency（可观测性） */
  markBlocked(): void {
    for (const task of this.services.projection.tasks.values()) {
      if (task.state === "created" && task.assignedAgentId !== undefined && !taskDependenciesSatisfied(this.services.projection, task)) {
        this.kernel.emit("task.waiting_dependency", { taskId: task.id, dependsOnTaskIds: task.dependsOnTaskIds }, correlationFor({ taskId: task.id }));
      }
    }
  }

  listRunnableFor(agentId: AgentId): Task[] {
    return [...this.services.projection.tasks.values()].filter((task) =>
      task.assignedAgentId === agentId && (task.state === "queued" || task.state === "created") && task.constraints.science === undefined,
    );
  }
}
