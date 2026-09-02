export type ResourceUri = `workspace://${string}/${string}`;

export type AppCapability =
  | "workspace.read"
  | "workspace.write"
  | "artifact.read"
  | "artifact.write"
  | "agent.invoke"
  | "network.access";

export interface AppManifest {
  id: string;
  name: string;
  version: string;
  entry: string;
  capabilities: readonly AppCapability[];
  builtIn: boolean;
}

export interface WorkspaceRoot {
  id: string;
  label: string;
  nativePath: string;
  createdAt: string;
  updatedAt: string;
}

export interface DesktopWindowState {
  id: string;
  appId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  state: "open" | "minimized" | "maximized";
  payload: Record<string, unknown>;
  updatedAt: string;
}

export interface WorkspaceEntry {
  uri: ResourceUri;
  name: string;
  kind: "file" | "directory";
  size: number | null;
  modifiedAt: string;
}
