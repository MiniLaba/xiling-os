// 文献工作台插件（指南 §19/§20）：
// 旧版 Web OS 的文献工作台（PaperGraphView）改造为符合标准插件接口的桌面 APP。
// 清单是唯一天然来源：桌面 AppManifest、dock 图标、窗口规格、Agent 能力目录全部由此派生。

import type { AgentPluginManifest } from "@xiling/os-domain";

export const LITERATURE_WORKBENCH_APP_ID = "system.literature";

export const literatureWorkbenchPlugin: AgentPluginManifest = {
  id: "literature-workbench",
  version: "1.0.0",
  runtime: { entry: "builtin://literature" },
  // 提供给 Agent 的能力（进入 OS Capability Registry 目录，Main Agent 可发现并调用）
  provides: [
    { action: "literature.search", description: "在文献库中检索论文" },
    { action: "literature.read", description: "读取论文题录、摘要与笔记" },
    { action: "literature.annotate", description: "写入阅读状态与标注笔记" },
  ],
  requires: [],
  permissions: ["literature.search", "literature.read", "literature.annotate"],
  tools: [
    { name: "literature_search", description: "按标题/作者/关键词检索文献库", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
    { name: "literature_annotate", description: "更新论文阅读状态或追加笔记", inputSchema: { type: "object", properties: { paperId: { type: "string" }, status: { type: "string", enum: ["unread", "reading", "archived"] }, note: { type: "string" } } } },
  ],
  memory: { read: true, write: true },
  // 桌面 APP 声明：dock 图标 + 窗口规格（标准插件接口的 UI 段）
  ui: [
    {
      kind: "window",
      appId: LITERATURE_WORKBENCH_APP_ID,
      title: "文献工作台",
      icon: "literature",
      eyebrow: "发现与阅读",
      description: "搜索论文、维护引用网络、把阅读标注转为可引用证据。",
      window: { width: 960, height: 620 },
    },
  ],
};
