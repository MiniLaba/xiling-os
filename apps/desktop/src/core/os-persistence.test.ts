import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { OSKernel } from "@xiling/os-kernel";
import type { OSEvent } from "@xiling/os-domain";
import { OsPersistence } from "../os-persistence.js";

test("OS persistence migrates legacy JSONL once and restores events plus artifact blobs", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xiling-os-persistence-"));
  try {
    const source = new OSKernel();
    const agent = await source.agents.create({ name: "main", runtimeName: "scripted", allowedActions: [] });
    const artifact = await source.artifacts.create({ name: "result.md", type: "report", mimeType: "text/markdown", content: "# result", creatorAgentId: agent.id });
    const legacy = structuredClone(source.events.all()) as OSEvent[];
    const artifactEvent = legacy.find((event) => event.type === "artifact.created");
    assert.ok(artifactEvent?.type === "artifact.created");
    artifactEvent.payload.content = "# result";
    const legacyPath = path.join(directory, "os-events.jsonl");
    await writeFile(legacyPath, `${legacy.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");

    const databasePath = path.join(directory, "os-state.sqlite");
    const first = new OsPersistence(databasePath, legacyPath);
    assert.equal(first.loadEvents().length, legacy.length);
    assert.equal(first.get(artifact.storageRef), "# result");
    first.close();

    await writeFile(legacyPath, `${await readFile(legacyPath, "utf8")}${JSON.stringify(legacy[0])}\n`, "utf8");
    const reopened = new OsPersistence(databasePath, legacyPath);
    assert.equal(reopened.loadEvents().length, legacy.length, "migration must not replay after SQLite contains facts");
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("OS persistence keeps new event metadata separate from content and restores both", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xiling-os-blob-"));
  try {
    const databasePath = path.join(directory, "os-state.sqlite");
    const persistence = new OsPersistence(databasePath);
    const kernel = new OSKernel({
      eventHooks: { append: (event) => persistence.appendEvent(event) },
      artifactContentStore: persistence,
    });
    const agent = await kernel.agents.create({ name: "main", runtimeName: "scripted", allowedActions: [] });
    const artifact = await kernel.artifacts.create({ name: "finding.md", type: "report", mimeType: "text/markdown", content: "durable finding", creatorAgentId: agent.id });
    const event = kernel.events.byType("artifact.created")[0];
    assert.equal(event?.payload.content, undefined, "new event must not duplicate blob content");
    persistence.close();

    const reopened = new OsPersistence(databasePath);
    const restored = new OSKernel({ artifactContentStore: reopened });
    restored.events.hydrate(reopened.loadEvents());
    assert.equal(restored.artifacts.contentOf(artifact.artifactId), "durable finding");
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
