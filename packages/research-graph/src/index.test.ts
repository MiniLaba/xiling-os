import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOceanResearchFixture } from "./fixture.js";
import { LadybugResearchGraphStore } from "./index.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createStore() {
  const directory = await mkdtemp(join(tmpdir(), "xiling-research-graph-"));
  cleanup.push(directory);
  const databasePath = join(directory, "research-graph.lbdb");
  const store = new LadybugResearchGraphStore(databasePath);
  await store.initialize();
  return { store, databasePath };
}

describe("LadybugResearchGraphStore", () => {
  it("persists a typed scientific graph and returns conflicting evidence", async () => {
    const { store } = await createStore();
    const fixture = createOceanResearchFixture();
    await expect(store.applyChangeSet(fixture)).resolves.toEqual({ nodes: 18, relations: 20 });

    const evidence = await store.getEvidenceForClaim(fixture.projectId, "claim");
    expect(evidence).toHaveLength(2);
    expect(new Set(evidence.map((item) => item.stance))).toEqual(new Set(["supports", "refutes"]));
    expect(evidence.find((item) => item.stance === "supports")?.sourceLocator).toContain("figure=4");

    const literature = await store.getProjection(fixture.projectId, "literature");
    expect(literature.nodes.every((node) => !["ResearchRun", "ArtifactVersion"].includes(node.kind))).toBe(true);
    expect(literature.relations.some((relation) => relation.kind === "CITES")).toBe(true);
    await store.close();
  });

  it("traces an artifact to the exact run, inputs and review", async () => {
    const { store } = await createStore();
    const fixture = createOceanResearchFixture();
    await store.applyChangeSet(fixture);

    const lineage = await store.traceArtifact(fixture.projectId, "artifact-v1");
    expect(lineage?.run?.id).toBe("run");
    expect(new Set(lineage?.inputs.map((input) => input.id))).toEqual(new Set(["dataset", "code"]));
    expect(lineage?.reviews.map((review) => review.id)).toEqual(["review"]);
    await store.close();
  });

  it("rolls back all earlier writes when a relation endpoint is invalid", async () => {
    const { store } = await createStore();
    await expect(store.applyChangeSet({
      projectId: "rollback-project",
      nodes: [{ id: "temporary", projectId: "rollback-project", kind: "Claim", title: "不得残留" }],
      relations: [{ projectId: "rollback-project", kind: "ASSERTS", sourceId: "temporary", targetId: "missing" }],
    })).rejects.toThrow("endpoints must exist");
    await expect(store.getEntity("rollback-project", "temporary")).resolves.toBeUndefined();
    await store.close();
  });

  it("survives checkpoint, close and reopen without rebuilding projections", async () => {
    const { store, databasePath } = await createStore();
    const fixture = createOceanResearchFixture();
    await store.applyChangeSet(fixture);
    await store.checkpoint();
    await store.close();

    const reopened = new LadybugResearchGraphStore(databasePath);
    await reopened.initialize();
    const projection = await reopened.getProjection(fixture.projectId, "all");
    expect(projection.nodes).toHaveLength(18);
    expect(projection.relations).toHaveLength(20);
    await reopened.close();
  });

  it("uses a project-scoped internal key even when local entity ids collide", async () => {
    const { store } = await createStore();
    await store.applyChangeSet({
      projectId: "project-a",
      nodes: [{ id: "claim", projectId: "project-a", kind: "Claim", title: "项目 A 的结论" }],
      relations: [],
    });
    await store.applyChangeSet({
      projectId: "project-b",
      nodes: [{ id: "claim", projectId: "project-b", kind: "Claim", title: "项目 B 的结论" }],
      relations: [],
    });

    await expect(store.getEntity("project-a", "claim")).resolves.toMatchObject({ title: "项目 A 的结论" });
    await expect(store.getEntity("project-b", "claim")).resolves.toMatchObject({ title: "项目 B 的结论" });
    await store.close();
  });

  it("applies a durable projection exactly once and rejects key reuse with different content", async () => {
    const { store, databasePath } = await createStore();
    const envelope = {
      projectionKey: "knowledge:project:v1:p1:2026-08-26",
      source: "knowledge" as const,
      sourceId: "p1",
      changeSet: {
        projectId: "p1",
        nodes: [{ id: "p1", projectId: "p1", kind: "Project" as const, title: "项目一" }],
        relations: [],
      },
    };
    await expect(store.applyProjection(envelope)).resolves.toEqual({ applied: true, nodes: 1, relations: 0 });
    await expect(store.applyProjection(envelope)).resolves.toEqual({ applied: false, nodes: 0, relations: 0 });
    await store.close();

    const reopened = new LadybugResearchGraphStore(databasePath);
    await reopened.initialize();
    await expect(reopened.applyProjection(envelope)).resolves.toMatchObject({ applied: false });
    await expect(reopened.applyProjection({ ...envelope, changeSet: { ...envelope.changeSet, nodes: [{ ...envelope.changeSet.nodes[0]!, title: "冲突内容" }] } })).rejects.toThrow("projection key conflict");
    await reopened.close();
  });

  it("rejects in-place rewrites of immutable revisions but allows locator refinement", async () => {
    const { store } = await createStore();
    const base = { projectId: "p1", kind: "DatasetSnapshot" as const, id: "dataset-snapshot:abc", title: "数据快照" };
    await expect(store.applyChangeSet({ projectId: "p1", nodes: [{ ...base, uri: "artifact://connector/run-1/subset.nc", properties: { sha256: "a".repeat(64) } }], relations: [] })).resolves.toEqual({ nodes: 1, relations: 0 });
    // A locator-only refinement (connector URI → canonical artifact URI) is not
    // a content change and must not trip the immutability guard.
    await expect(store.applyChangeSet({ projectId: "p1", nodes: [{ ...base, uri: "artifact://sha256/" + "a".repeat(64), properties: { sha256: "a".repeat(64) } }], relations: [] })).resolves.toBeDefined();
    // A real content change on the same revision id is a history rewrite.
    await expect(store.applyChangeSet({ projectId: "p1", nodes: [{ ...base, properties: { sha256: "b".repeat(64) } }], relations: [] })).rejects.toThrow("Immutable DatasetSnapshot");
    await store.close();
  });

  it("keeps reads responsive while the single-writer queue commits another change set", async () => {
    const { store } = await createStore();
    const fixture = createOceanResearchFixture();
    await store.applyChangeSet(fixture);

    const [projection, evidence] = await Promise.all([
      store.getProjection(fixture.projectId, "provenance"),
      store.getEvidenceForClaim(fixture.projectId, "claim"),
      store.applyChangeSet({
        projectId: fixture.projectId,
        nodes: [{ id: "concurrent-note", projectId: fixture.projectId, kind: "Claim", title: "并发写入后的结论" }],
        relations: [],
      }),
    ]);
    expect(projection.nodes.some((node) => node.kind === "ResearchRun")).toBe(true);
    expect(evidence).toHaveLength(2);
    await expect(store.getEntity(fixture.projectId, "concurrent-note")).resolves.toBeDefined();
    await store.close();
  });
});
