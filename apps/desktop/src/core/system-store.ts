import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { AppManifest, DesktopPreferences, DesktopWindowState, WorkspaceRoot } from "./types.js";
import type { AppCapability } from "./types.js";

const SCHEMA_VERSION = 2;
const DEFAULT_DOCK_SCALE = 1;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_roots (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  native_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS objects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspace_roots(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS relations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  attributes_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspace_roots(id) ON DELETE CASCADE,
  FOREIGN KEY (source_id) REFERENCES objects(id) ON DELETE CASCADE,
  FOREIGN KEY (target_id) REFERENCES objects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  stream TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspace_roots(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  object_id TEXT,
  uri TEXT NOT NULL,
  media_type TEXT,
  sha256 TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspace_roots(id) ON DELETE CASCADE,
  FOREIGN KEY (object_id) REFERENCES objects(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  state_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspace_roots(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  parent_run_id TEXT,
  status TEXT NOT NULL,
  summary TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_run_id) REFERENCES agent_runs(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  content_json TEXT NOT NULL,
  source_object_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspace_roots(id) ON DELETE CASCADE,
  FOREIGN KEY (source_object_id) REFERENCES objects(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS apps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  entry TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  built_in INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS permissions (
  app_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  decision TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (app_id, capability),
  FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS desktop_windows (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  width REAL NOT NULL,
  height REAL NOT NULL,
  z_index INTEGER NOT NULL,
  state TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS desktop_preferences (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS relations_source_idx ON relations(source_id, kind);
CREATE INDEX IF NOT EXISTS relations_target_idx ON relations(target_id, kind);
CREATE INDEX IF NOT EXISTS events_stream_idx ON events(stream, created_at);
CREATE INDEX IF NOT EXISTS objects_workspace_kind_idx ON objects(workspace_id, kind);
`;

export class SystemStore {
  readonly database: DatabaseSync;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") {
      mkdirSync(path.dirname(databasePath), { recursive: true });
    }
    this.database = new DatabaseSync(databasePath);
    this.database.exec(SCHEMA);
    this.database
      .prepare("INSERT OR REPLACE INTO schema_meta(key, value) VALUES('schema_version', ?)")
      .run(String(SCHEMA_VERSION));
  }

  close(): void {
    this.database.close();
  }

  getSchemaVersion(): number {
    const row = this.database
      .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    return Number(row?.value ?? 0);
  }

  setWorkspaceRoot(root: Omit<WorkspaceRoot, "createdAt" | "updatedAt">): WorkspaceRoot {
    const now = new Date().toISOString();
    this.database
      .prepare(`
        INSERT INTO workspace_roots(id, label, native_path, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          label = excluded.label,
          native_path = excluded.native_path,
          updated_at = excluded.updated_at
      `)
      .run(root.id, root.label, path.resolve(root.nativePath), now, now);
    return this.getWorkspaceRoot(root.id)!;
  }

  getWorkspaceRoot(id: string): WorkspaceRoot | undefined {
    const row = this.database
      .prepare(`
        SELECT id, label, native_path, created_at, updated_at
        FROM workspace_roots WHERE id = ?
      `)
      .get(id) as
      | { id: string; label: string; native_path: string; created_at: string; updated_at: string }
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      label: row.label,
      nativePath: row.native_path,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  upsertApp(manifest: AppManifest): void {
    const now = new Date().toISOString();
    this.database
      .prepare(`
        INSERT INTO apps(id, name, version, entry, capabilities_json, built_in, enabled, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          version = excluded.version,
          entry = excluded.entry,
          capabilities_json = excluded.capabilities_json,
          built_in = excluded.built_in,
          updated_at = excluded.updated_at
      `)
      .run(
        manifest.id,
        manifest.name,
        manifest.version,
        manifest.entry,
        JSON.stringify(manifest.capabilities),
        manifest.builtIn ? 1 : 0,
        now,
      );
  }

  listApps(): AppManifest[] {
    const rows = this.database
      .prepare(`
        SELECT id, name, version, entry, capabilities_json, built_in
        FROM apps WHERE enabled = 1 ORDER BY built_in DESC, name ASC
      `)
      .all() as Array<{
      id: string;
      name: string;
      version: string;
      entry: string;
      capabilities_json: string;
      built_in: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      version: row.version,
      entry: row.entry,
      capabilities: JSON.parse(row.capabilities_json) as AppManifest["capabilities"],
      builtIn: row.built_in === 1,
    }));
  }

  setPermission(appId: string, capability: AppCapability, decision: "allow" | "deny"): void {
    this.database
      .prepare(`
        INSERT INTO permissions(app_id, capability, decision, updated_at)
        VALUES(?, ?, ?, ?)
        ON CONFLICT(app_id, capability) DO UPDATE SET
          decision = excluded.decision,
          updated_at = excluded.updated_at
      `)
      .run(appId, capability, decision, new Date().toISOString());
  }

  getPermission(appId: string, capability: AppCapability): "allow" | "deny" | undefined {
    const row = this.database
      .prepare("SELECT decision FROM permissions WHERE app_id = ? AND capability = ?")
      .get(appId, capability) as { decision: "allow" | "deny" } | undefined;
    return row?.decision;
  }

  saveWindow(state: DesktopWindowState): void {
    this.database
      .prepare(`
        INSERT INTO desktop_windows(
          id, app_id, x, y, width, height, z_index, state, payload_json, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          app_id = excluded.app_id,
          x = excluded.x,
          y = excluded.y,
          width = excluded.width,
          height = excluded.height,
          z_index = excluded.z_index,
          state = excluded.state,
          payload_json = excluded.payload_json,
          updated_at = excluded.updated_at
      `)
      .run(
        state.id,
        state.appId,
        state.x,
        state.y,
        state.width,
        state.height,
        state.zIndex,
        state.state,
        JSON.stringify(state.payload),
        state.updatedAt,
      );
  }

  listWindows(): DesktopWindowState[] {
    const rows = this.database.prepare("SELECT * FROM desktop_windows ORDER BY z_index ASC").all() as Array<{
      id: string;
      app_id: string;
      x: number;
      y: number;
      width: number;
      height: number;
      z_index: number;
      state: DesktopWindowState["state"];
      payload_json: string;
      updated_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      appId: row.app_id,
      x: row.x,
      y: row.y,
      width: row.width,
      height: row.height,
      zIndex: row.z_index,
      state: row.state,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      updatedAt: row.updated_at,
    }));
  }

  getDesktopPreferences(): DesktopPreferences {
    const row = this.database
      .prepare("SELECT value_json FROM desktop_preferences WHERE key = 'dock_scale'")
      .get() as { value_json: string } | undefined;
    if (!row) return { dockScale: DEFAULT_DOCK_SCALE };
    const stored = Number(JSON.parse(row.value_json));
    return { dockScale: Number.isFinite(stored) ? Math.min(1.25, Math.max(0.75, stored)) : DEFAULT_DOCK_SCALE };
  }

  setDockScale(dockScale: number): DesktopPreferences {
    const normalized = Math.round(Math.min(1.25, Math.max(0.75, dockScale)) * 20) / 20;
    this.database
      .prepare(`
        INSERT INTO desktop_preferences(key, value_json, updated_at)
        VALUES('dock_scale', ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
      `)
      .run(JSON.stringify(normalized), new Date().toISOString());
    return { dockScale: normalized };
  }
}
