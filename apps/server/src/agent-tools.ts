import { Type } from "typebox";
import type { RuntimeTool } from "@xiling/pi-runtime";
import type { ResearchProject } from "@xiling/contracts";
import type { OceanSubsetRequest } from "@xiling/domain-ocean";
import type { AgentKnowledgeReader } from "@xiling/knowledge";
import { LiteratureSearchService } from "@xiling/literature";
import { preflightConnector } from "@xiling/connectors";
import type { CapabilityDescriptor } from "@xiling/context";
import type { ScienceDomainCapabilityContribution } from "@xiling/science-domains";

type ToolServices = {
  project: ResearchProject;
  knowledge: AgentKnowledgeReader;
  literature: LiteratureSearchService;
  readArtifact?: (uri: string, offsetBytes: number, maxBytes: number) => Promise<{ uri: string; offsetBytes: number; text: string; truncated: boolean }>;
  readAgentEntry?: (entryId: string, offsetChars: number, maxChars: number) => Promise<{ entryId: string; text: string; offsetChars: number; truncated: boolean }>;
  searchAgentHistory?: (query: string, limit: number) => Promise<Array<{ entryId: string; kind: string; excerpt: string; createdAt: string }>>;
};

export interface ResearchCapabilityDescriptor extends CapabilityDescriptor {
  toolName: string;
  alwaysAvailable?: boolean;
  skillNames: string[];
}

export function agentEntryReaderTool(services: ToolServices): RuntimeTool<any> {
  return {
    name: "read_agent_entry",
    label: "读取画布来源全文",
    description: "仅当画布节点是截断预览时，按耐久 Entry ID 分段读取该节点的原始对话全文。",
    parameters: Type.Object({
      entryId: Type.String({ minLength: 1, maxLength: 160 }),
      offsetChars: Type.Optional(Type.Integer({ minimum: 0 })),
      maxChars: Type.Optional(Type.Integer({ minimum: 500, maximum: 12_000 })),
    }, { additionalProperties: false }),
    execute: async (_callId, params) => {
      if (!services.readAgentEntry) throw new Error("Agent entry reader is unavailable");
      const input = params as { entryId: string; offsetChars?: number; maxChars?: number };
      return result(await services.readAgentEntry(input.entryId, input.offsetChars ?? 0, input.maxChars ?? 4_000));
    },
  };
}

export function agentHistorySearchTool(services: ToolServices): RuntimeTool<any> {
  return {
    name: "search_agent_history",
    label: "检索已压缩研究历史",
    description: "仅在当前会话存在压缩历史时，按关键词检索耐久 Entry；返回少量命中摘要与 Entry ID。",
    parameters: Type.Object({
      query: Type.String({ minLength: 2, maxLength: 200 }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
    }, { additionalProperties: false }),
    execute: async (_callId, params) => {
      if (!services.searchAgentHistory) throw new Error("Agent history search is unavailable");
      const input = params as { query: string; limit?: number };
      return result(await services.searchAgentHistory(input.query, input.limit ?? 5));
    },
  };
}

export const researchCapabilityCatalog: ResearchCapabilityDescriptor[] = [
  {
    id: "artifact.read",
    toolName: "read_artifact_excerpt",
    description: "按 URI 和字符范围读取受管文本 Artifact",
    keywords: ["artifact", "产物", "图表", "结果文件", "实验结果", "审阅报告", "运行日志", "ro-crate"],
    skillNames: ["artifact-inspection"],
  },
  {
    id: "project.read",
    toolName: "read_project_context",
    description: "读取当前科研项目的结构化短摘要",
    keywords: [],
    alwaysAvailable: true,
    skillNames: [],
  },
  {
    id: "literature.search",
    toolName: "search_literature",
    description: "检索论文并返回可追溯的短元数据",
    keywords: ["文献", "论文", "引用", "paper", "literature", "citation", "related work", "研究进展", "研究现状", "综述", "前人研究", "已有研究", "研究空白", "systematic review"],
    skillNames: ["literature-evidence"],
  },
  {
    id: "wiki.read",
    toolName: "read_project_wiki",
    description: "读取当前项目 Wiki 的最新页面摘要",
    keywords: ["wiki", "知识库", "项目笔记", "已有结论", "项目记录", "研究记录", "项目沉淀"],
    skillNames: ["project-wiki-navigation"],
  },
];

export function researchCapabilityCatalogFor(contributions: readonly ScienceDomainCapabilityContribution[]): ResearchCapabilityDescriptor[] {
  return [...new Map([...researchCapabilityCatalog, ...contributions].map((capability) => [capability.id, { ...capability }])).values()];
}

const result = <T,>(value: T) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  details: value,
});

const compactProjectContext = ({ project, knowledge }: ToolServices) => {
  const items = knowledge.listItems(project.id);
  const wikiPages = knowledge.listWikiPages(project.id);
  const evidence = knowledge.listEvidence(project.id);
  return {
    project: { id: project.id, name: project.name, researchQuestion: project.researchQuestion, description: project.description },
    items: items.slice(0, 12).map(({ id, kind, title, status }) => ({ id, kind, title, status })),
    wikiPages: wikiPages.slice(0, 12).map(({ id, slug, title, revisionCount }) => ({ id, slug, title, revisionCount })),
    evidence: evidence.slice(0, 12).map(({ paper }) => ({ id: paper.id, title: paper.title, year: paper.year, source: paper.source })),
    counts: { items: items.length, wikiPages: wikiPages.length, evidence: evidence.length },
  };
};

export function projectContextCapsule(services: ToolServices): string {
  return JSON.stringify(compactProjectContext(services));
}

export function selectResearchCapabilities(prompt: string, catalog: readonly ResearchCapabilityDescriptor[] = researchCapabilityCatalog): ResearchCapabilityDescriptor[] {
  // Deliberately keep routing deterministic and local: semantic intent aliases make
  // common research language work without spending a model call or exposing every
  // tool schema. Exact tool selection remains inspectable in the context trace.
  const normalized = prompt.toLocaleLowerCase().normalize("NFKC").replace(/\s+/g, " ").trim();
  return catalog.filter((capability) => capability.alwaysAvailable || capability.keywords.some((keyword) => normalized.includes(keyword.toLocaleLowerCase().normalize("NFKC"))));
}

export function selectResearchTools(prompt: string, services: ToolServices, catalog: readonly ResearchCapabilityDescriptor[] = researchCapabilityCatalog): RuntimeTool<any>[] {
  return createResearchTools(selectResearchCapabilities(prompt, catalog), services);
}

export function createResearchTools(capabilities: ResearchCapabilityDescriptor[], services: ToolServices): RuntimeTool<any>[] {
  return capabilities.map((capability) => {
    if (capability.toolName === "read_project_context") return projectContextTool(services);
    if (capability.toolName === "search_literature") return literatureTool(services);
    if (capability.toolName === "read_project_wiki") return wikiTool(services);
    if (capability.toolName === "read_artifact_excerpt") return artifactTool(services);
    if (capability.toolName === "plan_ocean_data_subset") return preflightTool();
    throw new Error(`Science domain capability ${capability.id} has no registered Server tool adapter`);
  });
}

function artifactTool(services: ToolServices): RuntimeTool<any> {
  return {
    name: "read_artifact_excerpt",
    label: "读取受管 Artifact 片段",
    description: "按 URI 和字符范围读取 JSON、CSV、Markdown 或日志片段。不会把完整大文件装入上下文。",
    parameters: Type.Object({
      uri: Type.String({ pattern: "^artifact://", maxLength: 500 }),
      offsetBytes: Type.Optional(Type.Integer({ minimum: 0 })),
      maxBytes: Type.Optional(Type.Integer({ minimum: 500, maximum: 16_000 })),
    }, { additionalProperties: false }),
    execute: async (_callId, params) => {
      if (!services.readArtifact) throw new Error("Artifact reader is unavailable");
      const input = params as { uri: string; offsetBytes?: number; maxBytes?: number };
      return result(await services.readArtifact(input.uri, input.offsetBytes ?? 0, input.maxBytes ?? 4_000));
    },
  };
}

function projectContextTool(services: ToolServices): RuntimeTool<any> {
  return {
    name: "read_project_context",
    label: "读取当前科研项目",
    description: "读取当前项目的研究问题、任务、Wiki 和证据摘要。只返回结构化短摘要。",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => result(compactProjectContext(services)),
  };
}

function literatureTool(services: ToolServices): RuntimeTool<any> {
  return {
    name: "search_literature",
    label: "检索相关文献",
    description: "使用 Semantic Scholar，失败时降级到 OpenAlex。返回最多 8 篇论文的短元数据，不返回全文或完整参考文献。",
    parameters: Type.Object({
      query: Type.String({ minLength: 2, maxLength: 180, description: "具体的英文或中文文献检索式" }),
      limit: Type.Optional(Type.Integer({ minimum: 5, maximum: 8 })),
    }, { additionalProperties: false }),
    execute: async (_callId, params, signal) => {
      const input = params as { query: string; limit?: number };
      const response = await services.literature.search(input.query, input.limit ?? 6, signal);
      return result({
        query: response.query,
        provider: response.provider,
        cache: response.cache,
        fetchedAt: response.fetchedAt,
        papers: response.papers.slice(0, 8).map((paper) => ({ id: paper.id, title: paper.title, year: paper.year, authors: paper.authors.slice(0, 3), citationCount: paper.citationCount, source: paper.source, ...(paper.url ? { url: paper.url } : {}) })),
      });
    },
  };
}

function wikiTool(services: ToolServices): RuntimeTool<any> {
  return {
    name: "read_project_wiki",
    label: "读取项目 Wiki",
    description: "读取当前项目 Wiki 的页面标题和最新版本短摘要。不会修改 Wiki。",
    parameters: Type.Object({ pageId: Type.Optional(Type.String({ maxLength: 160 })) }, { additionalProperties: false }),
    execute: async (_callId, params) => {
      const input = params as { pageId?: string };
      const summaries = services.knowledge.listWikiPages(services.project.id);
      const selected = input.pageId ? summaries.filter((page) => page.id === input.pageId) : summaries.slice(0, 4);
      return result({ pages: selected.map((summary) => {
        const detail = services.knowledge.getWikiPage(summary.id);
        return { id: summary.id, title: summary.title, slug: summary.slug, version: detail?.currentRevision.version, excerpt: detail?.currentRevision.markdown.slice(0, 1_200) ?? "" };
      }) });
    },
  };
}

function preflightTool(): RuntimeTool<any> {
  return {
    name: "plan_ocean_data_subset",
    label: "规划海洋数据切片",
    description: "生成只读切片预检和审批披露。不会探测公网元数据、不会创建审批单、不会下载数据。",
    parameters: Type.Object({
      connectorId: Type.Union([Type.Literal("erddap"), Type.Literal("argo-gdac"), Type.Literal("copernicus-marine"), Type.Literal("nasa-harmony")]),
      datasetId: Type.String({ minLength: 1, maxLength: 240 }),
      variables: Type.Array(Type.String({ minLength: 1, maxLength: 120 }), { minItems: 1, maxItems: 20 }),
      region: Type.Object({ west: Type.Number(), east: Type.Number(), south: Type.Number(), north: Type.Number() }),
      depth: Type.Optional(Type.Object({ min: Type.Number(), max: Type.Number() })),
      time: Type.Object({ start: Type.String({ minLength: 1, maxLength: 40 }), end: Type.String({ minLength: 1, maxLength: 40 }) }),
      outputFormat: Type.Union([Type.Literal("NetCDF"), Type.Literal("Zarr"), Type.Literal("CSV")]),
    }, { additionalProperties: false }),
    execute: async (_callId, params) => {
      const request = params as OceanSubsetRequest;
      const preflight = preflightConnector(request);
      return result({ kind: "ocean-data-plan", request, preflight });
    },
  };
}
