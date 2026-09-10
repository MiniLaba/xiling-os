// 统一科研应用服务：项目 / 事项 / Wiki / 证据 / 图谱投影 的唯一入口。
//
// 这一层取代"每个窗口各接一套后端"的做法：桌面主路径只经过本服务，
// 每类对象只有一份权威（KnowledgeService 数据库 + Research Graph 投影 + 作用域注册表）。
//
// 作用域规则见 project-scope.ts：项目按窗口显式绑定，跨项目访问一律拒绝。
// 渲染器传不传 projectId 都不构成授权依据 —— 授权依据只有注册表里的绑定。

import path from "node:path";
import { KnowledgeService } from "@xiling/knowledge";
import { projectIdSchema, scopedPaperSchema, toPaperRecord } from "@xiling/api-contracts";
import type { ProjectItemKind, ProjectItemStatus, ResearchProject, ResourceUri } from "@xiling/contracts";
import { ProjectScopeError, ProjectScopeRegistry } from "./project-scope.js";
import { ResearchProjectionHost } from "./research-projections.js";
import type { ResearchApplicationResult } from "./research-types.js";

export type { ResearchApplicationResult } from "./research-types.js";

const ITEM_KINDS: readonly ProjectItemKind[] = ["milestone", "task", "experiment"];
const ITEM_STATUSES: readonly ProjectItemStatus[] = ["backlog", "ready", "running", "blocked", "done"];

export class ResearchApplicationService {
  readonly knowledge: KnowledgeService;
  readonly scopes: ProjectScopeRegistry;
  private readonly projection: ResearchProjectionHost;

  constructor(root: string) {
    this.knowledge = new KnowledgeService(path.join(root, "knowledge.sqlite"));
    this.scopes = new ProjectScopeRegistry(path.join(root, "project-scopes.sqlite"));
    this.projection = new ResearchProjectionHost(root, this.knowledge);
  }

  close(): void {
    this.scopes.close();
    this.knowledge.close();
  }

  async closeAll(): Promise<void> {
    await this.projection.close();
    this.close();
  }

  /**
   * 科研执行完成后把产物登记进科研图谱投影（与其它投影同一条 outbox）。
   * 只入队，不直接写图：图里出现的产物一定来自已登记的事实。
   */
  projectScienceArtifacts(input: {
    projectId: string;
    executionId: string;
    adapterId: string;
    planHash: string;
    recipe: { id: string; version: string };
    artifacts: Array<{ name: string; uri: string; sha256: string; kind: string; mimeType: string }>;
  }): void {
    if (this.knowledge.getProject(input.projectId) === undefined) {
      throw new ProjectScopeError("scope_unknown_project", `项目 ${input.projectId} 不存在`);
    }
    this.knowledge.registerScienceArtifacts(input);
  }

  /**
   * 宿主其它入口（语音/伴侣/对话）提交科研工作时用它校验项目出处。
   * 必须已绑定、与绑定一致、且项目真实存在——渲染器不能自己声明一个项目。
   * 与科研窗口共用同一个作用域注册表，所以权限衰减和跨项目拒绝是同一套规则。
   */
  scopedProject(windowId: string, requestedProjectId: string): string {
    if (this.scopes.bindingOf(windowId) === undefined) {
      throw new ProjectScopeError("scope_unbound", `窗口 ${windowId} 尚未绑定科研项目，不能以项目出处提交工作`);
    }
    const projectId = this.scopes.resolve({ windowId, requestedProjectId: projectIdSchema.parse(requestedProjectId) });
    if (this.knowledge.getProject(projectId) === undefined) {
      throw new ProjectScopeError("scope_unknown_project", `项目 ${projectId} 不存在`);
    }
    return projectId;
  }

  async handle(raw: unknown): Promise<ResearchApplicationResult> {
    if (!raw || typeof raw !== "object") throw new Error("Invalid research request");
    const request = raw as Record<string, unknown>;
    const action = typeof request.action === "string" ? request.action : "";

    // ---- 无作用域的目录操作：项目清单与项目创建 ----
    if (action === "projects.list") return { projects: this.knowledge.listProjects() };
    if (action === "projects.create") return { projects: this.createProject(request) };

    // ---- 作用域管理 ----
    if (action === "scope.bind") {
      const binding = this.scopes.bind({
        windowId: stringField(request, "windowId"),
        projectId: projectIdSchema.parse(request.projectId),
        ...(request.confirm === true ? { confirm: true } : {}),
        exists: (projectId) => this.knowledge.getProject(projectId) !== undefined,
      });
      return { binding };
    }
    if (action === "scope.status") {
      const binding = this.scopes.bindingOf(stringField(request, "windowId"));
      return { binding: binding ?? null };
    }
    if (action === "scope.unbind") {
      this.scopes.unbind(stringField(request, "windowId"));
      return { binding: null };
    }

    // ---- 以下全部需要已绑定作用域 ----
    const windowId = stringField(request, "windowId");
    const requestedProjectId = typeof request.projectId === "string" ? projectIdSchema.parse(request.projectId) : undefined;
    const projectId = this.scopes.resolve({ windowId, ...(requestedProjectId === undefined ? {} : { requestedProjectId }) });
    if (this.knowledge.getProject(projectId) === undefined) {
      throw new ProjectScopeError("scope_unknown_project", `项目 ${projectId} 不存在`);
    }
    const scope = { windowId, projectId };

    switch (action) {
      case "project.overview": {
        const project = this.knowledge.getProject(projectId);
        const items = this.knowledge.listItems(projectId);
        return {
          scope,
          items,
          wiki: this.knowledge.listWikiPages(projectId),
          evidence: this.knowledge.listEvidence(projectId),
          project,
        };
      }
      case "project.items.list":
        return { scope, items: this.knowledge.listItems(projectId) };
      case "project.items.create": {
        const title = stringField(request, "title");
        if (title.length > 300) throw new Error("事项标题过长");
        const kind = request.kind ?? "task";
        if (typeof kind !== "string" || !ITEM_KINDS.includes(kind as ProjectItemKind)) throw new Error("事项类型无效");
        const notes = typeof request.notes === "string" ? request.notes : "";
        return { scope, created: this.knowledge.createItem(projectId, { kind: kind as ProjectItemKind, title: title.trim(), notes }), items: this.knowledge.listItems(projectId) };
      }
      case "project.items.update": {
        const itemId = stringField(request, "itemId");
        // 归属校验：只能改本项目的事项，不能凭 ID 跨项目写信。
        if (!this.knowledge.listItems(projectId).some((item) => item.id === itemId)) {
          throw new ProjectScopeError("scope_conflict", `事项 ${itemId} 不属于项目 ${projectId}`);
        }
        const patch: { title?: string; notes?: string; status?: ProjectItemStatus } = {};
        if (typeof request.title === "string") patch.title = request.title;
        if (typeof request.notes === "string") patch.notes = request.notes;
        if (request.status !== undefined) {
          if (typeof request.status !== "string" || !ITEM_STATUSES.includes(request.status as ProjectItemStatus)) throw new Error("事项状态无效");
          patch.status = request.status as ProjectItemStatus;
        }
        return { scope, created: this.knowledge.updateItem(itemId, patch), items: this.knowledge.listItems(projectId) };
      }
      case "wiki.list":
        return { scope, wiki: this.knowledge.listWikiPages(projectId) };
      case "wiki.search": {
        const query = stringField(request, "query").trim();
        if (query.length < 2 || query.length > 200) throw new Error("Wiki 检索需要 2–200 个字符");
        const limit = typeof request.limit === "number" ? Math.min(Math.max(Math.trunc(request.limit), 1), 50) : 20;
        return { scope, search: this.knowledge.searchWikiPages(projectId, query, limit) };
      }
      case "wiki.get": {
        const page = this.knowledge.getWikiPage(stringField(request, "pageId"));
        if (!page) throw new Error("Wiki 页面不存在");
        if (page.projectId !== projectId) throw new ProjectScopeError("scope_conflict", `Wiki 页面不属于项目 ${projectId}`);
        return { scope, page };
      }
      case "wiki.create": {
        const title = stringField(request, "title").trim();
        if (!title || title.length > 200) throw new Error("Wiki 标题无效");
        const markdown = typeof request.markdown === "string" ? request.markdown : "";
        const artifactUris = resourceUris(request.artifactUris);
        return { scope, created: this.knowledge.createWikiPage({ projectId, title, markdown, ...(artifactUris === undefined ? {} : { artifactUris }) }), wiki: this.knowledge.listWikiPages(projectId) };
      }
      case "wiki.revise": {
        const pageId = stringField(request, "pageId");
        const current = this.knowledge.getWikiPage(pageId);
        if (!current) throw new Error("Wiki 页面不存在");
        if (current.projectId !== projectId) throw new ProjectScopeError("scope_conflict", `Wiki 页面不属于项目 ${projectId}`);
        const artifactUris = resourceUris(request.artifactUris);
        const revised = this.knowledge.reviseWikiPage(pageId, {
          markdown: typeof request.markdown === "string" ? request.markdown : current.currentRevision.markdown,
          ...(typeof request.title === "string" ? { title: request.title } : {}),
          ...(artifactUris === undefined ? {} : { artifactUris }),
        });
        return { scope, created: revised, wiki: this.knowledge.listWikiPages(projectId) };
      }
      case "evidence.list":
        return { scope, evidence: this.knowledge.listEvidence(projectId) };
      case "evidence.save": {
        const value = scopedPaperSchema.parse({ ...request, projectId });
        if (!value.sourceQuote.trim()) throw new Error("科研证据需要原文摘录");
        // 结论版本归属由科研图谱校验；这里不接受未核对的关联。
        if (value.claimRevisionId) throw new Error("请在科研图谱中验证并关联结论版本");
        const saved = this.knowledge.saveEvidence(projectId, toPaperRecord(value.paper), value.note, value.stance, value.confidence, {
          sourceQuote: value.sourceQuote, limitations: value.limitations,
          ...(value.sourceLocator ? { sourceLocator: value.sourceLocator } : {}),
        });
        void this.projection.flush().catch(() => console.warn("Research graph projection pending; durable outbox retained"));
        return { scope, saved };
      }
      case "graph.projection": {
        // 投影失败时把错误和待投影条数一并返回：画布据此显示"待投影"，
        // 而不是把空图当成"这个项目没有科研关系"。
        const read = await this.projection.read(projectId);
        const pending = this.knowledge.listProjectionOutbox(1000).filter((record) => record.projectId === projectId).length;
        return {
          scope,
          graph: read.projection,
          graphPending: pending,
          ...(read.flushError === undefined ? {} : { graphError: read.flushError }),
        };
      }
      default:
        throw new Error("Unsupported research operation");
    }
  }

  private createProject(request: Record<string, unknown>): ResearchProject[] {
    const rawName = typeof request.name === "string" ? request.name.trim() : "";
    if (!rawName || rawName.length > 200) throw new Error("项目名称无效");
    const description = typeof request.description === "string" ? request.description.slice(0, 2000) : "";
    const researchQuestion = typeof request.researchQuestion === "string" ? request.researchQuestion.trim().slice(0, 2000) : "";
    // 科研项目必须声明研究问题：图谱投影会为项目建立"研究问题"节点，
    // 空标题会让整批科研关系投影失败（证据保存成功但图里什么也没有）。
    if (!researchQuestion) throw new Error("科研项目必须声明研究问题");
    const domainIds = Array.isArray(request.domainIds) && request.domainIds.every((item) => typeof item === "string") && request.domainIds.length > 0
      ? (request.domainIds as string[]).slice(0, 16)
      : ["general-science"];
    this.knowledge.createProject({ name: rawName, description, researchQuestion, domainIds });
    return this.knowledge.listProjects();
  }
}

function stringField(request: Record<string, unknown>, key: string): string {
  const value = request[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing ${key}`);
  return value;
}

function resourceUris(raw: unknown): ResourceUri[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string" || !item.trim())) throw new Error("artifactUris 必须是资源 URI 数组");
  return raw as ResourceUri[];
}
