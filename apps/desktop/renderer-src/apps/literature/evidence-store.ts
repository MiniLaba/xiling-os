// Native adapter: durable KnowledgeStore + explicit per-window project scope.
//
// 作用域由核心进程的 ProjectScopeRegistry 持有，不是这里的一个可变全局变量：
// 每个窗口必须先显式绑定项目，之后所有读写都只在该项目内进行，跨项目请求被拒绝。

import type { EvidenceRecord, ScopedEvidenceInput } from "./contracts.js";

/** 文献窗口的稳定实例 ID（与桌面 store 中的应用 ID 一致）。 */
export const LITERATURE_WINDOW_ID = "system.literature";

function bridge() {
  if (!window.xilingDesktop) throw new Error("请使用原生科研 OS");
  return window.xilingDesktop;
}

/** 显式绑定本项目窗口的作用域；切换到别的项目必须传 confirm。 */
export async function bindProject(projectId: string, confirm = false): Promise<void> {
  await bridge().researchKnowledge({ action: "scope.bind", windowId: LITERATURE_WINDOW_ID, projectId, ...(confirm ? { confirm: true } : {}) });
}

export async function listEvidence(projectId: string): Promise<EvidenceRecord[]> {
  const result = await bridge().researchKnowledge({ action: "evidence.list", windowId: LITERATURE_WINDOW_ID, projectId });
  return result.evidence ?? [];
}

export async function saveEvidence(input: ScopedEvidenceInput): Promise<EvidenceRecord> {
  const result = await bridge().researchKnowledge({ ...input, action: "evidence.save", windowId: LITERATURE_WINDOW_ID });
  if (!result.saved) throw new Error("证据未保存");
  return result.saved;
}

export type { EvidenceStance } from "./contracts.js";
