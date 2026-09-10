import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ResearchApplicationService } from "./research-service.js";

test("native research evidence uses durable project store and outbox, not localStorage", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xiling-research-"));
  let host = new ResearchApplicationService(root);
  const windowId = "system.literature";
  try {
    const projects = (await host.handle({ action: "projects.create", name: "Scope A", researchQuestion: "海冰覆盖期近惯性波如何增强？" })).projects!;
    const projectId = projects.find((p) => p.name === "Scope A")!.id;
    await host.handle({ action: "scope.bind", windowId, projectId });
    const paper = { id: "fixture-paper", title: "Source", year: 2024, authors: ["A"], citationCount: 0, references: [], source: "fixture" };
    const saved = (await host.handle({ action: "evidence.save", windowId, paper, sourceQuote: "Measured value." })).saved!;
    assert.equal(saved.projectId, projectId);
    assert.ok(host.knowledge.listProjectionOutbox().some((event) => event.eventType === "knowledge.evidence.saved"));
    // 未绑定的窗口不能凭 projectId 直接读写
    await assert.rejects(host.handle({ action: "evidence.list", windowId: "other-window", projectId }), /尚未绑定项目/);
    // 空摘录与未经图谱核对的结论关联都必须拒绝
    await assert.rejects(host.handle({ action: "evidence.save", windowId, paper, sourceQuote: "" }));
    await assert.rejects(host.handle({ action: "evidence.save", windowId, paper, sourceQuote: "Quote", claimRevisionId: "other-project" }), /科研图谱/);
    await host.closeAll();
    host = new ResearchApplicationService(root);
    assert.equal((await host.handle({ action: "evidence.list", windowId })).evidence![0]!.id, saved.id);
  } finally { await host.closeAll(); await rm(root, { recursive: true, force: true }); }
});
