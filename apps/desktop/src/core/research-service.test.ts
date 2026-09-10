// 统一科研应用服务 + 项目作用域的验收测试。
// 关注点：跨项目访问拒绝、显式绑定、重启恢复、归属校验、以及"渲染器传的 projectId 不是授权依据"。

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { EvidenceRecord, ProjectItem, ResearchProject } from "@xiling/contracts";
import { ProjectScopeError, ProjectScopeRegistry } from "./project-scope.js";
import { ResearchApplicationService } from "./research-service.js";

async function withService(work: (service: ResearchApplicationService, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "xiling-research-service-"));
  const service = new ResearchApplicationService(root);
  try {
    await work(service, root);
  } finally {
    await service.closeAll();
    await rm(root, { recursive: true, force: true });
  }
}

async function createProject(service: ResearchApplicationService, name: string): Promise<ResearchProject> {
  const projects = (await service.handle({ action: "projects.create", name, researchQuestion: `${name} 的核心研究问题` })).projects!;
  return projects.find((project) => project.name === name)!;
}

const PAPER = { id: "paper-1", title: "混合层与热浪", year: 2023, authors: ["Lin"], citationCount: 12, references: [], source: "fixture" as const };

test("未绑定项目的窗口不能读写科研数据", async () => {
  await withService(async (service) => {
    const project = await createProject(service, "Arctic NIW");
    await assert.rejects(
      service.handle({ action: "evidence.list", windowId: "win-1", projectId: project.id }),
      /尚未绑定项目/,
    );
    await assert.rejects(service.handle({ action: "project.overview", windowId: "win-1" }), /尚未绑定项目/);
  });
});

test("显式绑定后，读写都落在该项目内", async () => {
  await withService(async (service) => {
    const project = await createProject(service, "Arctic NIW");
    const bound = await service.handle({ action: "scope.bind", windowId: "win-1", projectId: project.id });
    assert.equal(bound.binding?.projectId, project.id);

    const created = (await service.handle({ action: "project.items.create", windowId: "win-1", kind: "experiment", title: "混合层深度对比" })).created as ProjectItem;
    assert.equal(created.projectId, project.id);

    const overview = await service.handle({ action: "project.overview", windowId: "win-1" });
    assert.equal(overview.scope?.projectId, project.id);
    assert.equal(overview.project?.id, project.id);
    assert.equal((overview.items ?? []).length, 1);

    // 重复携带同一个 projectId 是幂等的
    const again = await service.handle({ action: "evidence.list", windowId: "win-1", projectId: project.id });
    assert.deepEqual(again.evidence, []);
  });
});

test("跨项目请求被拒绝，且不会写入别的项目", async () => {
  await withService(async (service) => {
    const alpha = await createProject(service, "项目 A");
    const beta = await createProject(service, "项目 B");
    await service.handle({ action: "scope.bind", windowId: "win-a", projectId: alpha.id });

    await assert.rejects(
      service.handle({ action: "evidence.list", windowId: "win-a", projectId: beta.id }),
      (error: unknown) => error instanceof ProjectScopeError && error.code === "scope_conflict",
    );
    await assert.rejects(
      service.handle({ action: "evidence.save", windowId: "win-a", projectId: beta.id, paper: PAPER, sourceQuote: "原句" }),
      /不能访问项目/,
    );
    await assert.rejects(
      service.handle({ action: "project.items.create", windowId: "win-a", projectId: beta.id, kind: "task", title: "越权事项" }),
      /不能访问项目/,
    );
    // B 项目仍然是空的：越权请求没有留下副作用
    const betaItems = (await service.handle({ action: "scope.bind", windowId: "win-b", projectId: beta.id })).binding;
    assert.equal(betaItems?.projectId, beta.id);
    assert.deepEqual((await service.handle({ action: "project.items.list", windowId: "win-b" })).items, []);
    assert.deepEqual((await service.handle({ action: "evidence.list", windowId: "win-b" })).evidence, []);
  });
});

test("切换到别的项目需要显式 confirm", async () => {
  await withService(async (service) => {
    const alpha = await createProject(service, "项目 A");
    const beta = await createProject(service, "项目 B");
    await service.handle({ action: "scope.bind", windowId: "win-1", projectId: alpha.id });
    await assert.rejects(service.handle({ action: "scope.bind", windowId: "win-1", projectId: beta.id }), /显式确认/);
    assert.equal((await service.handle({ action: "scope.status", windowId: "win-1" })).binding?.projectId, alpha.id);
    await service.handle({ action: "scope.bind", windowId: "win-1", projectId: beta.id, confirm: true });
    assert.equal((await service.handle({ action: "scope.status", windowId: "win-1" })).binding?.projectId, beta.id);
  });
});

test("绑定不存在的项目被拒绝", async () => {
  await withService(async (service) => {
    await assert.rejects(service.handle({ action: "scope.bind", windowId: "win-1", projectId: "missing" }), /不存在/);
    assert.equal((await service.handle({ action: "scope.status", windowId: "win-1" })).binding ?? null, null);
  });
});

test("重启后窗口绑定从数据库恢复，而不是内存里的临时状态", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xiling-research-restart-"));
  try {
    const first = new ResearchApplicationService(root);
    const project = await createProject(first, "Arctic NIW");
    await first.handle({ action: "scope.bind", windowId: "win-1", projectId: project.id });
    await first.handle({ action: "evidence.save", windowId: "win-1", paper: PAPER, sourceQuote: "实测值。" });
    await first.closeAll();

    const second = new ResearchApplicationService(root);
    try {
      assert.equal((await second.handle({ action: "scope.status", windowId: "win-1" })).binding?.projectId, project.id);
      const evidence = (await second.handle({ action: "evidence.list", windowId: "win-1" })).evidence as EvidenceRecord[];
      assert.equal(evidence.length, 1);
      assert.equal(evidence[0]?.sourceQuote, "实测值。");
      // 另一个从未绑定过的窗口仍然被拒绝
      await assert.rejects(second.handle({ action: "evidence.list", windowId: "win-2" }), /尚未绑定项目/);
    } finally { await second.closeAll(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("事项与 Wiki 页面按归属校验，不能凭 ID 跨项目读写", async () => {
  await withService(async (service) => {
    const alpha = await createProject(service, "项目 A");
    const beta = await createProject(service, "项目 B");
    await service.handle({ action: "scope.bind", windowId: "win-a", projectId: alpha.id });
    await service.handle({ action: "scope.bind", windowId: "win-b", projectId: beta.id });

    const item = (await service.handle({ action: "project.items.create", windowId: "win-a", kind: "task", title: "A 的任务" })).created as ProjectItem;
    await assert.rejects(
      service.handle({ action: "project.items.update", windowId: "win-b", itemId: item.id, status: "done" }),
      /不属于项目/,
    );

    const page = (await service.handle({ action: "wiki.create", windowId: "win-a", title: "A 的 Wiki", markdown: "# A" })).created as { id: string };
    await assert.rejects(service.handle({ action: "wiki.get", windowId: "win-b", pageId: page.id }), /不属于项目/);
    await assert.rejects(service.handle({ action: "wiki.revise", windowId: "win-b", pageId: page.id, markdown: "# 改" }), /不属于项目/);

    // 本项目内正常读写
    const updated = (await service.handle({ action: "project.items.update", windowId: "win-a", itemId: item.id, status: "done" })).created as ProjectItem;
    assert.equal(updated.status, "done");
    const detail = await service.handle({ action: "wiki.get", windowId: "win-a", pageId: page.id });
    assert.equal(detail.page?.projectId, alpha.id);
  });
});

test("Wiki 修订产生版本历史，检索限定在项目内", async () => {
  await withService(async (service) => {
    const project = await createProject(service, "Arctic NIW");
    await service.handle({ action: "scope.bind", windowId: "win-1", projectId: project.id });
    const created = (await service.handle({ action: "wiki.create", windowId: "win-1", title: "近惯性波证据", markdown: "第一版：海冰覆盖下的增强事件。" })).created as { id: string };
    await service.handle({ action: "wiki.revise", windowId: "win-1", pageId: created.id, markdown: "第二版：加入 BGOS 系泊观测。" });

    const detail = await service.handle({ action: "wiki.get", windowId: "win-1", pageId: created.id });
    assert.equal(detail.page?.currentRevision.markdown, "第二版：加入 BGOS 系泊观测。");
    assert.equal(detail.page?.revisions.length, 2);

    const search = await service.handle({ action: "wiki.search", windowId: "win-1", query: "BGOS" });
    assert.equal((search.search ?? []).length, 1);
    // 过短的检索词直接报错，而不是返回空列表冒充"查过了没有"
    await assert.rejects(service.handle({ action: "wiki.search", windowId: "win-1", query: "x" }), /2–200/);
  });
});

test("Wiki 创建与修订允许携带资源 URI，非法 URI 被拒绝", async () => {
  await withService(async (service) => {
    const project = await createProject(service, "Arctic NIW");
    await service.handle({ action: "scope.bind", windowId: "win-1", projectId: project.id });
    const created = (await service.handle({ action: "wiki.create", windowId: "win-1", title: "带来源的页面", markdown: "正文", artifactUris: ["artifact://workflow/1/report"] })).created as { id: string; currentRevision: { artifactUris: string[] } };
    assert.deepEqual(created.currentRevision.artifactUris, ["artifact://workflow/1/report"]);
    await assert.rejects(service.handle({ action: "wiki.create", windowId: "win-1", title: "坏 URI", markdown: "", artifactUris: [42] }), /资源 URI/);
  });
});

test("证据保存要求原文摘录，且拒绝未经图谱核对的结论关联", async () => {
  await withService(async (service) => {
    const project = await createProject(service, "Arctic NIW");
    await service.handle({ action: "scope.bind", windowId: "win-1", projectId: project.id });
    await assert.rejects(service.handle({ action: "evidence.save", windowId: "win-1", paper: PAPER, sourceQuote: "   " }), /原文摘录/);
    await assert.rejects(service.handle({ action: "evidence.save", windowId: "win-1", paper: PAPER, sourceQuote: "原句", claimRevisionId: "claim-1" }), /科研图谱/);
    const saved = (await service.handle({ action: "evidence.save", windowId: "win-1", paper: PAPER, sourceQuote: "实测值。", stance: "supports", confidence: 0.75 })).saved as EvidenceRecord;
    assert.equal(saved.projectId, project.id);
    assert.equal(saved.stance, "supports");
    assert.ok(service.knowledge.listProjectionOutbox().some((record) => record.eventType === "knowledge.evidence.saved"));
  });
});

test("无法识别的操作与缺少字段都明确报错，不静默成功", async () => {
  await withService(async (service) => {
    const project = await createProject(service, "Arctic NIW");
    await service.handle({ action: "scope.bind", windowId: "win-1", projectId: project.id });
    await assert.rejects(service.handle({ action: "nope", windowId: "win-1" }), /Unsupported research operation/);
    await assert.rejects(service.handle({ action: "project.items.create", windowId: "win-1", kind: "task" }), /Missing title/);
    await assert.rejects(service.handle({ action: "project.items.create", windowId: "win-1", kind: "bogus", title: "x" }), /事项类型无效/);
    await assert.rejects(service.handle({ action: "projects.create", name: "   " }), /项目名称无效/);
    // 没有研究问题的"科研项目"会让图谱无法投影，必须在入口拒绝
    await assert.rejects(service.handle({ action: "projects.create", name: "空问题项目" }), /必须声明研究问题/);
    await assert.rejects(service.handle({ action: "wiki.get", windowId: "win-1", pageId: "missing" }), /不存在/);
  });
});

test("科研图谱投影按项目读取：证据保存后出现在该项目的图里", async () => {
  await withService(async (service) => {
    const project = await createProject(service, "Arctic NIW");
    await service.handle({ action: "scope.bind", windowId: "win-1", projectId: project.id });

    const before = await service.handle({ action: "graph.projection", windowId: "win-1" });
    assert.equal(before.graph?.projectId, project.id);
    assert.equal(before.graph?.view, "all");
    assert.equal(before.graphError, undefined);
    const beforeKinds = (before.graph?.nodes ?? []).map((node) => node.kind);
    assert.ok(beforeKinds.includes("Project") && beforeKinds.includes("ResearchQuestion"), `项目本身应可投影，实际：${beforeKinds.join(",")}`);
    assert.ok(!beforeKinds.includes("Paper"));

    await service.handle({ action: "evidence.save", windowId: "win-1", paper: PAPER, sourceQuote: "实测值。", stance: "supports" });
    const after = await service.handle({ action: "graph.projection", windowId: "win-1" });
    assert.equal(after.graphError, undefined);
    assert.equal(after.graphPending, 0, "投影成功后 outbox 不应残留待处理记录");
    const kinds = (after.graph?.nodes ?? []).map((node) => node.kind);
    assert.ok(kinds.includes("Paper"), `证据应产生 Paper 实体，实际：${kinds.join(",")}`);
    assert.ok(kinds.includes("EvidenceAssertion"), `证据应产生可推翻的结论断言，实际：${kinds.join(",")}`);
    assert.ok(kinds.includes("SourceFragment"), `证据应产生可定位的来源片段，实际：${kinds.join(",")}`);
    assert.ok((after.graph?.nodes ?? []).every((node) => node.projectId === project.id));
    assert.ok((after.graph?.relations ?? []).length > 0, "证据断言必须与项目/研究问题建立类型化关系");
  });
});

test("没有研究问题的项目无法建立，也就不会制造投影失败的证据", async () => {
  await withService(async (service) => {
    await assert.rejects(service.handle({ action: "projects.create", name: "无问题" }), /必须声明研究问题/);
    assert.equal((await service.handle({ action: "projects.list" })).projects?.some((project) => project.name === "无问题"), false);
  });
});

test("作用域注册表：项目删除时清理绑定", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xiling-scope-"));
  const registry = new ProjectScopeRegistry(path.join(directory, "scopes.sqlite"));
  try {
    registry.bind({ windowId: "win-1", projectId: "p1", exists: () => true });
    registry.bind({ windowId: "win-2", projectId: "p1", exists: () => true });
    registry.bind({ windowId: "win-3", projectId: "p2", exists: () => true });
    assert.equal(registry.list().length, 3);
    assert.equal(registry.dropProject("p1"), 2);
    assert.equal(registry.bindingOf("win-1"), undefined);
    assert.equal(registry.bindingOf("win-3")?.projectId, "p2");
    assert.equal(registry.unbind("win-3"), true);
    assert.equal(registry.unbind("win-3"), false);
  } finally { registry.close(); await rm(directory, { recursive: true, force: true }); }
});

// 语音/伴侣/对话入口：项目出处不是渲染器说了算，必须与该窗口的绑定一致。
test("入口提交的项目出处必须与窗口绑定一致", async () => {
  await withService(async (service) => {
    const alpha = await createProject(service, "Beaufort NIW");
    const beta = await createProject(service, "Chukchi 内波");

    // 未绑定就带项目出处 → 拒绝（不能凭一句话把自己的工作挂到某个项目上）
    assert.throws(() => service.scopedProject("system.companion", alpha.id), /尚未绑定科研项目/);

    await service.handle({ action: "scope.bind", windowId: "system.companion", projectId: alpha.id });
    assert.equal(service.scopedProject("system.companion", alpha.id), alpha.id);

    // 绑了 A 却声称出处是 B → 按跨项目拒绝处理
    assert.throws(() => service.scopedProject("system.companion", beta.id), ProjectScopeError);

    // 不存在的项目被拒绝（这里先撞上跨项目校验；而绑定本身也拒绝不存在的项目）
    assert.throws(() => service.scopedProject("system.companion", "project-does-not-exist"), ProjectScopeError);
    await assert.rejects(
      service.handle({ action: "scope.bind", windowId: "system.voice", projectId: "project-does-not-exist" }),
      ProjectScopeError,
    );
  });
});
