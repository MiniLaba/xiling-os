import { describe, expect, it } from "vitest";
import { AgentRoleRegistry, MultiAgentOrchestrator, createChildAccessPolicy, evaluateDelegationNeed, extractTaskResultText, taskObjectiveWithProfile, type AgentRoleSpec, type DelegationStore, type StoredDelegation } from "./index.js";

const TEST_ROLES: AgentRoleSpec[] = [
  { id: "research-explorer", title: "explorer", description: "explore", systemPrompt: "explore", allowedCapabilities: [], defaultIsolation: "scoped", canDelegate: false },
  { id: "domain-executor", title: "executor", description: "execute", systemPrompt: "execute", allowedCapabilities: [], defaultIsolation: "execution", canDelegate: false },
  { id: "independent-reviewer", title: "reviewer", description: "review", systemPrompt: "review", allowedCapabilities: [], defaultIsolation: "blind", canDelegate: false },
];
const roleRegistry = () => new AgentRoleRegistry(TEST_ROLES);

class MemoryStore implements DelegationStore {
  records = new Map<string, StoredDelegation>();
  getDelegation(id: string) { return this.records.get(id); }
  createDelegation(input: Omit<StoredDelegation, "createdAt" | "status"> & { status?: StoredDelegation["status"] }): StoredDelegation {
    const record = { ...input, status: input.status ?? "queued", createdAt: new Date().toISOString() };
    this.records.set(record.id, record); return record;
  }
  updateDelegation(id: string, input: { status: StoredDelegation["status"]; childRunId?: string; result?: unknown; error?: string }): StoredDelegation {
    const existing = this.records.get(id)!;
    const updated = { ...existing, ...input };
    this.records.set(id, updated); return updated;
  }
}

describe("multi-agent research orchestration", () => {
  it("uses isolated child sessions, bounded concurrency and durable results", async () => {
    const store = new MemoryStore();
    let sessions = 0; let active = 0; let peak = 0;
    const orchestrator = new MultiAgentOrchestrator(store, {
      createChildSession: () => `child-${++sessions}`,
      async execute(input) {
        input.onRunStarted(`run-${input.childSessionId}`);
        active += 1; peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 4));
        active -= 1;
        return { status: "completed", ...extractTaskResultText(JSON.stringify({ summary: `完成 ${input.objective}`, sourceUris: [`https://example.test/${input.role.id}`], artifactUris: [], limitations: ["离线 fixture"] })) };
      },
    }, roleRegistry(), { maxConcurrency: 2 });
    const results = await orchestrator.delegate({
      projectId: "ocean", parentRunId: "parent", mode: "parallel",
      contextManifest: { projectId: "ocean", projectBriefRevision: "v1", researchEntityIds: ["question"], sourceUris: [], projectionHash: "hash" },
      tasks: [
        { roleId: "research-explorer", objective: "track-a" },
        { roleId: "independent-reviewer", objective: "track-b", reviewProfile: "adversarial" },
        { roleId: "domain-executor", objective: "track-c" },
      ],
    });
    expect(peak).toBe(2);
    expect(new Set(results.map((result) => result.childSessionId)).size).toBe(3);
    expect(results.every((result) => result.status === "completed")).toBe(true);
    expect([...store.records.values()].every((record) => record.status === "completed" && record.contextManifestHash.length === 64)).toBe(true);
  });

  it("rejects recursion and only recommends delegation with a bounded contract", () => {
    const registry = roleRegistry();
    expect(() => registry.register({ id: "recursive", title: "bad", description: "bad", systemPrompt: "bad", allowedCapabilities: [], defaultIsolation: "scoped", canDelegate: true as never })).toThrow("recursion");
    expect(evaluateDelegationNeed({ independentTracks: 3, hasOutputContract: true }).delegate).toBe(true);
    expect(evaluateDelegationNeed({ independentTracks: 3, hasOutputContract: false }).delegate).toBe(false);
    expect(evaluateDelegationNeed({ requiresBlindReview: true, unresolvedApproval: true }).delegate).toBe(false);
  });

  it("reuses a completed deterministic delegation instead of duplicating work", async () => {
    const store = new MemoryStore();
    let sessions = 0;
    let executions = 0;
    const orchestrator = new MultiAgentOrchestrator(store, {
      createChildSession: () => `child-${++sessions}`,
      async execute(input) {
        executions += 1;
        input.onRunStarted("child-run");
        return { status: "completed", ...extractTaskResultText(JSON.stringify({ summary: "已核验", sourceUris: ["artifact://result"], artifactUris: ["artifact://result"], limitations: [] })) };
      },
    }, roleRegistry());
    const request = {
      projectId: "ocean", parentRunId: "parent", mode: "single" as const,
      contextManifest: { projectId: "ocean", projectBriefRevision: "v1", researchEntityIds: [], sourceUris: [], projectionHash: "projection" },
      tasks: [{ roleId: "independent-reviewer", objective: "核验复现包", reviewProfile: "reproducibility" as const }],
    };
    const first = await orchestrator.delegate(request);
    const retried = await orchestrator.delegate(request);
    expect(retried).toEqual(first);
    expect(sessions).toBe(1);
    expect(executions).toBe(1);
  });

  it("persists cancellation when a parent abort reaches the child executor", async () => {
    const store = new MemoryStore();
    const controller = new AbortController();
    const orchestrator = new MultiAgentOrchestrator(store, {
      createChildSession: () => "child-cancelled",
      async execute(input) {
        input.onRunStarted("child-run-cancelled");
        return await new Promise((_, reject) => {
          input.signal?.addEventListener("abort", () => reject(new Error("child aborted")), { once: true });
          controller.abort();
        });
      },
    }, roleRegistry());
    const [result] = await orchestrator.delegate({
      projectId: "ocean", parentRunId: "parent-cancel", mode: "single", signal: controller.signal,
      contextManifest: { projectId: "ocean", projectBriefRevision: "v1", researchEntityIds: [], sourceUris: [], projectionHash: "projection" },
      tasks: [{ roleId: "research-explorer", objective: "取消检索" }],
    });
    expect(result?.status).toBe("cancelled");
    expect([...store.records.values()][0]?.status).toBe("cancelled");
  });

  it("enforces blind source allowlists and rejects prose handoffs", () => {
    const manifest = { projectId: "p", projectBriefRevision: "v1", researchEntityIds: ["claim:secret"], sourceUris: ["artifact://allowed"], projectionHash: "hash" };
    const policy = createChildAccessPolicy(manifest, "blind");
    expect(policy.canReadEntity("claim:secret")).toBe(false);
    expect(policy.canReadSource("artifact://allowed")).toBe(true);
    expect(() => policy.assertSource("artifact://guessed")).toThrow("denied");
    expect(() => extractTaskResultText("结论：看起来可复现")).toThrow("valid JSON");
    expect(() => extractTaskResultText(JSON.stringify({ summary: "x", sourceUris: [], artifactUris: [], limitations: [], hidden: "leak" }))).toThrow("schema");
  });

  it("applies one dynamic review rubric instead of multiplying reviewer roles", () => {
    expect(taskObjectiveWithProfile({ roleId: "independent-reviewer", objective: "核验结果", reviewProfile: "evidence" })).toContain("来源定位");
    expect(taskObjectiveWithProfile({ roleId: "independent-reviewer", objective: "核验结果", reviewProfile: "reproducibility" })).toContain("环境 digest");
    expect(() => taskObjectiveWithProfile({ roleId: "research-explorer", objective: "检索", reviewProfile: "methods" })).toThrow("only valid");
  });

  it("propagates the duration budget as a cancellation token", async () => {
    const store = new MemoryStore();
    const orchestrator = new MultiAgentOrchestrator(store, { createChildSession: () => "child-timeout", execute: async (input) => { input.onRunStarted("run-timeout"); return new Promise((_resolve, reject) => input.signal?.addEventListener("abort", () => reject(new Error("timeout")), { once: true })); } }, roleRegistry());
    const [result] = await orchestrator.delegate({ projectId: "p", parentRunId: "parent", mode: "single", budget: { maxDurationMs: 5 }, contextManifest: { projectId: "p", projectBriefRevision: "v1", researchEntityIds: [], sourceUris: [], projectionHash: "hash" }, tasks: [{ roleId: "research-explorer", objective: "执行超时测试" }] });
    expect(result?.status).toBe("cancelled");
  });

  it("honours dependsOn as a real DAG: parallel siblings, skipped dependants and dependency summaries", async () => {
    const store = new MemoryStore();
    const order: string[] = [];
    let active = 0; let peak = 0;
    const objectives = new Map<string, string>();
    let failFirst = true;
    const orchestrator = new MultiAgentOrchestrator(store, {
      createChildSession: () => `child-${order.length}`,
      async execute(input) {
        input.onRunStarted(`run-${input.childSessionId}`);
        active += 1; peak = Math.max(peak, active);
        order.push(input.objective);
        objectives.set(input.objective, input.objective);
        await new Promise((resolve) => setTimeout(resolve, 4));
        active -= 1;
        if (input.objective.startsWith("先失败任务") && failFirst) { failFirst = false; return { status: "failed", summary: "", sourceUris: [], artifactUris: [], limitations: [], error: "boom" }; }
        return { status: "completed", ...extractTaskResultText(JSON.stringify({ summary: `完成 ${input.objective}`, sourceUris: [], artifactUris: [], limitations: [] })) };
      },
    }, roleRegistry(), { maxConcurrency: 2 });
    const manifest = { projectId: "p", projectBriefRevision: "v1", researchEntityIds: [], sourceUris: [], projectionHash: "hash" };
    const diamond = await orchestrator.delegate({
      projectId: "p", parentRunId: "parent", mode: "chain", contextManifest: manifest,
      tasks: [
        { roleId: "research-explorer", objective: "根任务" },
        { roleId: "domain-executor", objective: "分支一", dependsOn: [0] },
        { roleId: "research-explorer", objective: "分支二", dependsOn: [0] },
        { roleId: "independent-reviewer", objective: "汇总", dependsOn: [1, 2] },
      ],
    });
    expect(diamond.every((result) => result.status === "completed")).toBe(true);
    expect(peak).toBe(2); // the two siblings ran concurrently after the root
    const rootAt = order.findIndex((entry) => entry.startsWith("根任务"));
    const branchOneAt = order.findIndex((entry) => entry.startsWith("分支一"));
    const branchTwoAt = order.findIndex((entry) => entry.startsWith("分支二"));
    const summaryAt = order.findIndex((entry) => entry.startsWith("汇总"));
    expect(rootAt).toBeGreaterThanOrEqual(0);
    expect(branchOneAt).toBeGreaterThan(rootAt);
    expect(branchTwoAt).toBeGreaterThan(rootAt);
    expect(summaryAt).toBeGreaterThan(branchOneAt);
    expect(summaryAt).toBeGreaterThan(branchTwoAt);

    const skipped = await orchestrator.delegate({
      projectId: "p", parentRunId: "parent-2", mode: "chain", contextManifest: manifest,
      tasks: [
        { roleId: "research-explorer", objective: "先失败任务" },
        { roleId: "domain-executor", objective: "被阻塞的后续", dependsOn: [0] },
      ],
    });
    expect(skipped[0]?.status).toBe("failed");
    expect(skipped[1]?.status).toBe("failed");
    expect(skipped[1]?.error).toContain("dependency did not complete");
    await expect(orchestrator.delegate({
      projectId: "p", parentRunId: "parent-3", mode: "chain", contextManifest: manifest,
      tasks: [{ roleId: "research-explorer", objective: "非法依赖" }, { roleId: "domain-executor", objective: "x", dependsOn: [1] }],
    })).rejects.toThrow("must reference an earlier task");
  });
});
