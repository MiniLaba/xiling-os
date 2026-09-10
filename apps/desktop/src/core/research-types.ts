// 桌面科研 IPC 的返回面类型（唯一权威定义）。
// 放在独立文件里，渲染器/Preload 只依赖这份类型，不 import 核心服务实现。

import type {
  EvidenceRecord, ProjectItem, ResearchProject, WikiPageDetail, WikiPageSummary, WikiSearchResult, ResearchGraphProjection,
} from "@xiling/contracts";

/**
 * 窗口 → 项目 的绑定形状。
 * 这里刻意内联而不是 import core/project-scope.ts：渲染器只依赖类型，
 * 不应把核心进程的 node:sqlite 实现拉进渲染器编译单元。
 */
export interface ProjectScopeBindingView {
  windowId: string;
  projectId: string;
  boundAt: string;
}

/**
 * 统一科研应用服务的返回面。
 * 每个字段对应一类权威对象；没有值时就是 undefined，不用空数组冒充"查过了没有"。
 */
export interface ResearchApplicationResult {
  /** 本次请求解析出的作用域（渲染器不用猜自己属于哪个项目）。 */
  scope?: { windowId: string; projectId: string } | undefined;
  projects?: ResearchProject[] | undefined;
  project?: ResearchProject | undefined;
  items?: ProjectItem[] | undefined;
  wiki?: WikiPageSummary[] | undefined;
  page?: WikiPageDetail | undefined;
  search?: WikiSearchResult[] | undefined;
  evidence?: EvidenceRecord[] | undefined;
  saved?: EvidenceRecord | undefined;
  graph?: ResearchGraphProjection | undefined;
  /** 该项目尚未成功投影的科研关系条数（>0 表示图还不完整，不是"没有问题"）。 */
  graphPending?: number | undefined;
  /** 最近一次投影失败的原因；成功时不存在。 */
  graphError?: string | undefined;
  binding?: ProjectScopeBindingView | null | undefined;
  created?: ProjectItem | WikiPageDetail | undefined;
}

/** 旧名称保留：文献窗口仍按这个类型读取 projects / evidence / saved。 */
export type ResearchKnowledgeResult = ResearchApplicationResult;
