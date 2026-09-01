import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AgentStreamEvent } from "@xiling/contracts";
import {
  ResearchAgentHarness, SqliteAgentSessionStore,
  type HarnessRuntime, type HarnessRuntimeFactory, type RuntimeUsageInput,
} from "./index.js";

const totals: RuntimeUsageInput = {
  providerId: "fixture", modelId: "ocean-fixture", inputTokens: 21, outputTokens: 8,
  cacheReadTokens: 3, cacheWriteTokens: 1, reasoningTokens: 2, totalTokens: 35, cost: 0.004,
};
const usageTotals = {
  inputTokens: totals.inputTokens, outputTokens: totals.outputTokens,
  cacheReadTokens: totals.cacheReadTokens, cacheWriteTokens: totals.cacheWriteTokens,
  reasoningTokens: totals.reasoningTokens, totalTokens: totals.totalTokens, cost: totals.cost,
};

class FixtureRuntime implements HarnessRuntime {
  private listener: ((event: AgentStreamEvent) => void | Promise<void>) | undefined;
  private aborted = false;
  constructor(private readonly onUsage: (usage: RuntimeUsageInput) => void | Promise<void>, private readonly delayed = false) {}
  subscribe(listener: (event: AgentStreamEvent) => void | Promise<void>): () => void { this.listener = listener; return () => { this.listener = undefined; }; }
  abort(): void { this.aborted = true; }
  async prompt(): Promise<void> {
    await this.listener?.({ type: "session.started", sessionId: "fixture" });
    await this.listener?.({ type: "tool.started", toolName: "read_ocean_fixture", callId: "call-1" });
    if (this.delayed) {
      // Mirrors pi-agent-core: an aborted prompt() resolves (never rejects) and
      // surfaces the abort as an agent_end/session.error event instead of an error.
      while (!this.aborted) await new Promise((resolve) => setTimeout(resolve, 2));
      await this.listener?.({ type: "session.error", sessionId: "fixture", message: "模型调用已取消" });
      return;
    }
    await this.listener?.({ type: "tool.finished", toolName: "read_ocean_fixture", callId: "call-1", details: { temperature: 28.4, unit: "degC" } });
    await this.onUsage(totals);
    await this.listener?.({ type: "message.delta", delta: "海温异常为 1.2°C。" });
    await this.listener?.({ type: "session.finished", sessionId: "fixture", stopReason: "stop" });
  }
}

const fixtureFactory = (delayed = false): HarnessRuntimeFactory => ({
  create: ({ onUsage }) => new FixtureRuntime(onUsage, delayed),
});

async function waitForStatus(harness: ResearchAgentHarness, runId: string, status: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const snapshot = harness.snapshot(runId);
    if (snapshot.run.status === status) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`Run ${runId} did not reach ${status}`);
}

describe("ResearchAgentHarness durable vertical slice", () => {
  it("persists parent-child delegation lineage without merging child session history", async () => {
    const root = await mkdtemp(join(tmpdir(), "xiling-agent-delegation-"));
    const store = new SqliteAgentSessionStore(join(root, "agent-center.sqlite"));
    const harness = new ResearchAgentHarness(store, fixtureFactory());
    const parentSession = harness.createSession({ projectId: "ocean-project" });
    const parentRun = harness.startTurn({ sessionId: parentSession.id, prompt: "比较三个假说", clientCommandId: "parent" }).run;
    await waitForStatus(harness, parentRun.id, "completed");
    const childSession = harness.createSession({ projectId: "ocean-project" });
    const delegation = store.createDelegation({ id: "delegation-1", projectId: "ocean-project", rootRunId: parentRun.id, parentRunId: parentRun.id, childSessionId: childSession.id, roleId: "independent-reviewer", objective: "独立盲审", isolation: "blind", contextManifestHash: "a".repeat(64), contextManifest: { entityIds: ["claim-1"] }, budget: { maxToolCalls: 4 } });
    const childRun = harness.startTurn({ sessionId: childSession.id, prompt: "独立盲审", clientCommandId: "child", context: { multiAgent: { delegationId: delegation.id } } }).run;
    store.updateDelegation(delegation.id, { status: "running", childRunId: childRun.id });
    await waitForStatus(harness, childRun.id, "completed");
    store.updateDelegation(delegation.id, { status: "completed", childRunId: childRun.id, result: { summary: "审查完成" } });

    expect(store.listRunDelegations(parentRun.id)).toMatchObject([{ childSessionId: childSession.id, childRunId: childRun.id, isolation: "blind", status: "completed" }]);
    expect(store.loadCompactionAwareHistory(childSession.id, "none").map(({ text }) => text)).not.toContain("比较三个假说");
    store.close();
  });
  it("persists native image bytes and descriptors across restart without putting bytes in transcript history", async () => {
    const root = await mkdtemp(join(tmpdir(), "xiling-agent-image-"));
    const path = join(root, "agent-center.sqlite");
    const bytes = new TextEncoder().encode("small-native-image-fixture");
    const attachment = {
      id: "image-fixture-1",
      name: "海温图.png",
      modality: "image" as const,
      mimeType: "image/png",
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      data: bytes,
    };
    const firstStore = new SqliteAgentSessionStore(path);
    const harness = new ResearchAgentHarness(firstStore, fixtureFactory());
    const session = harness.createSession({ projectId: "ocean-project" });
    const started = harness.startTurn({ sessionId: session.id, prompt: "解释这张海温图", clientCommandId: "image-1", attachments: [attachment] });
    const completed = await waitForStatus(harness, started.run.id, "completed");

    expect(completed.run.attachments).toEqual([{ id: attachment.id, name: attachment.name, modality: "image", mimeType: attachment.mimeType, size: attachment.size, sha256: attachment.sha256 }]);
    expect(firstStore.loadCompactionAwareHistory(session.id, "none")[0]).toMatchObject({ role: "user", attachments: [expect.objectContaining({ id: attachment.id, sha256: attachment.sha256 })] });
    expect(Array.from(firstStore.getAttachment(attachment.id)!.data)).toEqual(Array.from(bytes));
    firstStore.close();

    const restoredStore = new SqliteAgentSessionStore(path);
    expect(restoredStore.getRunAttachments(started.run.id)).toEqual(completed.run.attachments);
    expect(restoredStore.getAttachment(attachment.id)).toMatchObject({ projectId: "ocean-project", name: "海温图.png", mimeType: "image/png", sha256: attachment.sha256 });
    expect(Array.from(restoredStore.getAttachment(attachment.id)!.data)).toEqual(Array.from(bytes));
    restoredStore.close();
  });

  it("persists one ordered server-owned run with tool operations, entries, usage and replayable events", async () => {
    const root = await mkdtemp(join(tmpdir(), "xiling-agent-harness-"));
    const store = new SqliteAgentSessionStore(join(root, "agent-center.sqlite"));
    const harness = new ResearchAgentHarness(store, fixtureFactory());
    const session = harness.createSession({ projectId: "ocean-project" });
    const started = harness.startTurn({ sessionId: session.id, prompt: "检查海温异常", clientCommandId: "command-1" });
    const completed = await waitForStatus(harness, started.run.id, "completed");

    expect(completed.operations.map(({ kind, status }) => [kind, status])).toEqual([["model", "completed"], ["tool", "completed"]]);
    expect(completed.entries.map(({ kind }) => kind)).toEqual(["user", "tool-call", "tool-result", "assistant"]);
    expect(completed.entries.at(-1)?.text).toBe("海温异常为 1.2°C。");
    expect(completed.usageTotals).toEqual(usageTotals);
    expect(completed.events.map(({ sequence }) => sequence)).toEqual(completed.events.map((_, index) => index + 1));
    expect(completed.events.map(({ type }) => type)).toEqual(expect.arrayContaining(["run.queued", "run.started", "tool.started", "tool.finished", "usage.recorded", "run.completed"]));

    const replay: string[] = [];
    for await (const event of harness.subscribe(completed.run.id, 2)) replay.push(event.type);
    expect(replay).toEqual(completed.events.slice(2).map(({ type }) => type));
    const duplicate = harness.startTurn({ sessionId: session.id, prompt: "检查海温异常", clientCommandId: "command-1" });
    expect(duplicate.run.id).toBe(completed.run.id);
    expect(() => harness.startTurn({ sessionId: session.id, prompt: "不同载荷", clientCommandId: "command-1" })).toThrow("payload mismatch");
    store.close();
  });

  it("propagates cancellation and keeps the terminal record after the client detaches", async () => {
    const root = await mkdtemp(join(tmpdir(), "xiling-agent-cancel-"));
    const store = new SqliteAgentSessionStore(join(root, "agent-center.sqlite"));
    const harness = new ResearchAgentHarness(store, fixtureFactory(true));
    const session = harness.createSession({ projectId: "ocean-project" });
    const run = harness.startTurn({ sessionId: session.id, prompt: "等待取消", clientCommandId: "cancel-1" }).run;
    await waitForStatus(harness, run.id, "running");
    harness.cancel(run.id);
    const cancelled = await waitForStatus(harness, run.id, "cancelled");
    expect(cancelled.operations).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "cancel", status: "completed" }), expect.objectContaining({ kind: "model", status: "cancelled" })]));
    expect(cancelled.events.at(-1)?.type).toBe("run.cancelled");
    store.close();
  });

  it("settles a cancel that arrives while the runtime is still being created without calling the model or bricking the session", async () => {
    const root = await mkdtemp(join(tmpdir(), "xiling-agent-cancel-create-"));
    const store = new SqliteAgentSessionStore(join(root, "agent-center.sqlite"));
    let releaseCreate: (() => void) | undefined;
    let promptCalled = false;
    const slowFactory: HarnessRuntimeFactory = { create: async () => {
      await new Promise<void>((resolve) => { releaseCreate = resolve; });
      return { subscribe: () => () => {}, abort: () => {}, async prompt() { promptCalled = true; } };
    } };
    const harness = new ResearchAgentHarness(store, slowFactory);
    const session = harness.createSession({ projectId: "ocean-project" });
    const run = harness.startTurn({ sessionId: session.id, prompt: "创建期取消", clientCommandId: "cancel-create-1" }).run;
    harness.cancel(run.id);
    releaseCreate?.();
    const cancelled = await waitForStatus(harness, run.id, "cancelled");
    expect(promptCalled).toBe(false);
    expect(cancelled.events.at(-1)?.type).toBe("run.cancelled");
    // The single-writer slot must be free again: a follow-up turn starts normally.
    expect(() => harness.startTurn({ sessionId: session.id, prompt: "继续对话", clientCommandId: "cancel-create-2" })).not.toThrow();
    store.close();
  });

  it("archives a session, cancels its active run, and rejects future turns", async () => {
    const root = await mkdtemp(join(tmpdir(), "xiling-agent-archive-"));
    const store = new SqliteAgentSessionStore(join(root, "agent-center.sqlite"));
    const harness = new ResearchAgentHarness(store, fixtureFactory(true));
    const session = harness.createSession({ projectId: "ocean-project" });
    const run = harness.startTurn({ sessionId: session.id, prompt: "归档时取消", clientCommandId: "archive-1" }).run;
    await waitForStatus(harness, run.id, "running");

    expect(harness.archiveSession(session.id)).toMatchObject({ id: session.id, status: "archived" });
    expect((await waitForStatus(harness, run.id, "cancelled")).events.map(({ type }) => type)).toEqual(expect.arrayContaining(["run.cancel.requested", "run.cancelled"]));
    expect(() => harness.startTurn({ sessionId: session.id, prompt: "不应继续", clientCommandId: "archive-2" })).toThrow("missing or archived");
    store.close();
  });

  it("enforces one active writer per session while allowing independent sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "xiling-agent-writer-"));
    const store = new SqliteAgentSessionStore(join(root, "agent-center.sqlite"));
    const harness = new ResearchAgentHarness(store, fixtureFactory(true));
    const first = harness.createSession({ projectId: "ocean-project" });
    const second = harness.createSession({ projectId: "ocean-project" });
    const firstRun = harness.startTurn({ sessionId: first.id, prompt: "first", clientCommandId: "writer-1" }).run;
    expect(() => harness.startTurn({ sessionId: first.id, prompt: "conflict", clientCommandId: "writer-2" })).toThrow();
    const secondRun = harness.startTurn({ sessionId: second.id, prompt: "parallel", clientCommandId: "writer-3" }).run;
    expect(harness.snapshot(firstRun.id).run.status).toBe("running");
    expect(harness.snapshot(secondRun.id).run.status).toBe("running");
    harness.cancel(firstRun.id); harness.cancel(secondRun.id);
    await waitForStatus(harness, firstRun.id, "cancelled"); await waitForStatus(harness, secondRun.id, "cancelled");
    store.close();
  });

  it("terminates a repeated tool signature before an unbounded loop can continue", async () => {
    const root = await mkdtemp(join(tmpdir(), "xiling-agent-loop-guard-"));
    const store = new SqliteAgentSessionStore(join(root, "agent-center.sqlite"));
    const loopingFactory: HarnessRuntimeFactory = { create: () => {
      let listener: ((event: AgentStreamEvent) => void | Promise<void>) | undefined;
      let aborted = false;
      return {
        subscribe(next) { listener = next; return () => { listener = undefined; }; },
        abort() { aborted = true; },
        async prompt() {
          for (let call = 1; call <= 20; call += 1) {
            await listener?.({ type: "tool.started", toolName: "repeat", callId: `loop-${call}`, arguments: { same: true } });
            if (aborted) throw new Error("aborted by guard");
          }
        },
      };
    } };
    const harness = new ResearchAgentHarness(store, loopingFactory, { maxRepeatedToolSignature: 2 });
    const session = harness.createSession({ projectId: "ocean-project" });
    const run = harness.startTurn({ sessionId: session.id, prompt: "loop", clientCommandId: "loop-1" }).run;
    const failed = await waitForStatus(harness, run.id, "failed");
    expect(failed.run.error).toBe("repeated_tool_signature:repeat");
    expect(failed.operations.filter(({ kind }) => kind === "tool")).toHaveLength(3);
    store.close();
  });

  it("marks an interrupted writer as suspended and explicitly resumable after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "xiling-agent-recovery-"));
    const path = join(root, "agent-center.sqlite");
    const first = new SqliteAgentSessionStore(path);
    const session = first.createSession({ projectId: "ocean-project" });
    const run = first.startRun({ sessionId: session.id, prompt: "恢复这个回合", clientCommandId: "recover-1" }).run;
    first.transitionRun(run.id, "running");
    first.appendOperation(run.id, { kind: "model", status: "running", name: "pi.prompt" });
    first.close();

    const restoredStore = new SqliteAgentSessionStore(path);
    const restored = new ResearchAgentHarness(restoredStore, fixtureFactory());
    expect(restored.recoveredOnStartup).toBe(1);
    expect(restored.snapshot(run.id)).toMatchObject({ run: { status: "suspended" }, recovery: { resumable: true, strategy: "restart-interrupted-turn" }, operations: [expect.objectContaining({ status: "suspended" })] });
    restored.resume(run.id);
    const completed = await waitForStatus(restored, run.id, "completed");
    expect(completed.operations).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "recovery", status: "completed" })]));
    expect(completed.events.map(({ type }) => type)).toEqual(expect.arrayContaining(["run.suspended", "run.resumed", "run.completed"]));
    restoredStore.close();
  });

  it("records compaction coverage, retained tail, source hash, model, reason and usage without deleting evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "xiling-agent-compaction-"));
    const store = new SqliteAgentSessionStore(join(root, "agent-center.sqlite"));
    const harness = new ResearchAgentHarness(store, fixtureFactory());
    const session = harness.createSession({ projectId: "ocean-project" });
    for (let turn = 1; turn <= 3; turn += 1) {
      const run = harness.startTurn({ sessionId: session.id, prompt: `第 ${turn} 轮`, clientCommandId: `compact-${turn}` }).run;
      await waitForStatus(harness, run.id, "completed");
    }
    const latest = harness.startTurn({ sessionId: session.id, prompt: "触发压缩", clientCommandId: "compact-latest" }).run;
    await waitForStatus(harness, latest.id, "completed");
    const before = store.listSessionEntries(session.id).length;
    const compacted = harness.compact({ sessionId: session.id, runId: latest.id, retainEntries: 3, summary: "前序对话讨论了海温异常和数据读取。", model: "fixture-compactor", usage: usageTotals, reason: "context_window_threshold" });
    expect(compacted).toMatchObject({ retainedFromSequence: expect.any(Number), sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/), model: "fixture-compactor", reason: "context_window_threshold", usage: usageTotals });
    expect(store.listSessionEntries(session.id)).toHaveLength(before + 1);
    expect(store.snapshot(latest.id).compactions).toHaveLength(1);
    store.close();
  });

  it("automatically compacts transcript pressure and loads summary plus the retained tail", async () => {
    const root = await mkdtemp(join(tmpdir(), "xiling-agent-auto-compaction-"));
    const store = new SqliteAgentSessionStore(join(root, "agent-center.sqlite"));
    const harness = new ResearchAgentHarness(store, fixtureFactory(), { compaction: { maxEntries: 3, retainEntries: 2, async summarize(entries) { return { summary: `covered:${entries.map((entry) => entry.text).join("|")}`, model: "fixture-auto-compactor", usage: usageTotals }; } } });
    const session = harness.createSession({ projectId: "ocean-project" });
    const first = harness.startTurn({ sessionId: session.id, prompt: "first", clientCommandId: "auto-1" }).run;
    await waitForStatus(harness, first.id, "completed");
    const second = harness.startTurn({ sessionId: session.id, prompt: "second", clientCommandId: "auto-2" }).run;
    const completed = await waitForStatus(harness, second.id, "completed");
    expect(completed.compactions).toMatchObject([expect.objectContaining({ model: "fixture-auto-compactor", reason: "adaptive_transcript_pressure" })]);
    const history = store.loadCompactionAwareHistory(session.id, "none");
    expect(history[0]).toMatchObject({ role: "user", text: expect.stringContaining("此前对话压缩摘要") });
    expect(history.slice(1)).toHaveLength(1);
    expect(history.at(-1)?.role).toBe("assistant");
    store.close();
  });

  it("incrementally imports newly appended legacy messages and keeps every legacy ID idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "xiling-agent-legacy-incremental-"));
    const store = new SqliteAgentSessionStore(join(root, "agent-center.sqlite"));
    const firstMessage = { id: "legacy-1", role: "user" as const, text: "最初的研究问题", status: "complete" as const, createdAt: "2025-01-01T00:00:00.000Z" };
    const secondMessage = { id: "legacy-2", role: "assistant" as const, text: "后来追加的回答", status: "complete" as const, createdAt: "2025-01-01T00:01:00.000Z" };

    const first = store.importLegacyTranscript({ sessionId: "legacy-session", projectId: "ocean-project", messages: [firstMessage] });
    const firstEntryId = first.get(firstMessage.id);
    const appended = store.importLegacyTranscript({ sessionId: "legacy-session", projectId: "ocean-project", messages: [firstMessage, secondMessage] });
    const repeated = store.importLegacyTranscript({ sessionId: "legacy-session", projectId: "ocean-project", messages: [firstMessage, secondMessage] });

    expect(appended.get(firstMessage.id)).toBe(firstEntryId);
    expect(appended.get(secondMessage.id)).toBeTruthy();
    expect(repeated).toEqual(appended);
    expect(store.listSessionEntries("legacy-session").map(({ text }) => text)).toEqual([firstMessage.text, secondMessage.text]);
    expect(store.listSessionRuns("legacy-session")).toHaveLength(2);
    store.close();
  });

  it("carries the previous summary into incremental compactions instead of losing earlier turns", async () => {
    const root = await mkdtemp(join(tmpdir(), "xiling-agent-incremental-compaction-"));
    const store = new SqliteAgentSessionStore(join(root, "agent-center.sqlite"));
    const inputs: Array<{ previous?: string; entries: string[] }> = [];
    const harness = new ResearchAgentHarness(store, fixtureFactory(), {
      compaction: {
        maxEntries: 3,
        retainEntries: 2,
        async summarize(entries, context) {
          inputs.push({ ...(context.previousCompaction ? { previous: context.previousCompaction.summary } : {}), entries: entries.map((entry) => entry.text) });
          return {
            summary: [context.previousCompaction?.summary ?? "研究摘要", ...entries.map((entry) => entry.text)].join(" | "),
            model: "fixture-incremental-compactor",
            usage: usageTotals,
          };
        },
      },
    });
    const session = harness.createSession({ projectId: "ocean-project" });
    for (const [index, prompt] of ["第一轮海温", "第二轮盐度", "第三轮环流"].entries()) {
      const run = harness.startTurn({ sessionId: session.id, prompt, clientCommandId: `incremental-${index}` }).run;
      await waitForStatus(harness, run.id, "completed");
    }

    expect(inputs).toHaveLength(3);
    expect(inputs[0]?.previous).toBeUndefined();
    expect(inputs[1]?.previous).toContain("第一轮海温");
    expect(inputs[1]?.entries).toContain("第二轮盐度");
    const latest = store.latestCompaction(session.id);
    expect(latest?.summary).toContain("第一轮海温");
    expect(latest?.summary).toContain("第二轮盐度");
    expect(store.listSessionEntries(session.id).filter(({ kind }) => kind !== "compaction")).toHaveLength(12);
    store.close();
  });

  it("compacts a small number of long messages when estimated context pressure exceeds the threshold", async () => {
    const root = await mkdtemp(join(tmpdir(), "xiling-agent-long-context-"));
    const store = new SqliteAgentSessionStore(join(root, "agent-center.sqlite"));
    let observedPressure: { estimatedChars: number; estimatedTokens: number } | undefined;
    const harness = new ResearchAgentHarness(store, fixtureFactory(), {
      compaction: {
        maxEntries: 100,
        retainEntries: 1,
        maxEstimatedChars: 100,
        maxEstimatedTokens: 100_000,
        async summarize(entries, context) {
          observedPressure = { estimatedChars: context.estimatedChars, estimatedTokens: context.estimatedTokens };
          return { summary: entries.map((entry) => entry.text).join(" | "), model: "fixture-pressure-compactor", usage: usageTotals };
        },
      },
    });
    const session = harness.createSession({ projectId: "ocean-project" });
    const run = harness.startTurn({ sessionId: session.id, prompt: "长".repeat(500), clientCommandId: "long-context-1" }).run;
    const completed = await waitForStatus(harness, run.id, "completed");

    expect(observedPressure).toMatchObject({ estimatedChars: expect.any(Number), estimatedTokens: expect.any(Number) });
    expect(observedPressure!.estimatedChars).toBeGreaterThan(100);
    expect(completed.compactions).toEqual([expect.objectContaining({ model: "fixture-pressure-compactor" })]);
    expect(store.listSessionEntries(session.id).filter(({ kind }) => kind !== "compaction")).toHaveLength(4);
    store.close();
  });
});
