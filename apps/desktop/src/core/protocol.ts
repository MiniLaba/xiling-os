import type { AppManifest, DesktopPreferences, DesktopWindowState, WorkspaceEntry, WorkspacePage, WorkspacePreview } from "./types.js";

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
  | "workspace.page"
  | "workspace.search"
  | "workspace.mkdir"
  | "workspace.rename"
  | "workspace.move"
  | "workspace.preview"
  | "workspace.import"
  | "workspace.resolve"
  | "workspace.resolveWrite"
  | "windows.list"
  | "windows.save"
  | "preferences.get"
  | "preferences.set";

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
  "workspace.page": WorkspacePage;
  "workspace.search": WorkspaceEntry[];
  "workspace.mkdir": WorkspaceEntry;
  "workspace.rename": WorkspaceEntry;
  "workspace.move": WorkspaceEntry;
  "workspace.preview": WorkspacePreview;
  "workspace.import": WorkspaceEntry[];
  "workspace.resolve": { nativePath: string };
  "workspace.resolveWrite": { nativePath: string };
  "windows.list": DesktopWindowState[];
  "windows.save": { saved: true };
  "preferences.get": DesktopPreferences;
  "preferences.set": DesktopPreferences;
}
