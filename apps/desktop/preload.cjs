const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("xilingDesktop", {
  ignoreMouse: (ignore) => ipcRenderer.send("desktop:ignore-mouse", ignore),
  petClick: () => ipcRenderer.send("desktop:pet-click"),
  petMenu: () => ipcRenderer.send("desktop:pet-menu"),
  petDrag: (dx, dy) => ipcRenderer.send("desktop:pet-drag", dx, dy),
  onStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("desktop:pet-status", listener);
    return () => ipcRenderer.removeListener("desktop:pet-status", listener);
  },
});
