import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ResearchKnowledgeHost } from "./research-knowledge.js";

test("native research evidence uses durable project store and outbox, not localStorage", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xiling-research-"));
  let host = new ResearchKnowledgeHost(root);
  try {
    const projects = host.handle({ action: "projects.create", name: "Scope A" }).projects!;
    const projectId = projects.find(p => p.name === "Scope A")!.id;
    const paper = { id: "fixture-paper", title: "Source", year: 2024, authors: ["A"], citationCount: 0, references: [], source: "fixture" };
    const saved = host.handle({ action: "evidence.save", projectId, paper, sourceQuote: "Measured value." }).saved!;
    assert.equal(saved.projectId, projectId);
    assert.ok(host.knowledge.listProjectionOutbox().some(event => event.eventType === "knowledge.evidence.saved"));
    assert.throws(() => host.handle({ action: "evidence.list", projectId: "missing" }));
    assert.throws(() => host.handle({ action: "evidence.save", projectId, paper, sourceQuote: "" }));
    assert.throws(() => host.handle({ action: "evidence.save", projectId, paper, sourceQuote: "Quote", claimRevisionId: "other-project" }));
    host.close(); host = new ResearchKnowledgeHost(root);
    assert.equal(host.handle({ action: "evidence.list", projectId }).evidence![0]!.id, saved.id);
  } finally { host.close(); await rm(root, { recursive: true, force: true }); }
});
