import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, type AssistantMessage, type Model, type Provider } from "@earendil-works/pi-ai";
import { createOfflineStream } from "./mock-stream.js";
import {
  AgentHarness,
  BACKGROUND_CONTEXT,
  JsonlSessionRepo,
  prepareCompaction,
  shouldCompact,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { describe, expect, it } from "vitest";

const context = BACKGROUND_CONTEXT;

const fixtureModel: Model<"openai-responses"> = {
  id: "gate-4.5-a-fixture",
  name: "Gate 4.5-A fixture",
  api: "openai-responses",
  provider: "xiling-offline",
  baseUrl: "https://invalid.local",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 4_096,
  maxTokens: 512,
};

function assistantMessage(text: string, timestamp: number): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "xiling-offline",
    model: fixtureModel.id,
    usage: {
      input: 200,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 250,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  };
}

describe("Pi native harness", () => {
  it("persists one Pi session and restores the active branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "xiling-pi-session-"));
    const env = new NodeExecutionEnv({ cwd: root });
    const repo = new JsonlSessionRepo({ fileSystem: env, sessionsRoot: join(root, "sessions") });

    try {
      const session = await repo.create({ id: "project-long-conversation", cwd: root }, context);
      const { harness } = await AgentHarness.create({ session, models: createModels(), model: fixtureModel }, context);
      const lane = await harness.lane("main", context);
      const userEntryId = await lane.appendMessage({
        role: "user",
        content: "比较两段固定海温序列。",
        timestamp: 1,
      }, context);
      const assistantEntryId = await lane.appendMessage(assistantMessage("已记录比较方案。", 2), context);
      await harness.close(context);
      const [metadata] = await repo.list({ cwd: root }, context);
      expect(metadata).toMatchObject({ id: "project-long-conversation" });
      const restored = await repo.open(metadata!, context);
      const restoredHarness = await AgentHarness.create({ session: restored, models: createModels(), model: fixtureModel }, context);
      const restoredLane = await restoredHarness.harness.lane("main", context);
      const branch = await restoredLane.findEntries({ order: "oldestFirst" }, context);
      await restoredHarness.harness.close(context);
      expect(branch.map((entry) => entry.id)).toEqual([userEntryId, assistantEntryId]);
    } finally {
      await repo.close(context);
    }
  });

  it("runs a real AgentHarness prompt instead of the old unimplemented shell", async () => {
    const root = await mkdtemp(join(tmpdir(), "xiling-pi-harness-"));
    const env = new NodeExecutionEnv({ cwd: root });
    const repo = new JsonlSessionRepo({ fileSystem: env, sessionsRoot: join(root, "sessions") });
    try {
      const session = await repo.create({ id: "project-harness", cwd: root }, context);
      const models = createModels();
      const stream = createOfflineStream(["native harness"]);
      models.setProvider({
        id: fixtureModel.provider,
        name: fixtureModel.name,
        auth: {},
        getModels: () => [fixtureModel],
        stream,
        streamSimple: stream,
      } as Provider);
      models.streamSimple = stream as typeof models.streamSimple;
      const { harness } = await AgentHarness.create({ session, models, model: fixtureModel }, context);
      const lane = await harness.lane("main", context);
      const result = await lane.prompt("offline fixture", undefined, context);
      expect(result.ok).toBe(true);
      if (!result.ok) expect(result.error.name).not.toBe("HarnessNotImplemented");
      await harness.close(context);
    } finally {
      await repo.close(context);
    }
  });

  it("prepares deterministic transcript compaction without calling a model", async () => {
    const root = await mkdtemp(join(tmpdir(), "xiling-pi-compaction-"));
    const env = new NodeExecutionEnv({ cwd: root });
    const repo = new JsonlSessionRepo({ fileSystem: env, sessionsRoot: join(root, "sessions") });
    try {
      const session = await repo.create({ id: "project-compaction", cwd: root }, context);
      const { harness } = await AgentHarness.create({ session, models: createModels(), model: fixtureModel }, context);
      const lane = await harness.lane("main", context);
      for (let turn = 0; turn < 6; turn += 1) {
        const repeatedContext = `turn-${turn} ` + "fixed-ocean-context ".repeat(80);
        await lane.appendMessage({ role: "user", content: repeatedContext, timestamp: turn * 2 + 1 }, context);
        await lane.appendMessage(assistantMessage(`answer-${turn} ` + "analysis ".repeat(60), turn * 2 + 2), context);
      }
      const entries = await lane.findEntries({ order: "oldestFirst" }, context);
      await harness.close(context);
      const settings = { enabled: true, reserveTokens: 512, keepRecentTokens: 300 };
      const prepared = prepareCompaction(entries, settings);
      expect(prepared.ok).toBe(true);
      if (!prepared.ok || !prepared.value) throw new Error("Expected compaction preparation");
      expect(prepared.value.messagesToSummarize.length).toBeGreaterThan(0);
      expect(shouldCompact(prepared.value.tokensBefore, 1_024, settings)).toBe(false);
      expect(shouldCompact(prepared.value.tokensBefore, 700, settings)).toBe(true);
    } finally {
      await repo.close(context);
    }
  });
});
