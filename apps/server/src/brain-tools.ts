import { Type } from "typebox";
import type { RuntimeTool } from "@xiling/pi-runtime";
import type { BrainService } from "./modules/brain/service.js";

const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value });

export function createBrainTools(brain: BrainService, projectId: string): RuntimeTool<any>[] {
  return [
    {
      name: "brain_search",
      label: "搜索共享大脑",
      description: "搜索当前项目的笔记、聊天片段、论文、图表、报告和科研图实体。不要直接查询图数据库。",
      parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false }),
      execute: async (_callId, params) => result(await brain.search(projectId, String((params as { query: string }).query))),
    },
    {
      name: "brain_read_source",
      label: "读取来源",
      description: "按科研图实体 ID 读取来源正文。正式主张不会在这里被改写。",
      parameters: Type.Object({ entityId: Type.String({ minLength: 1, maxLength: 240 }) }, { additionalProperties: false }),
      execute: async (_callId, params) => {
        const content = await brain.readSource(projectId, String((params as { entityId: string }).entityId));
        if (!content) throw new Error("Source not found");
        return result(content);
      },
    },
    {
      name: "brain_save_note",
      label: "保存笔记",
      description: "把笔记写入项目 Wiki。这不是已验证的科研结论。",
      parameters: Type.Object({
        title: Type.String({ minLength: 1, maxLength: 200 }),
        markdown: Type.String({ minLength: 1, maxLength: 200_000 }),
        pageId: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
      }, { additionalProperties: false }),
      execute: async (_callId, params) => {
        const input = params as { title: string; markdown: string; pageId?: string };
        return result(brain.saveNote({ projectId, title: input.title, markdown: input.markdown, ...(input.pageId ? { pageId: input.pageId } : {}) }));
      },
    },
    {
      name: "brain_link",
      label: "建立关系",
      description: "在现有科研图实体之间建立关系。涉及 Claim 或 Evidence 的关系会进入待决定队列，不会自动成为已验证结论。",
      parameters: Type.Object({
        kind: Type.Union([
          Type.Literal("CITES"), Type.Literal("BASED_ON"), Type.Literal("DOCUMENTS"), Type.Literal("REFERENCES"),
          Type.Literal("ASSOCIATED_WITH"), Type.Literal("CONTAINS"), Type.Literal("HAS_FRAGMENT"),
        ]),
        sourceId: Type.String({ minLength: 1, maxLength: 240 }),
        targetId: Type.String({ minLength: 1, maxLength: 240 }),
        summary: Type.Optional(Type.String({ maxLength: 2_000 })),
      }, { additionalProperties: false }),
      execute: async (_callId, params) => {
        const input = params as { kind: "CITES"; sourceId: string; targetId: string; summary?: string };
        return result(await brain.link(projectId, input));
      },
    },
  ];
}
