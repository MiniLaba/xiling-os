import { contextBridge, ipcRenderer, webUtils } from "electron";

import type { AppManifest, DesktopPreferences, DesktopWindowState, WorkspaceEntry, WorkspacePreview } from "./core/types.js";
import type { SafeWorkspaceRoot } from "./core/protocol.js";

const desktopApi = Object.freeze({
  getRuntimeInfo: () =>
    ipcRenderer.invoke("desktop:get-runtime-info") as Promise<{
      appVersion: string;
      platform: NodeJS.Platform;
      coreReady: boolean;
      coreState: "stopped" | "starting" | "ready";
    }>,
  listApps: () => ipcRenderer.invoke("desktop:apps-list") as Promise<AppManifest[]>,
  workspace: Object.freeze({
    get: () => ipcRenderer.invoke("desktop:workspace-get") as Promise<SafeWorkspaceRoot | null>,
    select: () => ipcRenderer.invoke("desktop:workspace-select") as Promise<SafeWorkspaceRoot | null>,
    list: (relativeDirectory = "") =>
      ipcRenderer.invoke("desktop:workspace-list", relativeDirectory) as Promise<WorkspaceEntry[]>,
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
