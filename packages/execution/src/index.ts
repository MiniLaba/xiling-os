import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ResourceUri } from "@xiling/contracts";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface ExecutionPlan {
  projectId: string;
  recipe: { id: string; version: string };
  inputSelectors: Record<string, JsonValue>;
  code: { uri: ResourceUri; sha256: string };
  parameters: Record<string, JsonValue>;
  randomSeed: number;
  environment: { imageDigest: string; lockUri?: ResourceUri };
  resources: { cpu: number; memoryBytes: number; timeoutMs: number };
  network: { mode: "none" | "allowlist"; hosts?: string[] };
}
export interface ExecutionSpec extends Omit<ExecutionPlan, "inputSelectors"> { planHash: string; inputs: Array<{ name: string; uri: ResourceUri; sha256: string }>; }
export interface ApprovalReceipt { id: string; projectId: string; planHash: string; approvedAt: string; expiresAt?: string; }
export interface ExecutionOutput { name: string; path: string; mimeType: string; kind: string; artifactUri?: ResourceUri; }
export interface ExecutionResult { outputs: ExecutionOutput[]; exitCode: number; startedAt: string; finishedAt: string; environmentDigest: string; logPath?: string; }
export interface ExecutionRecord { id: string; projectId: string; specHash: string; idempotencyKey: string; status: "queued" | "running" | "succeeded" | "failed" | "cancelled"; createdAt: string; startedAt?: string; finishedAt?: string; result?: ExecutionResult; error?: string; }
export interface ExecutionRunner { execute(spec: ExecutionSpec, signal: AbortSignal): Promise<ExecutionResult>; }
export interface ExecutionRepository { getByKey(projectId: string, idempotencyKey: string): ExecutionRecord | undefined; save(record: ExecutionRecord): void; }

export interface DockerSandboxPolicy {
  network: "none" | "egress";
  cpu: number;
  memoryBytes: number;
  pidsLimit?: number;
  tmpBytes?: number;
  user?: `${number}:${number}`;
}

/**
 * Builds the mandatory isolation envelope shared by every scientific Docker
 * runner. Workspace write access is intentionally supplied by the caller so
 * the policy can become read-only later without coupling it to data layout.
 */
export function dockerSandboxArgs(policy: DockerSandboxPolicy): string[] {
  if (!Number.isFinite(policy.cpu) || policy.cpu <= 0 || policy.cpu > 64) throw new Error("Sandbox CPU limit must be between 0 and 64");
  if (!Number.isSafeInteger(policy.memoryBytes) || policy.memoryBytes < 128 * 1024 * 1024) throw new Error("Sandbox memory limit must be at least 128 MiB");
  const pidsLimit = policy.pidsLimit ?? 256;
  const tmpBytes = policy.tmpBytes ?? 256 * 1024 * 1024;
  if (!Number.isSafeInteger(pidsLimit) || pidsLimit < 16 || pidsLimit > 4096) throw new Error("Sandbox PID limit is invalid");
  if (!Number.isSafeInteger(tmpBytes) || tmpBytes < 16 * 1024 * 1024) throw new Error("Sandbox tmpfs limit is invalid");
  return [
    "--network", policy.network === "none" ? "none" : "bridge",
    "--memory", String(policy.memoryBytes),
    "--cpus", String(policy.cpu),
    "--pids-limit", String(pidsLimit),
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true",
    "--ipc", "none",
    "--ulimit", "nofile=1024:1024",
    "--tmpfs", `/tmp:rw,noexec,nosuid,nodev,size=${tmpBytes}`,
    "--user", policy.user ?? "10001:10001",
    "--label", "org.xiling.sandbox=true",
  ];
}

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(",")}}`;
}
export function executionSpecHash(spec: ExecutionSpec): string { return createHash("sha256").update(canonical(spec as unknown as JsonValue)).digest("hex"); }
export function executionPlanHash(plan: ExecutionPlan): string { return createHash("sha256").update(canonical(plan as unknown as JsonValue)).digest("hex"); }
export function materializeExecution(plan: ExecutionPlan, inputs: ExecutionSpec["inputs"]): ExecutionSpec { return { projectId: plan.projectId, recipe: plan.recipe, inputs, code: plan.code, parameters: plan.parameters, randomSeed: plan.randomSeed, environment: plan.environment, resources: plan.resources, network: plan.network, planHash: executionPlanHash(plan) }; }

export class InMemoryExecutionRepository implements ExecutionRepository {
  private readonly records = new Map<string, ExecutionRecord>();
  getByKey(projectId: string, idempotencyKey: string) { const value = this.records.get(`${projectId}:${idempotencyKey}`); return value ? structuredClone(value) : undefined; }
  save(record: ExecutionRecord) { this.records.set(`${record.projectId}:${record.idempotencyKey}`, structuredClone(record)); }
}

export class SqliteExecutionRepository implements ExecutionRepository {
  private readonly database: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true }); this.database = new DatabaseSync(path);
    this.database.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS executions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, spec_hash TEXT NOT NULL, payload_json TEXT NOT NULL, UNIQUE(project_id, idempotency_key));`);
  }
  getByKey(projectId: string, idempotencyKey: string) { const row = this.database.prepare("SELECT payload_json FROM executions WHERE project_id = ? AND idempotency_key = ?").get(projectId, idempotencyKey) as { payload_json: string } | undefined; return row ? JSON.parse(row.payload_json) as ExecutionRecord : undefined; }
  save(record: ExecutionRecord) { this.database.prepare(`INSERT INTO executions (id, project_id, idempotency_key, spec_hash, payload_json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id, idempotency_key) DO UPDATE SET spec_hash = excluded.spec_hash, payload_json = excluded.payload_json`).run(record.id, record.projectId, record.idempotencyKey, record.specHash, JSON.stringify(record)); }
  close() { this.database.close(); }
}

export class ExecutionCoordinator {
  private readonly active = new Map<string, AbortController>();
  constructor(private readonly repository: ExecutionRepository, private readonly runner: ExecutionRunner, private readonly now = () => new Date().toISOString()) {}
  getByKey(projectId: string, idempotencyKey: string): ExecutionRecord | undefined { return this.repository.getByKey(projectId, idempotencyKey); }
  async run(spec: ExecutionSpec, approval: ApprovalReceipt, idempotencyKey: string): Promise<ExecutionRecord> {
    const specHash = executionSpecHash(spec);
    if (approval.projectId !== spec.projectId || approval.planHash !== spec.planHash) throw new Error("Approval Receipt does not match the execution plan");
    if (approval.expiresAt && approval.expiresAt <= this.now()) throw new Error("Approval Receipt has expired");
    const existing = this.repository.getByKey(spec.projectId, idempotencyKey);
    if (existing) {
      if (existing.specHash !== specHash) throw new Error("Execution idempotency conflict");
      return existing;
    }
    const record: ExecutionRecord = { id: `execution-${randomUUID()}`, projectId: spec.projectId, specHash, idempotencyKey, status: "running", createdAt: this.now(), startedAt: this.now() };
    this.repository.save(record);
    const controller = new AbortController(); this.active.set(record.id, controller);
    const timeout = setTimeout(() => controller.abort("execution timeout"), spec.resources.timeoutMs);
    try {
      const result = await this.runner.execute(spec, controller.signal);
      const finished: ExecutionRecord = { ...record, status: "succeeded", result, finishedAt: result.finishedAt }; this.repository.save(finished); return finished;
    } catch (error) {
      const failed: ExecutionRecord = { ...record, status: controller.signal.aborted ? "cancelled" : "failed", finishedAt: this.now(), error: error instanceof Error ? error.message : String(error) }; this.repository.save(failed); return failed;
    } finally { clearTimeout(timeout); this.active.delete(record.id); }
  }
  cancel(id: string): boolean { const controller = this.active.get(id); if (!controller) return false; controller.abort("cancelled by user"); return true; }
}
