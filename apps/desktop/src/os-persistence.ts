import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ArtifactContentStore } from "@xiling/os-kernel";
import type { OSEvent } from "@xiling/os-domain";

/** SQLite 是 Desktop V2 的持久化事实库；事件追加与 Blob 写入均为同步、幂等事务。 */
export class OsPersistence implements ArtifactContentStore {
  private readonly database: DatabaseSync;

  constructor(databasePath: string, legacyJsonlPath?: string) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS os_events (
        seq INTEGER PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        event_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS os_blobs (
        storage_ref TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS os_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    if (legacyJsonlPath) this.importLegacyJsonlIfEmpty(legacyJsonlPath);
  }

  loadEvents(): OSEvent[] {
    return this.database.prepare("SELECT event_json FROM os_events ORDER BY seq ASC").all()
      .map((row) => JSON.parse(String((row as { event_json: unknown }).event_json)) as OSEvent);
  }

  appendEvent(event: OSEvent): void {
    this.database.prepare("INSERT INTO os_events(seq, event_id, type, occurred_at, event_json) VALUES (?, ?, ?, ?, ?)")
      .run(event.seq, event.eventId, event.type, event.occurredAt, JSON.stringify(event));
  }

  put(storageRef: string, content: string): void {
    this.database.prepare("INSERT OR IGNORE INTO os_blobs(storage_ref, content, byte_length, created_at) VALUES (?, ?, ?, ?)")
      .run(storageRef, content, Buffer.byteLength(content, "utf8"), new Date().toISOString());
    const stored = this.get(storageRef);
    if (stored !== content) throw new Error(`content hash collision: ${storageRef}`);
  }

  get(storageRef: string): string | undefined {
    const row = this.database.prepare("SELECT content FROM os_blobs WHERE storage_ref = ?").get(storageRef) as { content?: unknown } | undefined;
    return typeof row?.content === "string" ? row.content : undefined;
  }

  close(): void { this.database.close(); }

  private importLegacyJsonlIfEmpty(legacyPath: string): void {
    const count = this.database.prepare("SELECT COUNT(*) AS count FROM os_events").get() as { count: number };
    if (Number(count.count) !== 0) return;
    let events: OSEvent[];
    try {
      events = readFileSync(legacyPath, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as OSEvent);
    } catch { return; }
    const uniqueEvents = events.filter((event, index) => events.findIndex((candidate) => candidate.eventId === event.eventId) === index);
    const validSequence = uniqueEvents.every((event, index) => Number.isInteger(event.seq) && event.seq > (index === 0 ? 0 : uniqueEvents[index - 1]!.seq));
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const [index, source] of uniqueEvents.entries()) {
        const event = structuredClone(source);
        if (!validSequence) event.seq = index + 1;
        this.appendEvent(event);
        if ((event.type === "artifact.created" || event.type === "artifact.version_added") && typeof event.payload.content === "string") {
          this.put(event.payload.artifact.storageRef, event.payload.content);
        }
      }
      this.database.prepare("INSERT OR REPLACE INTO os_meta(key, value) VALUES ('legacy_jsonl_imported', ?)").run(new Date().toISOString());
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}
