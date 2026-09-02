import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  protocol,
  screen,
  shell,
  utilityProcess,
  type IpcMainInvokeEvent,
  type UtilityProcess,
} from "electron";

import type { CoreEvent, CoreMethod, CoreRequest, CoreResponse, CoreResultMap } from "./core/protocol.js";
import { LazyResource } from "./core/resource-lifecycle.js";
import type { DesktopWindowState } from "./core/types.js";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "xiling",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: false,
    },
  },
]);

const runtimeDirectory = path.dirname(fileURLToPath(import.meta.url));
const rendererDirectory = path.resolve(runtimeDirectory, "../renderer");
const trustedOrigin = "xiling://app";
const launchSmoke = process.env.XILING_DESKTOP_LAUNCH_SMOKE === "1";

app.setName("XiLing OS Desktop");
app.setPath(
  "userData",
  launchSmoke
    ? path.join(app.getPath("temp"), "XiLing OS Desktop Launch Smoke")
    : path.join(app.getPath("appData"), "XiLing OS Desktop"),
);

let mainWindow: BrowserWindow | null = null;
let coreProcess: UtilityProcess | null = null;
let coreReady = false;
let rendererReady = false;
let managedWindowReady = !launchSmoke;
let launchSmokeFinishing = false;
const pendingCoreRequests = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (error: Error) => void; release: () => void }
>();
let workspaceWatchLease: { release: () => void } | undefined;
let workspaceWatchClients = 0;

function completeLaunchSmokeIfReady(): void {
  if (!launchSmoke || !coreReady || !rendererReady || !managedWindowReady || launchSmokeFinishing) return;
  launchSmokeFinishing = true;
  setTimeout(() => {
    const processMetrics = app.getAppMetrics();
    const workingSetMb = processMetrics.reduce((total, metric) => total + metric.memory.workingSetSize, 0) / 1024;
    const limitMb = Number(process.env.XILING_DESKTOP_SMOKE_MEMORY_MB ?? 520);
    if (!Number.isFinite(workingSetMb) || workingSetMb > limitMb) {
      for (const metric of processMetrics) {
        console.error(
          `Desktop launch process ${metric.type}${metric.serviceName ? ` (${metric.serviceName})` : ""}: ${(metric.memory.workingSetSize / 1024).toFixed(1)} MB`,
        );
      }
      console.error(`Desktop launch exceeded memory regression limit: ${workingSetMb.toFixed(1)} MB > ${limitMb} MB`);
      app.exit(1);
      return;
    }
    console.log(`Desktop launch smoke passed (${workingSetMb.toFixed(1)} MB active working set)`);
    app.exit(0);
  }, 1_000);
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (!event.senderFrame?.url.startsWith(trustedOrigin)) {
    throw new Error("Rejected IPC from an untrusted renderer");
  }
}

function registerDesktopProtocol(): void {
  protocol.handle("xiling", (request) => {
    const url = new URL(request.url);
    const requestedPath = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const candidate = path.resolve(rendererDirectory, `.${requestedPath}`);

    if (candidate !== rendererDirectory && !candidate.startsWith(`${rendererDirectory}${path.sep}`)) {
      return new Response("Not found", { status: 404 });
    }

    return net.fetch(pathToFileURL(candidate).toString());
  });
}

const coreResource = new LazyResource<UtilityProcess>(
  {
    start: () =>
      new Promise<UtilityProcess>((resolve, reject) => {
        const child = utilityProcess.fork(path.join(runtimeDirectory, "core-entry.js"), [], {
          serviceName: "XiLing Core",
          stdio: "pipe",
          env: {
            ...process.env,
            XILING_SYSTEM_DB_PATH: path.join(app.getPath("userData"), "system.sqlite"),
          },
        });
        coreProcess = child;
        const timeout = setTimeout(() => {
          child.kill();
          reject(new Error("XiLing Core startup timed out"));
        }, 8_000);
        timeout.unref();
        child.on("message", (message: unknown) => {
          const coreEvent = message as CoreResponse | { type?: string };
          if (coreEvent.type === "core-ready") {
            clearTimeout(timeout);
            coreReady = true;
            completeLaunchSmokeIfReady();
            resolve(child);
            mainWindow?.webContents.send("desktop:core-state", "ready");
            return;
          }
          if (coreEvent.type === "core-response") {
            const response = coreEvent as CoreResponse;
            const pending = pendingCoreRequests.get(response.id);
            if (!pending) return;
            pendingCoreRequests.delete(response.id);
            pending.release();
            if (response.ok) pending.resolve(response.result);
            else pending.reject(new Error(response.error ?? "XiLing Core request failed"));
          }
          if (coreEvent.type === "core-event") {
            const notification = coreEvent as CoreEvent;
            mainWindow?.webContents.send(`desktop:${notification.topic}`, notification.payload);
          }
          if (coreEvent.type === "core-stopped") coreReady = false;
        });
        child.on("exit", () => {
          clearTimeout(timeout);
          coreReady = false;
          coreProcess = null;
          for (const [id, pending] of pendingCoreRequests) {
            pendingCoreRequests.delete(id);
            pending.release();
            pending.reject(new Error("XiLing Core stopped before completing the request"));
          }
          mainWindow?.webContents.send("desktop:core-state", "stopped");
        });
      }),
    stop: (child) =>
      new Promise<void>((resolve) => {
        if (child.pid === undefined) return resolve();
        const timeout = setTimeout(() => {
          child.kill();
          resolve();
        }, 2_000);
        timeout.unref();
        child.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
        child.postMessage({ type: "shutdown" });
      }),
  },
  5 * 60_000,
);

async function requestCore<M extends CoreMethod>(method: M, params: unknown): Promise<CoreResultMap[M]> {
  const lease = await coreResource.acquire();
  const id = randomUUID();
  return new Promise<CoreResultMap[M]>((resolve, reject) => {
    pendingCoreRequests.set(id, {
      resolve: (value) => resolve(value as CoreResultMap[M]),
      reject,
      release: lease.release,
    });
    lease.value.postMessage({ type: "core-request", id, method, params } satisfies CoreRequest);
  });
}

function registerIpc(): void {
  ipcMain.handle("desktop:get-runtime-info", (event) => {
    assertTrustedSender(event);
    return {
      appVersion: app.getVersion(),
      platform: process.platform,
      coreReady,
      coreState: coreResource.state,
    };
  });

  ipcMain.handle("desktop:apps-list", async (event) => {
    assertTrustedSender(event);
    return requestCore("apps.list", {});
  });

  ipcMain.handle("desktop:workspace-get", async (event) => {
    assertTrustedSender(event);
    return requestCore("workspace.get", {});
  });

  ipcMain.handle("desktop:workspace-select", async (event) => {
    assertTrustedSender(event);
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择汐灵桌面文件夹",
      properties: ["openDirectory", "createDirectory"],
    });
    const nativePath = result.filePaths[0];
    if (result.canceled || !nativePath) return null;
    return requestCore("workspace.set", {
      nativePath,
      label: path.basename(nativePath),
    });
  });

  ipcMain.handle("desktop:workspace-list", async (event, relativeDirectory: unknown) => {
    assertTrustedSender(event);
    if (typeof relativeDirectory !== "string") throw new Error("Invalid workspace directory");
    return requestCore("workspace.list", {
      appId: "system.files",
      relativeDirectory,
    });
  });

  ipcMain.handle("desktop:workspace-import", async (event, sourcePaths: unknown) => {
    assertTrustedSender(event);
    if (!Array.isArray(sourcePaths) || sourcePaths.some((item) => typeof item !== "string")) {
      throw new Error("Invalid import paths");
    }
    return requestCore("workspace.import", { appId: "system.files", sourcePaths });
  });

  ipcMain.handle("desktop:workspace-open", async (event, uri: unknown) => {
    assertTrustedSender(event);
    if (typeof uri !== "string" || !uri.startsWith("workspace://")) throw new Error("Invalid resource URI");
    const target = await requestCore("workspace.resolve", { appId: "system.files", uri });
    const failure = await shell.openPath(target.nativePath);
    if (failure) throw new Error(failure);
  });

  ipcMain.handle("desktop:workspace-watch", async (event, enabled: unknown) => {
    assertTrustedSender(event);
    if (typeof enabled !== "boolean") throw new Error("Invalid watcher state");
    if (enabled) {
      workspaceWatchClients += 1;
      if (!workspaceWatchLease) {
        const lease = await coreResource.acquire();
        workspaceWatchLease = { release: lease.release };
      }
      return;
    }
    workspaceWatchClients = Math.max(0, workspaceWatchClients - 1);
    if (workspaceWatchClients === 0 && workspaceWatchLease) {
      workspaceWatchLease.release();
      workspaceWatchLease = undefined;
    }
  });

  ipcMain.handle("desktop:windows-list", async (event) => {
    assertTrustedSender(event);
    return requestCore("windows.list", {});
  });

  ipcMain.handle("desktop:window-state-save", async (event, state: unknown) => {
    assertTrustedSender(event);
    return requestCore("windows.save", { state: state as DesktopWindowState });
  });

  ipcMain.handle("desktop:window", (event, action: unknown) => {
    assertTrustedSender(event);
    if (!mainWindow || typeof action !== "string") return;
    if (action === "minimize") mainWindow.minimize();
    if (action === "toggle-maximize") {
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
    }
    if (action === "close") mainWindow.close();
  });
}

function createMainWindow(): void {
  // 初始窗口取工作区可用尺寸（扣除系统菜单栏与程序坞），避免应用内容被系统 Dock 遮挡。
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  mainWindow = new BrowserWindow({
    width: launchSmoke ? 1040 : Math.max(1040, Math.min(1440, workArea.width)),
    height: launchSmoke ? 700 : Math.max(700, Math.min(920, workArea.height)),
    minWidth: 1040,
    minHeight: 700,
    backgroundColor: "#0a1428",
    show: false,
    title: "汐灵科研桌面",
    webPreferences: {
      preload: path.join(runtimeDirectory, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.once("did-finish-load", () => {
    rendererReady = true;
    if (launchSmoke) {
      void requestCore("system.ping", {});
      void mainWindow?.webContents
        .executeJavaScript(`
          document.querySelector('[data-app="chat"]')?.click();
          new Promise((resolve) => {
            const started = Date.now();
            const check = () => {
              if (document.querySelector('.managed-window')) return resolve(true);
              if (Date.now() - started > 5000) return resolve(false);
              setTimeout(check, 25);
            };
            check();
          });
        `)
        .then((ready) => {
          managedWindowReady = ready === true;
          if (!managedWindowReady) throw new Error("React internal window did not open");
          completeLaunchSmokeIfReady();
        });
    }
    completeLaunchSmokeIfReady();
  });
  mainWindow.webContents.on("will-navigate", (event, targetUrl) => {
    if (!targetUrl.startsWith(trustedOrigin)) event.preventDefault();
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  void mainWindow.loadURL(`${trustedOrigin}/index.html`);

  if (launchSmoke) {
    setTimeout(() => {
      console.error("Desktop launch smoke timed out before renderer/core readiness");
      app.exit(1);
    }, 10_000).unref();
  }
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  if (launchSmoke) {
    console.error("Desktop launch smoke could not acquire the isolated single-instance lock");
    app.exit(1);
  } else {
    app.quit();
  }
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  void app.whenReady().then(() => {
    registerDesktopProtocol();
    registerIpc();
    createMainWindow();
  });
}

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  workspaceWatchLease?.release();
  workspaceWatchLease = undefined;
  void coreResource.stopNow();
});
