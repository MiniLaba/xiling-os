import { contextBridge, ipcRenderer } from "electron";

const desktopApi = Object.freeze({
  getRuntimeInfo: () =>
    ipcRenderer.invoke("desktop:get-runtime-info") as Promise<{
      appVersion: string;
      platform: NodeJS.Platform;
      coreReady: boolean;
    }>,
  minimize: () => ipcRenderer.invoke("desktop:window", "minimize") as Promise<void>,
  toggleMaximize: () =>
    ipcRenderer.invoke("desktop:window", "toggle-maximize") as Promise<void>,
  close: () => ipcRenderer.invoke("desktop:window", "close") as Promise<void>,
});

contextBridge.exposeInMainWorld("xilingDesktop", desktopApi);
