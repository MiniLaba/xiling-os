// 科研计算产出 → 科研图谱投影的验收测试。
//
// 这一环的意义：闭环的最后一链是"安全计算 → 产物 → 科研关系"。
// 如果产物只登记在产物仓库、图里看不见，那么"哪次执行、用哪个计划、在哪种隔离里跑出来的"
// 就无法从研究问题追下来 —— 那还是断链。

import { describe, expect, it } from "vitest";
import type { ResearchProjectionOutboxRecord } from "@xiling/knowledge";
import { knowledgeRecordToChangeSet } from "./knowledge-projection.js";

const PROJECT = {
  id: "project-niw",
  name: "Beaufort NIW",
  description: "海冰覆盖期近惯性波",
  researchQuestion: "全冰覆盖期近惯性波如何增强？",
  status: "active" as const,
  createdAt: "2026-09-10T00:00:00.000Z",
  updatedAt: "2026-09-10T00:00:00.000Z",
};

function record(payload: unknown, projectId = PROJECT.id): ResearchProjectionOutboxRecord {
  return {
    id: "outbox-1",
    projectionKey: "science:execution-1",
    projectId,
    sourceId: "execution-1",
    eventType: "knowledge.science.artifacts.registered",
    payload,
    createdAt: "2026-09-10T10:00:00.000Z",
  };
}

const PAYLOAD = {
  executionId: "execution-1",
  adapterId: "macos-seatbelt",
  planHash: "00e7b2a952c367e5",
  recipe: { id: "niw-rotary-decomposition", version: "1.0.0" },
  artifacts: [
    { name: "niw-report.md", uri: "artifact://art_aaa/version/1", sha256: "a".repeat(64), kind: "report", mimeType: "text/markdown" },
    { name: "niw-rotary.json", uri: "artifact://art_bbb/version/1", sha256: "b".repeat(64), kind: "dataset", mimeType: "application/json" },
  ],
};

describe("科研计算产物的图谱投影", () => {
  it("为每个产物建 Artifact + ArtifactVersion 节点，并挂在项目与研究问题下", () => {
    const changes = knowledgeRecordToChangeSet(record(PAYLOAD), PROJECT as never);

    const byKind = (kind: string) => changes.nodes.filter((node) => node.kind === kind);
    expect(byKind("Artifact")).toHaveLength(2);
    expect(byKind("ArtifactVersion")).toHaveLength(2);
    // 项目与它的研究问题仍然在投影里（每份变更集都自带上下文）
    expect(byKind("Project")).toHaveLength(1);
    expect(byKind("ResearchQuestion")).toHaveLength(1);

    // 每个产物都有 HAS_VERSION 边
    expect(changes.relations.filter((relation) => relation.kind === "HAS_VERSION")).toHaveLength(2);
    // 产物属于项目（CONTAINS 还有项目→研究问题那一条，所以按产物为目标来断言）
    const artifactIds = byKind("Artifact").map((node) => node.id);
    const containsArtifacts = changes.relations.filter(
      (relation) => relation.kind === "CONTAINS" && relation.sourceId === PROJECT.id && artifactIds.includes(relation.targetId),
    );
    expect(containsArtifacts).toHaveLength(2);
    // 版本指向研究问题：从问题可以追到这次计算
    const evaluates = changes.relations.filter((relation) => relation.kind === "EVALUATES");
    expect(evaluates).toHaveLength(2);
    for (const relation of evaluates) {
      expect(relation.targetId).toBe(byKind("ResearchQuestion")[0]!.id);
      expect(relation.sourceId.startsWith("artifact-version:")).toBe(true);
    }
  });

  it("产物版本节点带上执行溯源属性，可回答\"哪次执行、哪个计划、哪种隔离\"", () => {
    const changes = knowledgeRecordToChangeSet(record(PAYLOAD), PROJECT as never);
    const version = changes.nodes.find((node) => node.kind === "ArtifactVersion" && node.title === "niw-rotary.json")!;
    expect(version.properties).toMatchObject({
      executionId: "execution-1",
      adapterId: "macos-seatbelt",
      planHash: "00e7b2a952c367e5",
      recipe: "niw-rotary-decomposition@1.0.0",
      sha256: "b".repeat(64),
      kind: "dataset",
      mimeType: "application/json",
    });
    expect(version.sourceLocator).toBe("artifact://art_bbb/version/1");
  });

  it("没有产物时只投影项目上下文，不制造空的产物节点", () => {
    const changes = knowledgeRecordToChangeSet(record({ ...PAYLOAD, artifacts: [] }), PROJECT as never);
    expect(changes.nodes.filter((node) => node.kind === "Artifact")).toHaveLength(0);
    expect(changes.relations.filter((relation) => relation.kind === "EVALUATES")).toHaveLength(0);
  });

  it("缺少项目上下文时明确报错，而不是投影出无主产物", () => {
    expect(() => knowledgeRecordToChangeSet(record(PAYLOAD))).toThrow(/requires project/);
  });

  // 回归测试：同一份产物被科研执行与 Wiki 同时引用时，两个投影不得各写一次不可变节点。
  // 之前的写法会让 wiki 的整批变更被不可变守卫拒绝，outbox 永久 pending。
  it("Wiki 引用产物只建引用边，不重建产物节点（与执行投影不冲突）", () => {
    const wikiRecord: ResearchProjectionOutboxRecord = {
      id: "outbox-2",
      projectionKey: "wiki-1",
      projectId: PROJECT.id,
      sourceId: "rev-1",
      eventType: "knowledge.wiki.revision.created",
      createdAt: "2026-09-10T11:00:00.000Z",
      payload: {
        page: { id: "page-1", projectId: PROJECT.id, slug: "niw-notes", title: "近惯性波记录", createdAt: "2026-09-10T11:00:00.000Z", updatedAt: "2026-09-10T11:00:00.000Z" },
        revision: { id: "rev-1", pageId: "page-1", version: 1, markdown: "正文", artifactUris: [PAYLOAD.artifacts[0]!.uri], createdAt: "2026-09-10T11:00:00.000Z", artifactRefs: [], sourceRefs: [] },
      },
    };
    const changes = knowledgeRecordToChangeSet(wikiRecord, PROJECT as never);
    // Wiki 自己的节点照常投影
    expect(changes.nodes.filter((node) => node.kind === "WikiRevisionRef")).toHaveLength(1);
    // 但不再重建产物节点 —— 否则会与执行投影的不可变写法撞车
    expect(changes.nodes.filter((node) => node.kind === "Artifact")).toHaveLength(0);
    expect(changes.nodes.filter((node) => node.kind === "ArtifactVersion")).toHaveLength(0);
    // 引用边指向产物登记投影所拥有的那个版本节点 id
    const references = changes.relations.filter((relation) => relation.kind === "REFERENCES");
    expect(references).toHaveLength(1);
    const scienceChanges = knowledgeRecordToChangeSet(record(PAYLOAD), PROJECT as never);
    const ownedVersionIds = scienceChanges.nodes.filter((node) => node.kind === "ArtifactVersion").map((node) => node.id);
    expect(ownedVersionIds).toContain(references[0]!.targetId);
  });
});
