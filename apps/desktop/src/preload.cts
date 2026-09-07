import { contextBridge, ipcRenderer, webUtils } from "electron";

import type { AppManifest, DesktopPreferences, DesktopWindowState, WorkspaceEntry, WorkspacePage, WorkspacePreview } from "./core/types.js";
import type { SafeWorkspaceRoot } from "./core/protocol.js";
import type { CredentialProviderView, ModelConnectionTestView, OsAgentModelView, OsArtifactDetail, OsModelView, OsSnapshot, OsTaskView } from "./core/protocol.js";

const desktopApi = Object.freeze({
  voice: (payload: Record<string, unknown>) => ipcRenderer.invoke("desktop:voice", payload) as Promise<import("./core/voice-types.js").VoiceResult>,
  getRuntimeInfo: () =>
    ipcRenderer.invoke("desktop:get-runtime-info") as Promise<{
      appVersion: string;
      platform: NodeJS.Platform;
      coreReady: boolean;
      coreState: "stopped" | "starting" | "ready";
    }>,
  getOsStatus: () =>
    ipcRenderer.invoke("desktop:os-status") as Promise<{
      ok: boolean;
      mainAgentId?: string;
      agents: number;
      tasks: number;
      artifacts: number;
      eventsReplayed: number;
      error?: string;
    }>,
  getOsSnapshot: () => ipcRenderer.invoke("desktop:os-snapshot") as Promise<OsSnapshot>,
  enableNativeMain: () => ipcRenderer.invoke("desktop:os-runtime-enable") as Promise<{ runtimeName: string }>,
  manageAgentApps: (payload: { action: "list" | "install" | "open" | "view" | "enable" | "disable" | "remove" | "submit"; id?: string; sessionId?: string; goal?: string; manifest?: unknown; approvedActions?: string[] }) => ipcRenderer.invoke("desktop:os-apps-manage", payload),
  submitGoal: (goal: string, sessionId?: string, artifactIds?: string[]) => ipcRenderer.invoke("desktop:os-submit-goal", goal, sessionId, artifactIds) as Promise<{ task: OsTaskView }>,
  tasks: Object.freeze({
    cancel: (taskId: string) => ipcRenderer.invoke("desktop:os-task-cancel", taskId) as Promise<{ task: OsTaskView }>,
    retry: (taskId: string) => ipcRenderer.invoke("desktop:os-task-retry", taskId) as Promise<{ task: OsTaskView }>,
    setPriority: (taskId: string, priority: number) => ipcRenderer.invoke("desktop:os-task-priority", taskId, priority) as Promise<{ task: OsTaskView }>,
    onChanged: (listener: (event: { seq: number; eventType: string }) => void) => {
      const channel = "desktop:os.changed";
      const handler = (_event: Electron.IpcRendererEvent, payload: { seq: number; eventType: string }) => listener(payload);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
  }),
  artifacts: Object.freeze({
    importText: () => ipcRenderer.invoke("desktop:os-artifact-import") as Promise<{ artifactId?: string }>,
    exportText: (id: string) => ipcRenderer.invoke("desktop:os-artifact-export", id) as Promise<{ exported: boolean }>,
    saveAnswer: (messageId: string) => ipcRenderer.invoke("desktop:os-artifact-save-answer", messageId) as Promise<{ artifactId: string }>,
    get: (artifactId: string) => ipcRenderer.invoke("desktop:os-artifact-get", artifactId) as Promise<{ artifact: OsArtifactDetail }>,
  }),
  manageMemories: (payload: Record<string, unknown>) => ipcRenderer.invoke("desktop:os-memory-manage", payload) as Promise<{ records: Array<{ id: string; agentId: string; content: unknown; createdAt: string; provenance: unknown }> }>,
  decideApproval: (approvalId: string, decision: "approved" | "rejected") =>
    ipcRenderer.invoke("desktop:os-decide-approval", approvalId, decision) as Promise<{ approvalId: string; state: string; taskId: string }>,
  submitUiAction: (surfaceId: string, actionId: string, input: unknown) =>
    ipcRenderer.invoke("desktop:os-ui-action", { surfaceId, actionId, input }) as Promise<{ surfaceId: string; actionId: string; command: string; accepted: true; result?: unknown }>,
  models: Object.freeze({
    list: () => ipcRenderer.invoke("desktop:os-models-list") as Promise<{ models: OsModelView[]; agents: OsAgentModelView[] }>,
    register: (model: Omit<OsModelView, "source" | "verifiedAt">) => ipcRenderer.invoke("desktop:os-model-register", model) as Promise<{ model: OsModelView }>,
    assign: (agentId: string, providerId: string, modelId: string) =>
      ipcRenderer.invoke("desktop:os-agent-model-set", { agentId, providerId, modelId }) as Promise<{ agent: OsAgentModelView }>,
  }),
  credentials: Object.freeze({
    list: () => ipcRenderer.invoke("desktop:os-credentials-list") as Promise<{ providers: CredentialProviderView[] }>,
    set: (providerId: string, values: Record<string, string>) => ipcRenderer.invoke("desktop:os-credentials-set", { providerId, values }) as Promise<{ provider: CredentialProviderView }>,
    clear: (providerId: string) => ipcRenderer.invoke("desktop:os-credentials-clear", providerId) as Promise<{ provider: CredentialProviderView }>,
    test: (providerId: string, modelId: string) => ipcRenderer.invoke("desktop:os-credentials-test", providerId, modelId) as Promise<ModelConnectionTestView>,
  }),
  netFetch: (payload: { appId: string; url: string; method?: string; headers?: Record<string, string> }) =>
    ipcRenderer.invoke("desktop:net-fetch", payload) as Promise<{ status: number; headers: Record<string, string>; bodyText: string }>,
  listApps: () => ipcRenderer.invoke("desktop:apps-list") as Promise<AppManifest[]>,
  workspace: Object.freeze({
    get: () => ipcRenderer.invoke("desktop:workspace-get") as Promise<SafeWorkspaceRoot | null>,
    select: () => ipcRenderer.invoke("desktop:workspace-select") as Promise<SafeWorkspaceRoot | null>,
    list: (relativeDirectory = "") =>
      ipcRenderer.invoke("desktop:workspace-list", relativeDirectory) as Promise<WorkspaceEntry[]>,
    page: (relativeDirectory = "", offset = 0) =>
      ipcRenderer.invoke("desktop:workspace-page", relativeDirectory, offset) as Promise<WorkspacePage>,
    search: (query: string) =>
      ipcRenderer.invoke("desktop:workspace-search", query) as Promise<WorkspaceEntry[]>,
    createDirectory: (relativeDirectory: string, name: string) =>
      ipcRenderer.invoke("desktop:workspace-mkdir", relativeDirectory, name) as Promise<WorkspaceEntry>,
    rename: (uri: string, name: string) =>
      ipcRenderer.invoke("desktop:workspace-rename", uri, name) as Promise<WorkspaceEntry>,
    move: (uri: string, targetDirectoryUri: string | null) =>
      ipcRenderer.invoke("desktop:workspace-move", uri, targetDirectoryUri) as Promise<WorkspaceEntry>,
    preview: (uri: string) =>
      ipcRenderer.invoke("desktop:workspace-preview", uri) as Promise<WorkspacePreview>,
    trash: (uri: string) =>
      ipcRenderer.invoke("desktop:workspace-trash", uri) as Promise<{ trashed: true }>,
    open: (uri: string) => ipcRenderer.invoke("desktop:workspace-open", uri) as Promise<void>,
    importDroppedFiles: (files: File[], targetDirectoryUri: string | null = null) => {
      const sourcePaths = files.map((file) => webUtils.getPathForFile(file)).filter(Boolean);
      return ipcRenderer.invoke("desktop:workspace-import", sourcePaths, targetDirectoryUri) as Promise<WorkspaceEntry[]>;
    },
    onChanged: (listener: (event: { rootId: string }) => void) => {
      const channel = "desktop:workspace.changed";
      const handler = (_event: Electron.IpcRendererEvent, payload: { rootId: string }) => listener(payload);
      ipcRenderer.on(channel, handler);
      void ipcRenderer.invoke("desktop:workspace-watch", true).catch(() => undefined);
      return () => {
        ipcRenderer.removeListener(channel, handler);
        void ipcRenderer.invoke("desktop:workspace-watch", false).catch(() => undefined);
      };
    },
  }),
  windowState: Object.freeze({
    list: () => ipcRenderer.invoke("desktop:windows-list") as Promise<DesktopWindowState[]>,
    save: (state: DesktopWindowState) =>
      ipcRenderer.invoke("desktop:window-state-save", state) as Promise<{ saved: true }>,
  }),
  appearance: Object.freeze({
    get: () => ipcRenderer.invoke("desktop:appearance-get") as Promise<DesktopPreferences>,
    setDockScale: (dockScale: number) =>
      ipcRenderer.invoke("desktop:appearance-set-dock-scale", dockScale) as Promise<DesktopPreferences>,
    onDockScaleChanged: (listener: (dockScale: number) => void) => {
      const channel = "desktop:dock-scale-changed";
      const handler = (_event: Electron.IpcRendererEvent, dockScale: number) => listener(dockScale);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
  }),
  minimize: () => ipcRenderer.invoke("desktop:window", "minimize") as Promise<void>,
  toggleMaximize: () =>
    ipcRenderer.invoke("desktop:window", "toggle-maximize") as Promise<void>,
  close: () => ipcRenderer.invoke("desktop:window", "close") as Promise<void>,
});

contextBridge.exposeInMainWorld("xilingDesktop", desktopApi);
