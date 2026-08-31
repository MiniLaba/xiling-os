import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DockerSandboxPolicy, ExecutionCoordinator, InMemoryExecutionRepository, SqliteExecutionRepository, dockerSandboxArgs, executionPlanHash, materializeExecution, type ExecutionPlan } from "./index.js";

const plan: ExecutionPlan = { projectId: "p1", recipe: { id: "statistics.summary", version: "1.0.0" }, inputSelectors: { dataset: "approved-dataset-snapshot" }, code: { uri: "artifact://sha256/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", sha256: "b".repeat(64) }, parameters: { alpha: 0.05, columns: ["x", "y"] }, randomSeed: 42, environment: { imageDigest: `sha256:${"c".repeat(64)}` }, resources: { cpu: 1, memoryBytes: 512_000_000, timeoutMs: 1_000 }, network: { mode: "none" } };
const spec = materializeExecution(plan, [{ name: "data", uri: "artifact://sha256/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", sha256: "a".repeat(64) }]);

describe("discipline-neutral execution kernel", () => {
  it("builds a least-privilege Docker sandbox envelope", () => {
    const policy: DockerSandboxPolicy = { network: "none", cpu: 2, memoryBytes: 4 * 1024 ** 3 };
    const args = dockerSandboxArgs(policy);
    expect(args).toEqual(expect.arrayContaining([
      "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
      "--pids-limit", "256", "--ipc", "none", "--user", "10001:10001",
    ]));
    expect(args.join(" ")).toContain("/tmp:rw,noexec,nosuid,nodev");
  });

  it("rejects an unbounded or unusable sandbox policy", () => {
    expect(() => dockerSandboxArgs({ network: "egress", cpu: 0, memoryBytes: 512 * 1024 ** 2 })).toThrow("CPU");
    expect(() => dockerSandboxArgs({ network: "egress", cpu: 1, memoryBytes: 64 * 1024 ** 2 })).toThrow("memory");
  });

  it("binds approval to a canonical spec and deduplicates retries", async () => {
    let calls = 0;
    const coordinator = new ExecutionCoordinator(new InMemoryExecutionRepository(), { execute: async () => { calls += 1; return { outputs: [], exitCode: 0, environmentDigest: "sha256:fixture", startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:01Z" }; } });
    const approval = { id: "approval-1", projectId: "p1", planHash: executionPlanHash(plan), approvedAt: "2026-01-01T00:00:00Z" };
    expect((await coordinator.run(spec, approval, "operation-1")).status).toBe("succeeded");
    expect((await coordinator.run(spec, approval, "operation-1")).status).toBe("succeeded");
    expect(calls).toBe(1);
    const changed = materializeExecution({ ...plan, randomSeed: 7 }, spec.inputs);
    await expect(coordinator.run(changed, approval, "operation-2")).rejects.toThrow("does not match");
  });

  it("cancels timed-out runs through the application token", async () => {
    const coordinator = new ExecutionCoordinator(new InMemoryExecutionRepository(), { execute: (_spec, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })) });
    const shortPlan = { ...plan, resources: { ...plan.resources, timeoutMs: 5 } }; const short = materializeExecution(shortPlan, spec.inputs);
    const result = await coordinator.run(short, { id: "approval-2", projectId: "p1", planHash: executionPlanHash(shortPlan), approvedAt: "2026-01-01T00:00:00Z" }, "operation-timeout");
    expect(result.status).toBe("cancelled");
  });

  it("recovers the idempotency receipt from SQLite after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "xiling-execution-")); const path = join(root, "executions.sqlite");
    const first = new SqliteExecutionRepository(path); first.save({ id: "execution-1", projectId: "p1", idempotencyKey: "retry-1", specHash: "hash", status: "succeeded", createdAt: "2026-01-01T00:00:00Z" }); first.close();
    const restored = new SqliteExecutionRepository(path); expect(restored.getByKey("p1", "retry-1")).toMatchObject({ id: "execution-1", status: "succeeded" }); restored.close();
  });
});
