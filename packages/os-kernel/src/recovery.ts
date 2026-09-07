// CrashRecovery（指南 §44）：Durable state != runtime process。
// 恢复 = Event Store 重放 → 投影 → 需要时继续推进任务。
// 接线方（Electron core / 未来 server）只负责把持久化事件灌回来。

import type { OSEvent } from "@xiling/os-domain";
import { OSKernel } from "./kernel.js";
import type { OSProjection } from "./projection.js";

export interface RecoveryResult {
  projection: OSProjection;
  eventsReplayed: number;
  resumableTaskIds: string[];
}

export function recoverFromEvents(kernel: OSKernel, persistedEvents: readonly OSEvent[]): RecoveryResult {
  const projection = OSKernel.replayProjection(persistedEvents);
  // 运行中/排队中的任务在重启后需要人工或调度器继续推进；
  // 关键是不变量成立：没有任务被"假装完成"。
  const resumableTaskIds = [...projection.tasks.values()]
    .filter((task) => task.state === "created" || task.state === "queued" || task.state === "waiting_dependency" || task.state === "waiting_approval")
    .map((task) => task.id);
  return { projection, eventsReplayed: persistedEvents.length, resumableTaskIds };
}
