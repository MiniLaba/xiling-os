import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  ipcMain,
  net,
  protocol,
  utilityProcess,
  type IpcMainInvokeEvent,
  type UtilityProcess,
} from "electron";

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

app.setName("XiLing OS Desktop");
app.setPath("userData", path.join(app.getPath("appData"), "XiLing OS Desktop"));

let mainWindow: BrowserWindow | null = null;
let coreProcess: UtilityProcess | null = null;
let coreReady = false;
let rendererReady = false;
const launchSmoke = process.env.XILING_DESKTOP_LAUNCH_SMOKE === "1";

function completeLaunchSmokeIfReady(): void {
  if (launchSmoke && coreReady && rendererReady) {
    console.log("Desktop launch smoke passed");
    app.exit(0);
  }
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

function startCore(): void {
  coreProcess = utilityProcess.fork(path.join(runtimeDirectory, "core-entry.js"), [], {
    serviceName: "XiLing Core",
    stdio: "pipe",
  });

  coreProcess.on("message", (message: unknown) => {
    const event = message as { type?: string };
    if (event.type === "core-ready") {
      coreReady = true;
      completeLaunchSmokeIfReady();
    }
    if (event.type === "core-stopped") coreReady = false;
  });
  coreProcess.on("exit", () => {
    coreReady = false;
    coreProcess = null;
  });
}

function registerIpc(): void {
  ipcMain.handle("desktop:get-runtime-info", (event) => {
    assertTrustedSender(event);
    return { appVersion: app.getVersion(), platform: process.platform, coreReady };
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
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1040,
    minHeight: 700,
    backgroundColor: "#eef6f7",
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
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  void app.whenReady().then(() => {
    registerDesktopProtocol();
    registerIpc();
    startCore();
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
  coreProcess?.postMessage({ type: "shutdown" });
});
