import { contextBridge, ipcRenderer, webUtils } from "electron";

import type { AppManifest, DesktopWindowState, WorkspaceEntry } from "./core/types.js";
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
    importDroppedFiles: (files: File[]) => {
      const sourcePaths = files.map((file) => webUtils.getPathForFile(file)).filter(Boolean);
      return ipcRenderer.invoke("desktop:workspace-import", sourcePaths) as Promise<WorkspaceEntry[]>;
    },
  }),
  windowState: Object.freeze({
    list: () => ipcRenderer.invoke("desktop:windows-list") as Promise<DesktopWindowState[]>,
    save: (state: DesktopWindowState) =>
      ipcRenderer.invoke("desktop:window-state-save", state) as Promise<{ saved: true }>,
  }),
  minimize: () => ipcRenderer.invoke("desktop:window", "minimize") as Promise<void>,
  toggleMaximize: () =>
    ipcRenderer.invoke("desktop:window", "toggle-maximize") as Promise<void>,
  close: () => ipcRenderer.invoke("desktop:window", "close") as Promise<void>,
});

contextBridge.exposeInMainWorld("xilingDesktop", desktopApi);
