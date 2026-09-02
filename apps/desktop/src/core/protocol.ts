import type { AppManifest, DesktopWindowState, WorkspaceEntry } from "./types.js";

export interface CoreRequest {
  type: "core-request";
  id: string;
  method: CoreMethod;
  params: unknown;
}

export interface CoreResponse {
  type: "core-response";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface CoreEvent {
  type: "core-event";
  topic: "workspace.changed";
  payload: { rootId: string };
}

export type CoreMethod =
  | "system.ping"
  | "apps.list"
  | "workspace.get"
  | "workspace.set"
  | "workspace.list"
  | "workspace.import"
  | "workspace.resolve"
  | "windows.list"
  | "windows.save";

export interface SafeWorkspaceRoot {
  id: string;
  label: string;
}

export interface CoreResultMap {
  "system.ping": { schemaVersion: number };
  "apps.list": AppManifest[];
  "workspace.get": SafeWorkspaceRoot | null;
  "workspace.set": SafeWorkspaceRoot;
  "workspace.list": WorkspaceEntry[];
  "workspace.import": WorkspaceEntry[];
  "workspace.resolve": { nativePath: string };
  "windows.list": DesktopWindowState[];
  "windows.save": { saved: true };
}
