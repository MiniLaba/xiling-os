import { describe, expect, it } from "vitest";
import { collectBrainHits, relationNeedsDecision } from "./service.js";

describe("Brain search and relation policy", () => {
  it("returns notes, chat snippets, papers, charts and graph entities", () => {
    const hits = collectBrainHits("暖涡", {
      notes: [{ pageId: "page-1", slug: "warm-eddy", title: "暖涡笔记", excerpt: "暖涡持续", version: 1, updatedAt: "2026-01-01T00:00:00Z" }],
      chats: [{ id: "entry-1", text: "我们讨论了暖涡的寿命。", createdAt: "2026-01-01T00:00:00Z" }],
      papers: [{ id: "ev-1", projectId: "p", paper: { id: "paper-1", title: "暖涡观测", year: 2024, authors: ["A"], citationCount: 1, references: [], source: "openalex" }, note: "", stance: "supports", confidence: 0.5, sourceQuote: "", limitations: "", createdAt: "2026-01-01T00:00:00Z" }],
      entities: [{ id: "art-1", projectId: "p", kind: "ArtifactVersion", title: "暖涡图表", summary: "图", revision: 1, contentHash: "h", properties: {}, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }],
    });
    expect(hits.map((hit) => hit.kind).sort()).toEqual(["chart", "chat", "note", "paper"]);
  });

  it("sends claim and evidence links to the decision queue", () => {
    expect(relationNeedsDecision("Paper", "Paper")).toBe(false);
    expect(relationNeedsDecision("EvidenceAssertion", "Claim")).toBe(true);
  });
});
