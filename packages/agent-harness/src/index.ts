import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { estimateTextTokens as estimateTextTokensShared, type AgentInputAttachment, type AgentStreamEvent } from "@xiling/contracts";

export const AGENT_SESSION_FORMAT_VERSION = 1;
export const AGENT_STORE_SCHEMA_VERSION = 6;

export type AgentSessionStatus = "active" | "archived";
export type AgentRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "suspended";
export type AgentOperationStatus = "running" | "completed" | "failed" | "cancelled" | "suspended";
export type AgentEntryKind = "user" | "assistant" | "tool-call" | "tool-result" | "compaction";

export interface AgentSessionRecord {
  id: string;
  projectId: string;
  status: AgentSessionStatus;
  formatVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRunRecord {
  id: string;
  sessionId: string;
  clientCommandId: string;
  prompt: string;
  attachments?: AgentInputAttachment[];
  context?: unknown;
  status: AgentRunStatus;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface AgentOperationRecord {
  id: string;
  runId: string;
  sequence: number;
  kind: "model" | "tool" | "recovery" | "cancel";
  status: AgentOperationStatus;
  name: string;
  callId?: string;
  request?: unknown;
  result?: unknown;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface AgentSessionEntry {
  id: string;
  sessionId: string;
  runId: string;
  sequence: number;
  kind: AgentEntryKind;
  role?: "user" | "assistant" | "tool" | "system";
  text: string;
  metadata?: unknown;
  createdAt: string;
}

export interface AgentInputAttachmentRecord extends AgentInputAttachment {
  projectId: string;
  data: Uint8Array;
  createdAt: string;
}

export interface AgentUsageRecord {
  id: string;
  sessionId: string;
  runId: string;
  operationId?: string;
  sequence: number;
  providerId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  cost: number;
  createdAt: string;
}

export interface AgentCompactionRecord {
  id: string;
  sessionId: string;
  runId: string;
  coveredThroughSequence: number;
  retainedFromSequence: number;
  summary: string;
  sourceHash: string;
  model: string;
  usage: AgentUsageTotals;
  reason: string;
  createdAt: string;
}

export interface AgentRunEvent {
  sequence: number;
  runId: string;
  sessionId: string;
  type: string;
  payload: unknown;
  createdAt: string;
}

export interface AgentUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  cost: number;
}

export interface AgentRunSnapshot {
  session: AgentSessionRecord;
  run: AgentRunRecord;
  operations: AgentOperationRecord[];
  entries: AgentSessionEntry[];
  usage: AgentUsageRecord[];
  usageTotals: AgentUsageTotals;
  events: AgentRunEvent[];
  compactions: AgentCompactionRecord[];
  lastSequence: number;
  recovery: { resumable: boolean; strategy?: "restart-interrupted-turn" };
}

export type AgentDelegationStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "suspended";

export interface AgentDelegationRecord {
  id: string;
  projectId: string;
  rootRunId: string;
  parentRunId: string;
  childSessionId: string;
  childRunId?: string;
  roleId: string;
  objective: string;
  isolation: "scoped" | "blind" | "execution";
  contextManifestHash: string;
  contextManifest: unknown;
  budget: unknown;
  status: AgentDelegationStatus;
  result?: unknown;
  error?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface RuntimeUsageInput extends AgentUsageTotals {
  providerId: string;
  modelId: string;
}

export interface HarnessRuntime {
  subscribe(listener: (event: AgentStreamEvent) => void | Promise<void>): () => void;
  prompt(text: string): Promise<void>;
  abort(): void;
  /** False when the route's pricing is unknown (custom/uncatalogued model);
   * the harness then lets the cost guard rail degrade to tool-call/duration. */
  costAccountingKnown?: boolean;
}

export interface HarnessRuntimeFactory {
  create(input: {
    sessionId: string;
    runId: string;
    prompt: string;
    attachments: AgentInputAttachment[];
    commandContext?: unknown;
    history: Array<{ id: string; role: "user" | "assistant"; text: string; timestamp: number; attachments?: AgentInputAttachment[] }>;
    onUsage(usage: RuntimeUsageInput): void | Promise<void>;
  }): HarnessRuntime | Promise<HarnessRuntime>;
}

export interface StartAgentTurn {
  sessionId: string;
  prompt: string;
  attachments?: Array<AgentInputAttachment & { data: Uint8Array }>;
  clientCommandId: string;
  context?: unknown;
}

export interface ResearchAgentHarnessOptions {
  maxRunMs?: number;
  maxToolCalls?: number;
  maxRepeatedToolSignature?: number;
  maxRunCost?: number;
  compaction?: {
    maxEntries: number;
    retainEntries: number;
    maxEstimatedTokens?: number;
    maxEstimatedChars?: number;
    summarize(
      entries: AgentSessionEntry[],
      context: {
        previousCompaction?: AgentCompactionRecord;
        estimatedChars: number;
        estimatedTokens: number;
        coveredThroughSequence: number;
      },
    ): Promise<{ summary: string; model: string; usage: AgentUsageTotals; cumulative?: boolean }>;
  };
}

const isoNow = () => new Date().toISOString();
const parseJson = (value: string | null): unknown => value ? JSON.parse(value) as unknown : undefined;

const migrations = [{
  version: 1,
  sql: `
    CREATE TABLE IF NOT EXISTS agent_sessions (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, status TEXT NOT NULL, format_version INTEGER NOT NULL,
      writer_run_id TEXT, writer_expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES agent_sessions(id), client_command_id TEXT NOT NULL,
      prompt TEXT NOT NULL, status TEXT NOT NULL, error TEXT, started_at TEXT NOT NULL, finished_at TEXT,
      UNIQUE(session_id, client_command_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_one_active_writer ON agent_runs(session_id)
      WHERE status IN ('queued', 'running');
    CREATE TABLE IF NOT EXISTS agent_operations (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES agent_runs(id), sequence INTEGER NOT NULL,
      kind TEXT NOT NULL, status TEXT NOT NULL, name TEXT NOT NULL, call_id TEXT, request_json TEXT,
      result_json TEXT, error TEXT, started_at TEXT NOT NULL, finished_at TEXT, UNIQUE(run_id, sequence)
    );
    CREATE TABLE IF NOT EXISTS agent_entries (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES agent_sessions(id), run_id TEXT NOT NULL REFERENCES agent_runs(id),
      sequence INTEGER NOT NULL, kind TEXT NOT NULL, role TEXT, text TEXT NOT NULL, metadata_json TEXT,
      created_at TEXT NOT NULL, UNIQUE(session_id, sequence)
    );
    CREATE TABLE IF NOT EXISTS agent_usage (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES agent_sessions(id), run_id TEXT NOT NULL REFERENCES agent_runs(id),
      operation_id TEXT, sequence INTEGER NOT NULL, provider_id TEXT NOT NULL, model_id TEXT NOT NULL,
      input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL,
      cache_write_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL, total_tokens INTEGER NOT NULL,
      cost REAL NOT NULL, created_at TEXT NOT NULL, UNIQUE(run_id, sequence)
    );
    CREATE TABLE IF NOT EXISTS agent_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES agent_sessions(id),
      run_id TEXT NOT NULL REFERENCES agent_runs(id), sequence INTEGER NOT NULL, type TEXT NOT NULL,
      payload_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(run_id, sequence)
    );
    CREATE TABLE IF NOT EXISTS agent_compactions (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES agent_sessions(id), run_id TEXT NOT NULL REFERENCES agent_runs(id),
      covered_through_sequence INTEGER NOT NULL, retained_from_sequence INTEGER NOT NULL, summary TEXT NOT NULL,
      source_hash TEXT NOT NULL, model TEXT NOT NULL, usage_json TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agent_entries_session_sequence ON agent_entries(session_id, sequence);
    CREATE INDEX IF NOT EXISTS agent_events_run_sequence ON agent_events(run_id, sequence);
    CREATE INDEX IF NOT EXISTS agent_operations_run_sequence ON agent_operations(run_id, sequence);
  `,
}, {
  version: 2,
  sql: `ALTER TABLE agent_runs ADD COLUMN context_json TEXT;`,
}, {
  version: 3,
  sql: `
    CREATE TABLE IF NOT EXISTS agent_legacy_message_map (
      session_id TEXT NOT NULL REFERENCES agent_sessions(id),
      legacy_message_id TEXT NOT NULL,
      entry_id TEXT NOT NULL UNIQUE REFERENCES agent_entries(id),
      created_at TEXT NOT NULL,
      PRIMARY KEY(session_id, legacy_message_id)
    );
    CREATE INDEX IF NOT EXISTS agent_legacy_message_entry ON agent_legacy_message_map(entry_id);
  `,
}, {
  version: 4,
  sql: `
    CREATE TABLE IF NOT EXISTS agent_input_attachments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      modality TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      data BLOB NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_run_attachments (
      run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      attachment_id TEXT NOT NULL REFERENCES agent_input_attachments(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      PRIMARY KEY(run_id, attachment_id),
      UNIQUE(run_id, sequence)
    );
    CREATE INDEX IF NOT EXISTS agent_input_attachments_project ON agent_input_attachments(project_id, created_at);
  `,
}, {
  version: 5,
  sql: `
    CREATE TABLE IF NOT EXISTS agent_delegations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      root_run_id TEXT NOT NULL REFERENCES agent_runs(id),
      parent_run_id TEXT NOT NULL REFERENCES agent_runs(id),
      child_session_id TEXT NOT NULL REFERENCES agent_sessions(id),
      child_run_id TEXT REFERENCES agent_runs(id),
      role_id TEXT NOT NULL,
      objective TEXT NOT NULL,
      isolation TEXT NOT NULL,
      context_manifest_hash TEXT NOT NULL,
      context_manifest_json TEXT NOT NULL,
      budget_json TEXT NOT NULL,
      status TEXT NOT NULL,
      result_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS agent_delegations_project_created ON agent_delegations(project_id, created_at);
    CREATE INDEX IF NOT EXISTS agent_delegations_parent_run ON agent_delegations(parent_run_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS agent_delegations_child_session ON agent_delegations(child_session_id);
    CREATE UNIQUE INDEX IF NOT EXISTS agent_delegations_child_run ON agent_delegations(child_run_id) WHERE child_run_id IS NOT NULL;
  `,
}, {
  version: 6,
  sql: `
    CREATE TABLE IF NOT EXISTS projection_cursors (
      name TEXT PRIMARY KEY,
      last_event_id INTEGER NOT NULL
    );
  `,
}];

export class SqliteAgentSessionStore {
  private readonly sqlite: DatabaseSync;
  private closed = false;

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.sqlite = new DatabaseSync(path);
    try {
      this.sqlite.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
      this.migrate();
    } catch (error) {
      // Never leak the handle when a migration rejects (e.g. a newer database
      // version than this build supports).
      try { this.sqlite.close(); } catch { /* already closed */ }
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.sqlite.close();
  }

  private backupBeforeMigration(current: number): void {
    if (current >= AGENT_STORE_SCHEMA_VERSION) return;
    const path = this.path;
    if (!existsSync(path)) return;
    const backupDir = join(dirname(path), "backups");
    mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const base = basename(path);
    for (const suffix of ["", "-wal", "-shm"] as const) {
      const source = `${path}${suffix}`;
      if (existsSync(source)) copyFileSync(source, join(backupDir, `${base}${suffix}.${stamp}.bak`));
    }
    // Match every `<base>*.bak` variant (main, -wal, -shm) when trimming retention.
    const backups = readdirSync(backupDir).filter((name) => name.startsWith(base) && name.endsWith(".bak")).sort();
    for (const name of backups.slice(0, Math.max(0, backups.length - 5))) rmSync(join(backupDir, name));
  }

  private migrate(): void {
    const row = this.sqlite.prepare("PRAGMA user_version").get() as { user_version: number };
    let current = row.user_version;
    if (current > AGENT_STORE_SCHEMA_VERSION) throw new Error(`Agent store version ${current} is newer than supported ${AGENT_STORE_SCHEMA_VERSION}`);
    this.backupBeforeMigration(current);
    for (const migration of migrations) {
      if (migration.version <= current) continue;
      this.transaction(() => {
        this.sqlite.exec(migration.sql);
        this.sqlite.exec(`PRAGMA user_version = ${migration.version}`);
      });
      current = migration.version;
    }
  }

  private transaction<T>(operation: () => T): T {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      this.sqlite.exec("COMMIT");
      return value;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  private next(table: "agent_entries" | "agent_operations" | "agent_usage" | "agent_events", parentColumn: "session_id" | "run_id", parentId: string): number {
    const row = this.sqlite.prepare(`SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM ${table} WHERE ${parentColumn} = ?`).get(parentId) as { sequence: number };
    return row.sequence;
  }

  createSession(input: { id?: string; projectId: string }): AgentSessionRecord {
    const existing = input.id ? this.getSession(input.id) : undefined;
    if (existing) {
      if (existing.projectId !== input.projectId) throw new Error("Agent session project mismatch");
      return existing;
    }
    const timestamp = isoNow();
    const record: AgentSessionRecord = { id: input.id ?? randomUUID(), projectId: input.projectId, status: "active", formatVersion: AGENT_SESSION_FORMAT_VERSION, createdAt: timestamp, updatedAt: timestamp };
    this.sqlite.prepare("INSERT INTO agent_sessions (id, project_id, status, format_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(record.id, record.projectId, record.status, record.formatVersion, record.createdAt, record.updatedAt);
    return record;
  }

  getSession(id: string): AgentSessionRecord | undefined {
    const row = this.sqlite.prepare("SELECT id, project_id, status, format_version, created_at, updated_at FROM agent_sessions WHERE id = ?").get(id) as { id: string; project_id: string; status: AgentSessionStatus; format_version: number; created_at: string; updated_at: string } | undefined;
    return row ? { id: row.id, projectId: row.project_id, status: row.status, formatVersion: row.format_version, createdAt: row.created_at, updatedAt: row.updated_at } : undefined;
  }

  listProjectSessions(projectId: string): AgentSessionRecord[] {
    const rows = this.sqlite.prepare("SELECT id FROM agent_sessions WHERE project_id = ? ORDER BY updated_at DESC, created_at DESC").all(projectId) as Array<{ id: string }>;
    return rows.map((row) => this.getSession(row.id)).filter((session): session is AgentSessionRecord => Boolean(session));
  }

  archiveSession(id: string): AgentSessionRecord | undefined {
    const session = this.getSession(id);
    if (!session) return undefined;
    if (session.status !== "archived") {
      this.sqlite.prepare("UPDATE agent_sessions SET status = 'archived', writer_run_id = NULL, writer_expires_at = NULL, updated_at = ? WHERE id = ?").run(isoNow(), id);
    }
    return this.getSession(id);
  }

  listSessionRuns(sessionId: string): AgentRunRecord[] {
    const rows = this.sqlite.prepare("SELECT id FROM agent_runs WHERE session_id = ? ORDER BY started_at").all(sessionId) as Array<{ id: string }>;
    return rows.map((row) => this.getRun(row.id)).filter((run): run is AgentRunRecord => Boolean(run));
  }

  createDelegation(input: Omit<AgentDelegationRecord, "createdAt" | "status"> & { status?: AgentDelegationStatus }): AgentDelegationRecord {
    const parent = this.getRun(input.parentRunId);
    const root = this.getRun(input.rootRunId);
    const child = this.getSession(input.childSessionId);
    const parentSession = parent ? this.getSession(parent.sessionId) : undefined;
    if (!parent || !root || !child || !parentSession) throw new Error("Delegation lineage references missing Agent records");
    if (parentSession.projectId !== input.projectId || child.projectId !== input.projectId) throw new Error("Delegation project mismatch");
    const record: AgentDelegationRecord = { ...input, status: input.status ?? "queued", createdAt: isoNow() };
    this.sqlite.prepare(`INSERT INTO agent_delegations (
      id, project_id, root_run_id, parent_run_id, child_session_id, child_run_id, role_id, objective,
      isolation, context_manifest_hash, context_manifest_json, budget_json, status, result_json, error,
      created_at, started_at, finished_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.id, record.projectId, record.rootRunId, record.parentRunId, record.childSessionId, record.childRunId ?? null,
        record.roleId, record.objective, record.isolation, record.contextManifestHash, JSON.stringify(record.contextManifest),
        JSON.stringify(record.budget), record.status, record.result === undefined ? null : JSON.stringify(record.result),
        record.error ?? null, record.createdAt, record.startedAt ?? null, record.finishedAt ?? null);
    return record;
  }

  updateDelegation(id: string, input: { status: AgentDelegationStatus; childRunId?: string; result?: unknown; error?: string }): AgentDelegationRecord {
    const existing = this.getDelegation(id);
    if (!existing) throw new Error("Agent delegation not found");
    const timestamp = isoNow();
    const terminal = ["completed", "failed", "cancelled"].includes(input.status);
    this.sqlite.prepare(`UPDATE agent_delegations SET status = ?, child_run_id = COALESCE(?, child_run_id),
      result_json = ?, error = ?, started_at = COALESCE(started_at, ?), finished_at = ? WHERE id = ?`)
      .run(input.status, input.childRunId ?? null, input.result === undefined ? null : JSON.stringify(input.result), input.error ?? null,
        input.status === "running" || terminal ? timestamp : null, terminal ? timestamp : null, id);
    return this.getDelegation(id)!;
  }

  getDelegation(id: string): AgentDelegationRecord | undefined {
    const row = this.sqlite.prepare("SELECT * FROM agent_delegations WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.mapDelegation(row) : undefined;
  }

  listProjectDelegations(projectId: string): AgentDelegationRecord[] {
    const rows = this.sqlite.prepare("SELECT * FROM agent_delegations WHERE project_id = ? ORDER BY created_at").all(projectId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapDelegation(row));
  }

  listRunDelegations(parentRunId: string): AgentDelegationRecord[] {
    const rows = this.sqlite.prepare("SELECT * FROM agent_delegations WHERE parent_run_id = ? ORDER BY created_at").all(parentRunId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapDelegation(row));
  }

  private mapDelegation(row: Record<string, unknown>): AgentDelegationRecord {
    return {
      id: row.id as string, projectId: row.project_id as string, rootRunId: row.root_run_id as string,
      parentRunId: row.parent_run_id as string, childSessionId: row.child_session_id as string,
      ...(row.child_run_id ? { childRunId: row.child_run_id as string } : {}), roleId: row.role_id as string,
      objective: row.objective as string, isolation: row.isolation as AgentDelegationRecord["isolation"],
      contextManifestHash: row.context_manifest_hash as string, contextManifest: JSON.parse(row.context_manifest_json as string) as unknown,
      budget: JSON.parse(row.budget_json as string) as unknown, status: row.status as AgentDelegationStatus,
      ...(row.result_json ? { result: JSON.parse(row.result_json as string) as unknown } : {}),
      ...(row.error ? { error: row.error as string } : {}), createdAt: row.created_at as string,
      ...(row.started_at ? { startedAt: row.started_at as string } : {}), ...(row.finished_at ? { finishedAt: row.finished_at as string } : {}),
    };
  }

  getRunAttachments(runId: string): AgentInputAttachment[] {
    const rows = this.sqlite.prepare(`
      SELECT attachment.id, attachment.name, attachment.modality, attachment.mime_type, attachment.size, attachment.sha256
      FROM agent_run_attachments link
      JOIN agent_input_attachments attachment ON attachment.id = link.attachment_id
      WHERE link.run_id = ? ORDER BY link.sequence
    `).all(runId) as Array<{ id: string; name: string; modality: "image"; mime_type: string; size: number; sha256: string }>;
    return rows.map((row) => ({ id: row.id, name: row.name, modality: row.modality, mimeType: row.mime_type, size: row.size, sha256: row.sha256 }));
  }

  getAttachment(id: string): AgentInputAttachmentRecord | undefined {
    const row = this.sqlite.prepare("SELECT id, project_id, name, modality, mime_type, size, sha256, data, created_at FROM agent_input_attachments WHERE id = ?").get(id) as { id: string; project_id: string; name: string; modality: "image"; mime_type: string; size: number; sha256: string; data: Uint8Array; created_at: string } | undefined;
    return row ? { id: row.id, projectId: row.project_id, name: row.name, modality: row.modality, mimeType: row.mime_type, size: row.size, sha256: row.sha256, data: row.data, createdAt: row.created_at } : undefined;
  }

  startRun(input: StartAgentTurn): { run: AgentRunRecord; created: boolean } {
    const duplicate = this.sqlite.prepare("SELECT id FROM agent_runs WHERE session_id = ? AND client_command_id = ?").get(input.sessionId, input.clientCommandId) as { id: string } | undefined;
    if (duplicate) {
      const run = this.getRun(duplicate.id)!;
      const attachmentDescriptors = (input.attachments ?? []).map(({ data: _data, ...attachment }) => attachment);
      if (run.prompt !== input.prompt || JSON.stringify(run.context ?? null) !== JSON.stringify(input.context ?? null) || JSON.stringify(run.attachments ?? []) !== JSON.stringify(attachmentDescriptors)) throw new Error("clientCommandId payload mismatch");
      return { run, created: false };
    }
    const timestamp = isoNow();
    const attachmentDescriptors = (input.attachments ?? []).map(({ data: _data, ...attachment }) => attachment);
    const run: AgentRunRecord = { id: randomUUID(), sessionId: input.sessionId, clientCommandId: input.clientCommandId, prompt: input.prompt, ...(attachmentDescriptors.length ? { attachments: attachmentDescriptors } : {}), ...(input.context === undefined ? {} : { context: input.context }), status: "queued", startedAt: timestamp };
    this.transaction(() => {
      const session = this.getSession(input.sessionId);
      if (!session || session.status !== "active") throw new Error("Agent session is missing or archived");
      this.sqlite.prepare("INSERT INTO agent_runs (id, session_id, client_command_id, prompt, context_json, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(run.id, run.sessionId, run.clientCommandId, run.prompt, run.context === undefined ? null : JSON.stringify(run.context), run.status, run.startedAt);
      const insertAttachment = this.sqlite.prepare("INSERT INTO agent_input_attachments (id, project_id, name, modality, mime_type, size, sha256, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
      const linkAttachment = this.sqlite.prepare("INSERT INTO agent_run_attachments (run_id, attachment_id, sequence) VALUES (?, ?, ?)");
      for (const [index, attachment] of (input.attachments ?? []).entries()) {
        const bytes = Buffer.from(attachment.data);
        if (bytes.byteLength !== attachment.size || createHash("sha256").update(bytes).digest("hex") !== attachment.sha256) throw new Error("Agent attachment integrity mismatch");
        insertAttachment.run(attachment.id, session.projectId, attachment.name, attachment.modality, attachment.mimeType, attachment.size, attachment.sha256, bytes, timestamp);
        linkAttachment.run(run.id, attachment.id, index + 1);
      }
      this.sqlite.prepare("UPDATE agent_sessions SET writer_run_id = ?, writer_expires_at = ?, updated_at = ? WHERE id = ?").run(run.id, new Date(Date.now() + 60 * 60_000).toISOString(), timestamp, run.sessionId);
    });
    return { run, created: true };
  }

  getRun(id: string): AgentRunRecord | undefined {
    const row = this.sqlite.prepare("SELECT id, session_id, client_command_id, prompt, context_json, status, error, started_at, finished_at FROM agent_runs WHERE id = ?").get(id) as { id: string; session_id: string; client_command_id: string; prompt: string; context_json: string | null; status: AgentRunStatus; error: string | null; started_at: string; finished_at: string | null } | undefined;
    if (!row) return undefined;
    const attachments = this.getRunAttachments(row.id);
    return { id: row.id, sessionId: row.session_id, clientCommandId: row.client_command_id, prompt: row.prompt, ...(attachments.length ? { attachments } : {}), ...(row.context_json ? { context: JSON.parse(row.context_json) as unknown } : {}), status: row.status, ...(row.error ? { error: row.error } : {}), startedAt: row.started_at, ...(row.finished_at ? { finishedAt: row.finished_at } : {}) };
  }

  transitionRun(id: string, status: AgentRunStatus, error?: string): AgentRunRecord {
    const terminal = ["completed", "failed", "cancelled"].includes(status);
    const timestamp = isoNow();
    this.transaction(() => {
      const run = this.getRun(id);
      if (!run) throw new Error("Agent run not found");
      this.sqlite.prepare("UPDATE agent_runs SET status = ?, error = ?, finished_at = ? WHERE id = ?").run(status, error ?? null, terminal ? timestamp : null, id);
      if (status === "running") this.sqlite.prepare("UPDATE agent_sessions SET writer_run_id = ?, writer_expires_at = ?, updated_at = ? WHERE id = ?").run(id, new Date(Date.now() + 60 * 60_000).toISOString(), timestamp, run.sessionId);
      if (terminal || status === "suspended") this.sqlite.prepare("UPDATE agent_sessions SET writer_run_id = NULL, writer_expires_at = NULL, updated_at = ? WHERE id = ? AND writer_run_id = ?").run(timestamp, run.sessionId, id);
    });
    return this.getRun(id)!;
  }

  appendOperation(runId: string, input: Omit<AgentOperationRecord, "id" | "runId" | "sequence" | "startedAt">): AgentOperationRecord {
    const sequence = this.next("agent_operations", "run_id", runId);
    const record: AgentOperationRecord = { id: randomUUID(), runId, sequence, ...input, startedAt: isoNow() };
    this.sqlite.prepare("INSERT INTO agent_operations (id, run_id, sequence, kind, status, name, call_id, request_json, result_json, error, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(record.id, runId, sequence, record.kind, record.status, record.name, record.callId ?? null, record.request === undefined ? null : JSON.stringify(record.request), record.result === undefined ? null : JSON.stringify(record.result), record.error ?? null, record.startedAt, record.finishedAt ?? null);
    return record;
  }

  finishOperation(id: string, status: AgentOperationStatus, input: { result?: unknown; error?: string } = {}): void {
    this.sqlite.prepare("UPDATE agent_operations SET status = ?, result_json = ?, error = ?, finished_at = ? WHERE id = ?").run(status, input.result === undefined ? null : JSON.stringify(input.result), input.error ?? null, isoNow(), id);
  }

  appendEntry(sessionId: string, runId: string, input: Omit<AgentSessionEntry, "id" | "sessionId" | "runId" | "sequence" | "createdAt">): AgentSessionEntry {
    const sequence = this.next("agent_entries", "session_id", sessionId);
    const record: AgentSessionEntry = { id: randomUUID(), sessionId, runId, sequence, ...input, createdAt: isoNow() };
    this.sqlite.prepare("INSERT INTO agent_entries (id, session_id, run_id, sequence, kind, role, text, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(record.id, sessionId, runId, sequence, record.kind, record.role ?? null, record.text, record.metadata === undefined ? null : JSON.stringify(record.metadata), record.createdAt);
    return record;
  }

  appendUsage(sessionId: string, runId: string, input: RuntimeUsageInput & { operationId?: string }): AgentUsageRecord {
    const sequence = this.next("agent_usage", "run_id", runId);
    const record: AgentUsageRecord = { id: randomUUID(), sessionId, runId, sequence, ...input, createdAt: isoNow() };
    this.sqlite.prepare("INSERT INTO agent_usage (id, session_id, run_id, operation_id, sequence, provider_id, model_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens, cost, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(record.id, sessionId, runId, record.operationId ?? null, sequence, record.providerId, record.modelId, record.inputTokens, record.outputTokens, record.cacheReadTokens, record.cacheWriteTokens, record.reasoningTokens, record.totalTokens, record.cost, record.createdAt);
    return record;
  }

  appendEvent(sessionId: string, runId: string, type: string, payload: unknown): AgentRunEvent {
    const sequence = this.next("agent_events", "run_id", runId);
    const event: AgentRunEvent = { sequence, sessionId, runId, type, payload, createdAt: isoNow() };
    this.sqlite.prepare("INSERT INTO agent_events (session_id, run_id, sequence, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(sessionId, runId, sequence, type, JSON.stringify(payload ?? null), event.createdAt);
    return event;
  }

  listEvents(runId: string, afterSequence = 0): AgentRunEvent[] {
    const rows = this.sqlite.prepare("SELECT session_id, run_id, sequence, type, payload_json, created_at FROM agent_events WHERE run_id = ? AND sequence > ? ORDER BY sequence").all(runId, afterSequence) as Array<{ session_id: string; run_id: string; sequence: number; type: string; payload_json: string; created_at: string }>;
    return rows.map((row) => ({ sessionId: row.session_id, runId: row.run_id, sequence: row.sequence, type: row.type, payload: JSON.parse(row.payload_json) as unknown, createdAt: row.created_at }));
  }

  lastEvent(runId: string): AgentRunEvent | undefined {
    const row = this.sqlite.prepare("SELECT session_id, run_id, sequence, type, payload_json, created_at FROM agent_events WHERE run_id = ? ORDER BY sequence DESC LIMIT 1").get(runId) as { session_id: string; run_id: string; sequence: number; type: string; payload_json: string; created_at: string } | undefined;
    return row ? { sessionId: row.session_id, runId: row.run_id, sequence: row.sequence, type: row.type, payload: JSON.parse(row.payload_json) as unknown, createdAt: row.created_at } : undefined;
  }

  findOperationByCallId(runId: string, callId: string): AgentOperationRecord | undefined {
    const row = this.sqlite.prepare("SELECT * FROM agent_operations WHERE run_id = ? AND call_id = ? ORDER BY sequence DESC LIMIT 1").get(runId, callId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return { id: row.id as string, runId: row.run_id as string, sequence: row.sequence as number, kind: row.kind as AgentOperationRecord["kind"], status: row.status as AgentOperationStatus, name: row.name as string, ...(row.call_id ? { callId: row.call_id as string } : {}), ...(row.request_json ? { request: parseJson(row.request_json as string) } : {}), ...(row.result_json ? { result: parseJson(row.result_json as string) } : {}), ...(row.error ? { error: row.error as string } : {}), startedAt: row.started_at as string, ...(row.finished_at ? { finishedAt: row.finished_at as string } : {}) };
  }

  listEventsByType(types: string[]): AgentRunEvent[] {
    if (!types.length) return [];
    const placeholders = types.map(() => "?").join(", ");
    const rows = this.sqlite.prepare(`SELECT session_id, run_id, sequence, type, payload_json, created_at FROM agent_events WHERE type IN (${placeholders}) ORDER BY created_at, run_id, sequence`).all(...types) as Array<{ session_id: string; run_id: string; sequence: number; type: string; payload_json: string; created_at: string }>;
    return rows.map((row) => ({ sessionId: row.session_id, runId: row.run_id, sequence: row.sequence, type: row.type, payload: JSON.parse(row.payload_json) as unknown, createdAt: row.created_at }));
  }

  /** Incremental variant used by cross-store projectors: only events inserted
   * after `afterEventId` (the global autoincrement row id), in insertion order. */
  listEventsByTypeAfter(types: string[], afterEventId: number): Array<AgentRunEvent & { eventId: number }> {
    if (!types.length) return [];
    const placeholders = types.map(() => "?").join(", ");
    const rows = this.sqlite.prepare(`SELECT id, session_id, run_id, sequence, type, payload_json, created_at FROM agent_events WHERE type IN (${placeholders}) AND id > ? ORDER BY id`).all(...types, afterEventId) as Array<{ id: number; session_id: string; run_id: string; sequence: number; type: string; payload_json: string; created_at: string }>;
    return rows.map((row) => ({ sessionId: row.session_id, runId: row.run_id, sequence: row.sequence, type: row.type, payload: JSON.parse(row.payload_json) as unknown, createdAt: row.created_at, eventId: row.id }));
  }

  getProjectionCursor(name: string): number {
    const row = this.sqlite.prepare("SELECT last_event_id FROM projection_cursors WHERE name = ?").get(name) as { last_event_id: number } | undefined;
    return row?.last_event_id ?? 0;
  }

  setProjectionCursor(name: string, lastEventId: number): void {
    this.sqlite.prepare("INSERT INTO projection_cursors (name, last_event_id) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET last_event_id = excluded.last_event_id").run(name, lastEventId);
  }

  listSessionEntries(sessionId: string): AgentSessionEntry[] {
    const rows = this.sqlite.prepare("SELECT id, session_id, run_id, sequence, kind, role, text, metadata_json, created_at FROM agent_entries WHERE session_id = ? ORDER BY sequence").all(sessionId) as Array<{ id: string; session_id: string; run_id: string; sequence: number; kind: AgentEntryKind; role: AgentSessionEntry["role"] | null; text: string; metadata_json: string | null; created_at: string }>;
    return rows.map((row) => ({ id: row.id, sessionId: row.session_id, runId: row.run_id, sequence: row.sequence, kind: row.kind, ...(row.role ? { role: row.role } : {}), text: row.text, ...(row.metadata_json ? { metadata: parseJson(row.metadata_json) } : {}), createdAt: row.created_at }));
  }

  chatSessionEntrySummaries(sessionIds: string[]): Map<string, { preview: string; messageCount: number; lastEntryAt: string }> {
    if (!sessionIds.length) return new Map();
    const placeholders = sessionIds.map(() => "?").join(", ");
    const rows = this.sqlite.prepare(`WITH ranked AS (SELECT session_id, text, created_at, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY sequence DESC) AS rn, COUNT(*) OVER (PARTITION BY session_id) AS message_count FROM agent_entries WHERE role IN ('user', 'assistant') AND session_id IN (${placeholders})) SELECT session_id, text, created_at, message_count FROM ranked WHERE rn = 1`).all(...sessionIds) as Array<{ session_id: string; text: string; created_at: string; message_count: number }>;
    return new Map(rows.map((row) => [row.session_id, { preview: row.text.slice(0, 120), messageCount: row.message_count, lastEntryAt: row.created_at }]));
  }

  getEntry(id: string): AgentSessionEntry | undefined {
    const row = this.sqlite.prepare("SELECT session_id FROM agent_entries WHERE id = ?").get(id) as { session_id: string } | undefined;
    return row ? this.listSessionEntries(row.session_id).find((entry) => entry.id === id) : undefined;
  }

  loadCompactionAwareHistory(sessionId: string, excludeRunId: string): Array<{ id: string; role: "user" | "assistant"; text: string; timestamp: number; attachments?: AgentInputAttachment[] }> {
    const entries = this.listSessionEntries(sessionId).filter((entry) => entry.runId !== excludeRunId && (entry.role === "user" || entry.role === "assistant"));
    const latest = this.latestCompaction(sessionId);
    const selected = latest ? entries.filter((entry) => entry.sequence >= latest.retainedFromSequence) : entries;
    return [
      ...(latest ? [{ id: latest.id, role: "user" as const, text: `此前对话压缩摘要：\n${latest.summary}`, timestamp: Date.parse(latest.createdAt) || 0 }] : []),
      ...selected.map((entry) => {
        const attachments = entry.role === "user" ? this.getRunAttachments(entry.runId) : [];
        return { id: entry.id, role: entry.role as "user" | "assistant", text: entry.text, timestamp: Date.parse(entry.createdAt) || Date.now(), ...(attachments.length ? { attachments } : {}) };
      }),
    ];
  }

  importLegacyTranscript(input: { sessionId: string; projectId: string; messages: Array<{ id: string; role: "user" | "assistant"; text: string; status: "complete" | "cancelled"; createdAt: string }> }): Map<string, string> {
    this.createSession({ id: input.sessionId, projectId: input.projectId });
    const existing = this.listSessionEntries(input.sessionId);
    const metadataMappings = existing.flatMap((entry) => {
      const legacyId = (entry.metadata as { legacyMessageId?: unknown } | undefined)?.legacyMessageId;
      return typeof legacyId === "string" ? [[legacyId, entry.id] as const] : [];
    });
    this.transaction(() => {
      const statement = this.sqlite.prepare("INSERT OR IGNORE INTO agent_legacy_message_map (session_id, legacy_message_id, entry_id, created_at) VALUES (?, ?, ?, ?)");
      for (const [legacyId, entryId] of metadataMappings) statement.run(input.sessionId, legacyId, entryId, isoNow());
    });
    const mappingRows = this.sqlite.prepare("SELECT legacy_message_id, entry_id FROM agent_legacy_message_map WHERE session_id = ?").all(input.sessionId) as Array<{ legacy_message_id: string; entry_id: string }>;
    const existingMap = new Map(mappingRows.map((row) => [row.legacy_message_id, row.entry_id] as const));
    const missing = input.messages.filter((message, index, messages) => !existingMap.has(message.id) && messages.findIndex(({ id }) => id === message.id) === index);
    if (!missing.length) return existingMap;
    const run = this.startRun({ sessionId: input.sessionId, prompt: "legacy transcript import", clientCommandId: `legacy-import-v2:${randomUUID()}`, context: { migration: true } }).run;
    this.transitionRun(run.id, "running");
    let imported = 0;
    for (const message of missing) {
      this.transaction(() => {
        const alreadyMapped = this.sqlite.prepare("SELECT entry_id FROM agent_legacy_message_map WHERE session_id = ? AND legacy_message_id = ?").get(input.sessionId, message.id) as { entry_id: string } | undefined;
        if (alreadyMapped) {
          existingMap.set(message.id, alreadyMapped.entry_id);
          return;
        }
        const entry = this.appendEntry(input.sessionId, run.id, { kind: message.role, role: message.role, text: message.text, metadata: { legacyMessageId: message.id, legacyStatus: message.status, legacyCreatedAt: message.createdAt } });
        this.sqlite.prepare("UPDATE agent_entries SET created_at = ? WHERE id = ?").run(message.createdAt, entry.id);
        this.sqlite.prepare("INSERT INTO agent_legacy_message_map (session_id, legacy_message_id, entry_id, created_at) VALUES (?, ?, ?, ?)").run(input.sessionId, message.id, entry.id, isoNow());
        existingMap.set(message.id, entry.id);
        imported += 1;
      });
    }
    this.transitionRun(run.id, "completed");
    this.appendEvent(input.sessionId, run.id, "migration.legacy-transcript", { messages: imported });
    return existingMap;
  }

  latestCompaction(sessionId: string): AgentCompactionRecord | undefined {
    const row = this.sqlite.prepare("SELECT * FROM agent_compactions WHERE session_id = ? ORDER BY covered_through_sequence DESC, created_at DESC LIMIT 1").get(sessionId) as Record<string, unknown> | undefined;
    return row ? {
      id: row.id as string, sessionId: row.session_id as string, runId: row.run_id as string,
      coveredThroughSequence: row.covered_through_sequence as number, retainedFromSequence: row.retained_from_sequence as number,
      summary: row.summary as string, sourceHash: row.source_hash as string, model: row.model as string,
      usage: JSON.parse(row.usage_json as string) as AgentUsageTotals, reason: row.reason as string, createdAt: row.created_at as string,
    } : undefined;
  }

  recoverInterruptedRuns(): number {
    const timestamp = isoNow();
    return this.transaction(() => {
      const runs = this.sqlite.prepare("SELECT id, session_id FROM agent_runs WHERE status IN ('queued', 'running')").all() as Array<{ id: string; session_id: string }>;
      for (const run of runs) {
        this.sqlite.prepare("UPDATE agent_runs SET status = 'suspended', error = ? WHERE id = ?").run("server_restarted_before_terminal_event", run.id);
        this.sqlite.prepare("UPDATE agent_operations SET status = 'suspended', error = ?, finished_at = ? WHERE run_id = ? AND status = 'running'").run("server_restarted_before_terminal_event", timestamp, run.id);
        this.sqlite.prepare("UPDATE agent_sessions SET writer_run_id = NULL, writer_expires_at = NULL, updated_at = ? WHERE id = ?").run(timestamp, run.session_id);
        this.appendEvent(run.session_id, run.id, "run.suspended", { reason: "server_restart", resumable: true });
      }
      this.sqlite.prepare("UPDATE agent_delegations SET status = 'suspended', error = COALESCE(error, ?), finished_at = NULL WHERE status IN ('queued', 'running')").run("server_restarted_before_delegation_completed");
      return runs.length;
    });
  }

  compact(input: { sessionId: string; runId: string; retainEntries: number; summary: string; model: string; usage: AgentUsageTotals; reason: string }): AgentCompactionRecord | undefined {
    const entries = this.listSessionEntries(input.sessionId).filter((entry) => entry.kind !== "compaction");
    if (entries.length <= input.retainEntries) return undefined;
    const covered = entries.slice(0, -Math.max(1, input.retainEntries));
    const retained = entries.slice(-Math.max(1, input.retainEntries));
    const latest = this.latestCompaction(input.sessionId);
    if (latest && covered.at(-1)!.sequence <= latest.coveredThroughSequence) return undefined;
    const sourceHash = createHash("sha256").update(JSON.stringify(covered.map(({ id, sequence, kind, text }) => ({ id, sequence, kind, text })))).digest("hex");
    const record: AgentCompactionRecord = {
      id: randomUUID(), sessionId: input.sessionId, runId: input.runId,
      coveredThroughSequence: covered.at(-1)!.sequence, retainedFromSequence: retained[0]!.sequence,
      summary: input.summary, sourceHash, model: input.model, usage: input.usage, reason: input.reason, createdAt: isoNow(),
    };
    this.transaction(() => {
      this.sqlite.prepare("INSERT INTO agent_compactions (id, session_id, run_id, covered_through_sequence, retained_from_sequence, summary, source_hash, model, usage_json, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(record.id, record.sessionId, record.runId, record.coveredThroughSequence, record.retainedFromSequence, record.summary, record.sourceHash, record.model, JSON.stringify(record.usage), record.reason, record.createdAt);
      this.appendEntry(record.sessionId, record.runId, { kind: "compaction", role: "system", text: record.summary, metadata: { compactionId: record.id, sourceHash: record.sourceHash, coveredThroughSequence: record.coveredThroughSequence, retainedFromSequence: record.retainedFromSequence, usage: record.usage, reason: record.reason } });
      this.appendEvent(record.sessionId, record.runId, "compaction.completed", record);
    });
    return record;
  }

  snapshot(runId: string): AgentRunSnapshot {
    const run = this.getRun(runId);
    if (!run) throw new Error("Agent run not found");
    const session = this.getSession(run.sessionId)!;
    const operations = this.sqlite.prepare("SELECT * FROM agent_operations WHERE run_id = ? ORDER BY sequence").all(runId) as Array<Record<string, unknown>>;
    const usageRows = this.sqlite.prepare("SELECT * FROM agent_usage WHERE run_id = ? ORDER BY sequence").all(runId) as Array<Record<string, unknown>>;
    const compactionRows = this.sqlite.prepare("SELECT * FROM agent_compactions WHERE run_id = ? ORDER BY created_at").all(runId) as Array<Record<string, unknown>>;
    const usage: AgentUsageRecord[] = usageRows.map((row) => ({ id: row.id as string, sessionId: row.session_id as string, runId: row.run_id as string, ...(row.operation_id ? { operationId: row.operation_id as string } : {}), sequence: row.sequence as number, providerId: row.provider_id as string, modelId: row.model_id as string, inputTokens: row.input_tokens as number, outputTokens: row.output_tokens as number, cacheReadTokens: row.cache_read_tokens as number, cacheWriteTokens: row.cache_write_tokens as number, reasoningTokens: row.reasoning_tokens as number, totalTokens: row.total_tokens as number, cost: row.cost as number, createdAt: row.created_at as string }));
    const usageTotals = usage.reduce<AgentUsageTotals>((sum, item) => ({ inputTokens: sum.inputTokens + item.inputTokens, outputTokens: sum.outputTokens + item.outputTokens, cacheReadTokens: sum.cacheReadTokens + item.cacheReadTokens, cacheWriteTokens: sum.cacheWriteTokens + item.cacheWriteTokens, reasoningTokens: sum.reasoningTokens + item.reasoningTokens, totalTokens: sum.totalTokens + item.totalTokens, cost: sum.cost + item.cost }), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0, cost: 0 });
    const events = this.listEvents(runId);
    return {
      session, run,
      operations: operations.map((row) => ({ id: row.id as string, runId: row.run_id as string, sequence: row.sequence as number, kind: row.kind as AgentOperationRecord["kind"], status: row.status as AgentOperationStatus, name: row.name as string, ...(row.call_id ? { callId: row.call_id as string } : {}), ...(row.request_json ? { request: parseJson(row.request_json as string) } : {}), ...(row.result_json ? { result: parseJson(row.result_json as string) } : {}), ...(row.error ? { error: row.error as string } : {}), startedAt: row.started_at as string, ...(row.finished_at ? { finishedAt: row.finished_at as string } : {}) })),
      entries: this.listSessionEntries(run.sessionId).filter((entry) => entry.runId === runId), usage, usageTotals, events,
      compactions: compactionRows.map((row) => ({ id: row.id as string, sessionId: row.session_id as string, runId: row.run_id as string, coveredThroughSequence: row.covered_through_sequence as number, retainedFromSequence: row.retained_from_sequence as number, summary: row.summary as string, sourceHash: row.source_hash as string, model: row.model as string, usage: JSON.parse(row.usage_json as string) as AgentUsageTotals, reason: row.reason as string, createdAt: row.created_at as string })),
      lastSequence: events.at(-1)?.sequence ?? 0,
      recovery: run.status === "suspended" ? { resumable: true, strategy: "restart-interrupted-turn" } : { resumable: false },
    };
  }
}

const terminalStatuses = new Set<AgentRunStatus>(["completed", "failed", "cancelled"]);
// Token estimates share the single conservative CJK-aware implementation in
// @xiling/contracts so compaction pressure and context budgets agree.
const estimateTextTokens = (text: string): number => estimateTextTokensShared(text);

export class ResearchAgentHarness {
  private readonly active = new Map<string, { runtime?: HarnessRuntime; shutdown: boolean; cancel: boolean; guardError?: string }>();
  private readonly executions = new Map<string, Promise<void>>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly limits: Required<Omit<ResearchAgentHarnessOptions, "compaction">>;
  private readonly compactionPolicy: ResearchAgentHarnessOptions["compaction"];
  readonly recoveredOnStartup: number;

  constructor(private readonly store: SqliteAgentSessionStore, private readonly runtimeFactory: HarnessRuntimeFactory, options: ResearchAgentHarnessOptions = {}) {
    this.limits = {
      maxRunMs: options.maxRunMs ?? 10 * 60_000,
      maxToolCalls: options.maxToolCalls ?? 32,
      maxRepeatedToolSignature: options.maxRepeatedToolSignature ?? 3,
      maxRunCost: options.maxRunCost ?? 5,
    };
    this.compactionPolicy = options.compaction;
    this.recoveredOnStartup = store.recoverInterruptedRuns();
  }

  createSession(input: { id?: string; projectId: string }): AgentSessionRecord { return this.store.createSession(input); }

  archiveSession(sessionId: string): AgentSessionRecord | undefined {
    const session = this.store.getSession(sessionId);
    if (!session) return undefined;
    for (const run of this.store.listSessionRuns(sessionId)) {
      if (!terminalStatuses.has(run.status)) this.cancel(run.id);
    }
    return this.store.archiveSession(sessionId);
  }

  startTurn(command: StartAgentTurn): AgentRunSnapshot {
    const { run, created } = this.store.startRun(command);
    if (created) {
      this.emit(run, "run.queued", { clientCommandId: command.clientCommandId });
      const userEntry = this.store.appendEntry(run.sessionId, run.id, { kind: "user", role: "user", text: run.prompt, metadata: { clientCommandId: run.clientCommandId, ...(run.attachments?.length ? { attachments: run.attachments } : {}) } });
      this.emit(run, "entry.persisted", userEntry);
      this.launch(run, false);
    }
    return this.store.snapshot(run.id);
  }

  resume(runId: string): AgentRunSnapshot {
    const run = this.store.getRun(runId);
    if (!run || run.status !== "suspended") throw new Error("Only a suspended Agent run can resume");
    this.store.transitionRun(run.id, "running");
    this.store.appendOperation(run.id, { kind: "recovery", status: "completed", name: "restart-interrupted-turn", result: { priorError: run.error }, finishedAt: isoNow() });
    this.emit(run, "run.resumed", { strategy: "restart-interrupted-turn" });
    const { error: _priorError, ...resumableRun } = run;
    this.launch({ ...resumableRun, status: "running" }, true);
    return this.store.snapshot(run.id);
  }

  cancel(runId: string): AgentRunSnapshot {
    const run = this.store.getRun(runId);
    if (!run) throw new Error("Agent run not found");
    if (terminalStatuses.has(run.status)) return this.store.snapshot(runId);
    const active = this.active.get(runId);
    this.store.appendOperation(runId, { kind: "cancel", status: "completed", name: "user-cancel", finishedAt: isoNow() });
    this.emit(run, "run.cancel.requested", {});
    if (active) { active.cancel = true; active.runtime?.abort(); }
    else this.finish(run, "cancelled", "cancelled_without_live_runtime");
    return this.store.snapshot(runId);
  }

  snapshot(runId: string): AgentRunSnapshot { return this.store.snapshot(runId); }

  compact(input: Parameters<SqliteAgentSessionStore["compact"]>[0]): AgentCompactionRecord | undefined {
    return this.store.compact(input);
  }

  async *subscribe(runId: string, afterSequence = 0): AsyncIterable<AgentRunEvent> {
    let cursor = afterSequence;
    while (true) {
      const events = this.store.listEvents(runId, cursor);
      for (const event of events) { cursor = event.sequence; yield event; }
      const run = this.store.getRun(runId);
      if (!run || terminalStatuses.has(run.status) || run.status === "suspended") return;
      await new Promise<void>((resolve) => {
        const set = this.waiters.get(runId) ?? new Set<() => void>();
        const timeout = setTimeout(() => { set.delete(done); resolve(); }, 1_000);
        const done = () => { clearTimeout(timeout); set.delete(done); resolve(); };
        set.add(done); this.waiters.set(runId, set);
      });
      const waiters = this.waiters.get(runId);
      if (waiters?.size === 0) this.waiters.delete(runId);
    }
  }

  async shutdown(): Promise<void> {
    for (const [runId, active] of this.active) {
      active.shutdown = true;
      active.runtime?.abort();
      const run = this.store.getRun(runId);
      if (run && !terminalStatuses.has(run.status)) this.finish(run, "suspended", "server_shutdown");
    }
    await Promise.allSettled([...this.executions.values()]);
  }

  private launch(run: AgentRunRecord, resumed: boolean): void {
    const execution = this.execute(run, resumed).finally(() => { this.executions.delete(run.id); });
    this.executions.set(run.id, execution);
  }

  private emit(run: Pick<AgentRunRecord, "id" | "sessionId">, type: string, payload: unknown): AgentRunEvent {
    const event = this.store.appendEvent(run.sessionId, run.id, type, payload);
    for (const wake of this.waiters.get(run.id) ?? []) wake();
    return event;
  }

  private history(sessionId: string, excludeRunId: string): Array<{ id: string; role: "user" | "assistant"; text: string; timestamp: number; attachments?: AgentInputAttachment[] }> {
    return this.store.loadCompactionAwareHistory(sessionId, excludeRunId);
  }

  private async execute(run: AgentRunRecord, resumed: boolean): Promise<void> {
    let answer = "";
    let runtimeError: string | undefined;
    let totalCost = 0;
    let toolCallCount = 0;
    const toolSignatures = new Map<string, number>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let modelOperation: AgentOperationRecord | undefined;
    const toolOperations = new Map<string, AgentOperationRecord>();
    const delegatedBudget = (run.context as { multiAgent?: { budget?: { maxDurationMs?: unknown; maxToolCalls?: unknown; maxCost?: unknown } } } | undefined)?.multiAgent?.budget;
    const positiveNumber = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
    const runLimits = {
      maxRunMs: Math.min(this.limits.maxRunMs, positiveNumber(delegatedBudget?.maxDurationMs) ?? this.limits.maxRunMs),
      maxToolCalls: Math.min(this.limits.maxToolCalls, positiveNumber(delegatedBudget?.maxToolCalls) ?? this.limits.maxToolCalls),
      maxRunCost: Math.min(this.limits.maxRunCost, positiveNumber(delegatedBudget?.maxCost) ?? this.limits.maxRunCost),
    };
    // The active state is registered before the runtime is created so that a
    // cancel/shutdown arriving during factory.create() converges on a terminal
    // run instead of executing a paid model turn on an already-settled record.
    const state: { runtime?: HarnessRuntime; shutdown: boolean; cancel: boolean; guardError?: string } = { shutdown: false, cancel: false };
    this.active.set(run.id, state);
    let costAccountingKnown = true;
    try {
      this.store.transitionRun(run.id, "running");
      modelOperation = this.store.appendOperation(run.id, { kind: "model", status: "running", name: resumed ? "pi.prompt.resume" : "pi.prompt", request: { prompt: run.prompt, ...(run.attachments?.length ? { attachmentIds: run.attachments.map(({ id }) => id) } : {}) } });
      const runtime = await this.runtimeFactory.create({
        sessionId: run.sessionId, runId: run.id, prompt: run.prompt, attachments: run.attachments ?? [], ...(run.context === undefined ? {} : { commandContext: run.context }), history: this.history(run.sessionId, run.id),
        onUsage: async (usage) => {
          totalCost += usage.cost;
          this.store.appendUsage(run.sessionId, run.id, { ...usage, ...(modelOperation ? { operationId: modelOperation.id } : {}) });
          this.emit(run, "usage.recorded", usage);
          const current = this.active.get(run.id);
          if (current && costAccountingKnown && totalCost > runLimits.maxRunCost) {
            current.guardError = `run_cost_limit_exceeded:${runLimits.maxRunCost}`;
            current.runtime?.abort();
          }
        },
      });
      state.runtime = runtime;
      costAccountingKnown = runtime.costAccountingKnown !== false;
      if (state.shutdown || state.cancel) throw new Error(state.shutdown ? "server_shutdown" : "cancelled");
      timer = setTimeout(() => {
        state.guardError = `run_duration_limit_exceeded:${this.limits.maxRunMs}`;
        runtime.abort();
      }, runLimits.maxRunMs);
      runtime.subscribe(async (event) => {
        if (event.type === "message.delta") answer += event.delta;
        if (event.type === "tool.started") {
          toolCallCount += 1;
          const signature = JSON.stringify([event.toolName, event.arguments ?? null]);
          const repeats = (toolSignatures.get(signature) ?? 0) + 1;
          toolSignatures.set(signature, repeats);
          const operation = this.store.appendOperation(run.id, { kind: "tool", status: "running", name: event.toolName, callId: event.callId, ...(event.arguments === undefined ? {} : { request: event.arguments }) });
          toolOperations.set(event.callId, operation);
          this.store.appendEntry(run.sessionId, run.id, { kind: "tool-call", role: "tool", text: event.toolName, metadata: { callId: event.callId, operationId: operation.id } });
          if (toolCallCount > runLimits.maxToolCalls || repeats > this.limits.maxRepeatedToolSignature) {
            state.guardError = toolCallCount > runLimits.maxToolCalls ? `tool_call_limit_exceeded:${runLimits.maxToolCalls}` : `repeated_tool_signature:${event.toolName}`;
            runtime.abort();
          }
        }
        if (event.type === "tool.finished") {
          const operation = toolOperations.get(event.callId);
          if (operation) this.store.finishOperation(operation.id, "completed", { result: event.details });
          this.store.appendEntry(run.sessionId, run.id, { kind: "tool-result", role: "tool", text: JSON.stringify(event.details ?? { status: "completed" }), metadata: { callId: event.callId, operationId: operation?.id, toolName: event.toolName } });
        }
        if (event.type === "tool.failed") {
          const operation = toolOperations.get(event.callId);
          if (operation) this.store.finishOperation(operation.id, "failed", { result: event.details, error: event.message });
          this.store.appendEntry(run.sessionId, run.id, { kind: "tool-result", role: "tool", text: event.message, metadata: { callId: event.callId, operationId: operation?.id, toolName: event.toolName, failed: true, details: event.details } });
        }
        if (event.type === "session.error") runtimeError = event.message;
        this.emit(run, event.type, event);
      });
      this.emit(run, "run.started", { resumed });
      await runtime.prompt(run.prompt);
      // pi-agent-core resolves prompt() after an abort (emitting session.error)
      // instead of rejecting, so a cancelled run must be settled here explicitly
      // or it would stay "running" and brick the session's single-writer slot.
      if (state.shutdown) return;
      if (state.cancel) throw new Error("cancelled");
      if (state.guardError) throw new Error(state.guardError);
      if (runtimeError) throw new Error(runtimeError);
      if (answer.trim()) {
        const assistantEntry = this.store.appendEntry(run.sessionId, run.id, { kind: "assistant", role: "assistant", text: answer });
        this.emit(run, "entry.persisted", assistantEntry);
      }
      if (modelOperation) this.store.finishOperation(modelOperation.id, "completed", { result: { textLength: answer.length } });
      await this.maybeCompact(run);
      this.finish(run, "completed");
    } catch (error) {
      if (state.shutdown) return;
      const status: AgentRunStatus = state.cancel ? "cancelled" : "failed";
      const message = state.guardError ?? (error instanceof Error ? error.message : String(error));
      if (modelOperation) this.store.finishOperation(modelOperation.id, status === "cancelled" ? "cancelled" : "failed", { error: message });
      this.finish(run, status, message);
    } finally {
      if (timer) clearTimeout(timer);
      this.active.delete(run.id);
    }
  }

  private finish(run: AgentRunRecord, status: AgentRunStatus, error?: string): void {
    const current = this.store.getRun(run.id);
    if (!current || terminalStatuses.has(current.status) || (current.status === "suspended" && status !== "running")) return;
    this.store.transitionRun(run.id, status, error);
    this.emit(run, `run.${status}`, error ? { error } : {});
  }

  private async maybeCompact(run: AgentRunRecord): Promise<void> {
    const policy = this.compactionPolicy;
    if (!policy) return;
    const entries = this.store.listSessionEntries(run.sessionId).filter((entry) => entry.kind !== "compaction");
    const previousCompaction = this.store.latestCompaction(run.sessionId);
    const activeEntries = previousCompaction ? entries.filter((entry) => entry.sequence >= previousCompaction.retainedFromSequence) : entries;
    const activeText = [previousCompaction?.summary ?? "", ...activeEntries.map((entry) => entry.text)].join("\n");
    const estimatedChars = activeText.length;
    const estimatedTokens = estimateTextTokens(activeText);
    const maxEstimatedChars = policy.maxEstimatedChars ?? 120_000;
    const maxEstimatedTokens = policy.maxEstimatedTokens ?? 32_000;
    const underPressure = activeEntries.length > policy.maxEntries || estimatedChars > maxEstimatedChars || estimatedTokens > maxEstimatedTokens;
    if (!underPressure || entries.length <= policy.retainEntries) return;
    const coveredThroughSequence = entries.at(-(policy.retainEntries + 1))!.sequence;
    const incrementalEntries = entries.filter((entry) => entry.sequence > (previousCompaction?.coveredThroughSequence ?? 0) && entry.sequence <= coveredThroughSequence);
    if (!incrementalEntries.length) return;
    const result = await policy.summarize(incrementalEntries, {
      ...(previousCompaction ? { previousCompaction } : {}),
      estimatedChars,
      estimatedTokens,
      coveredThroughSequence,
    });
    const summary = previousCompaction && !result.cumulative
      ? `${previousCompaction.summary}\n\n增量摘要：\n${result.summary}`
      : result.summary;
    this.store.compact({ sessionId: run.sessionId, runId: run.id, retainEntries: policy.retainEntries, summary, model: result.model, usage: result.usage, reason: "adaptive_transcript_pressure" });
  }
}
