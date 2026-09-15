import { app, BrowserWindow, Menu, Tray, nativeImage, screen, ipcMain, dialog } from "electron";
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const PET_SIZE = 168;
const DEFAULT_PORT = Number.parseInt(process.env.XILING_PORT ?? "4317", 10);

function appUrl(host, port) {
  const browserHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `http://${browserHost}:${port}/`;
}

function layout() {
  if (app.isPackaged) {
    const root = join(process.resourcesPath, "xiling");
    return {
      repoRoot: root,
      serverEntry: join(root, "dist/index.js"),
      webRoot: join(root, "web/dist"),
      dataFallback: join(root, "data"),
    };
  }
  const root = resolve(desktopRoot, "../..");
  return {
    repoRoot: root,
    serverEntry: join(root, "apps/server/dist/index.js"),
    webRoot: join(root, "apps/web/dist"),
    dataFallback: join(root, "data"),
  };
}

function defaultDataRoot(platform, environment = process.env) {
  if (platform === "win32" && environment.LOCALAPPDATA) return join(environment.LOCALAPPDATA, "XiLingOS");
  return layout().dataFallback;
}

function dataRoot() {
  return resolve(process.env.XILING_DATA_ROOT ?? defaultDataRoot(process.platform));
}

function logFile() {
  const dir = join(dataRoot(), "logs");
  mkdirSync(dir, { recursive: true });
  return join(dir, "desktop.log");
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try { writeFileSync(logFile(), line, { flag: "a" }); } catch { /* first run */ }
  console.error(message);
}

function nodeEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ASAR;
  delete env.CHROME_CRASHPAD_PIPE_NAME;
  return env;
}

let mainWindow;
let petWindow;
let tray;
let serverProcess;
let startedServer = false;
let quitting = false;
let currentUrl = "";
let petWatchTimer;
let lastAgentBusy = false;

function nodeBinary() {
  if (process.env.XILING_NODE_BINARY && existsSync(process.env.XILING_NODE_BINARY)) return process.env.XILING_NODE_BINARY;
  if (app.isPackaged) {
    const packed = join(process.resourcesPath, process.platform === "win32" ? "node.exe" : "node");
    if (existsSync(packed)) return packed;
  }
  return "node";
}

function iconPath() {
  return join(desktopRoot, "icons", "icon.png");
}

function appIcon() {
  const path = iconPath();
  return existsSync(path) ? nativeImage.createFromPath(path) : nativeImage.createEmpty();
}

async function isHealthy(url) {
  try {
    const response = await fetch(new URL("health", url), { signal: AbortSignal.timeout(800) });
    if (!response.ok) return false;
    const body = await response.json();
    return body.status === "ok";
  } catch {
    return false;
  }
}

async function waitUntilHealthy(url, child, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`Xi Ling OS exited before becoming healthy (code ${child.exitCode})`);
    }
    if (await isHealthy(url)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 350));
  }
  throw new Error("汐灵启动超时，请先确认已经构建成功");
}

async function ensureServer() {
  const host = process.env.XILING_HOST ?? "127.0.0.1";
  let port = Number.isInteger(DEFAULT_PORT) ? DEFAULT_PORT : 4317;
  const { repoRoot, serverEntry, webRoot } = layout();
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const url = appUrl(host, port);
    if (await isHealthy(url)) {
      currentUrl = url;
      return { url, spawned: false };
    }
    if (!existsSync(serverEntry)) throw new Error("还没有构建后端。请双击「一键启动桌面端.bat」，或先运行 pnpm build");
    if (app.isPackaged && !existsSync(join(repoRoot, "node_modules", "fastify", "package.json"))) {
      throw new Error("安装包不完整，缺少后台依赖。请重新双击「一键打包.bat」，再用新的安装包安装。");
    }
    const nodePath = nodeBinary();
    if (app.isPackaged && nodePath !== "node" && !existsSync(nodePath)) {
      throw new Error(`安装包不完整，找不到 Node：${nodePath}`);
    }
    const root = dataRoot();
    const runtimeRoot = resolve(root, "runtime");
    mkdirSync(runtimeRoot, { recursive: true });
    const logs = createWriteStream(logFile(), { flags: "a" });
    log(`starting server with ${nodePath} ${serverEntry} port=${port}`);
    const child = spawn(nodePath, [serverEntry], {
      cwd: repoRoot,
      env: {
        ...nodeEnv(),
        XILING_DATA_ROOT: root,
        XILING_HOST: host,
        XILING_PORT: String(port),
        XILING_WEB_ROOT: webRoot,
        XILING_SKILLS_ROOT: join(repoRoot, "skills"),
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.on("error", (error) => log(`server spawn error: ${error.message}`));
    child.stdout?.on("data", (chunk) => logs.write(chunk));
    child.stderr?.on("data", (chunk) => logs.write(chunk));
    child.once("exit", () => { try { logs.end(); } catch { /* closed */ } });
    startedServer = true;
    serverProcess = child;
    writeFileSync(join(runtimeRoot, "xiling-server.pid"), `${child.pid}\n`, "utf8");
    child.once("exit", () => {
      rmSync(join(runtimeRoot, "xiling-server.pid"), { force: true });
      if (!quitting) sendPetStatus("attention");
    });
    try {
      await waitUntilHealthy(url, child);
      currentUrl = url;
      return { url, spawned: true };
    } catch (error) {
      child.kill();
      startedServer = false;
      serverProcess = undefined;
      if (String(error).includes("exited before becoming healthy")) {
        port += 1;
        continue;
      }
      throw error;
    }
  }
  throw new Error("找不到可用端口启动汐灵");
}

function sendPetStatus(status) {
  if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send("desktop:pet-status", status);
}

function restPetStatus() {
  return mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() ? "idle" : "sleep";
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (!lastAgentBusy) sendPetStatus("idle");
}

function hideMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.hide();
  if (!lastAgentBusy) sendPetStatus("sleep");
}

async function startPetWatch() {
  if (petWatchTimer) clearInterval(petWatchTimer);
  const tick = async () => {
    if (!currentUrl || quitting) return;
    try {
      const response = await fetch(new URL("api/agent-center/activity", currentUrl), { signal: AbortSignal.timeout(800) });
      if (!response.ok) return;
      const body = await response.json();
      const busy = Boolean(body.busy);
      if (busy) {
        lastAgentBusy = true;
        sendPetStatus("busy");
        return;
      }
      if (lastAgentBusy) {
        lastAgentBusy = false;
        sendPetStatus("done");
        setTimeout(() => {
          if (!lastAgentBusy && !quitting) sendPetStatus(restPetStatus());
        }, 1400);
        return;
      }
    } catch {
      /* activity endpoint is optional on older server dist */
    }
  };
  await tick();
  petWatchTimer = setInterval(() => { void tick(); }, 2000);
}

function createMainWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: "#07131c",
    icon: appIcon(),
    title: "汐灵",
    webPreferences: {
      preload: join(desktopRoot, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    hideMainWindow();
  });
  mainWindow.on("show", () => {
    if (!lastAgentBusy) sendPetStatus("idle");
  });
  return mainWindow.loadURL(url);
}

function createPetWindow() {
  const display = screen.getPrimaryDisplay().workArea;
  petWindow = new BrowserWindow({
    width: PET_SIZE,
    height: PET_SIZE,
    x: display.x + display.width - PET_SIZE - 24,
    y: display.y + display.height - PET_SIZE - 24,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    show: false,
    hasShadow: false,
    focusable: false,
    thickFrame: false,
    backgroundColor: "#00000000",
    ...(process.platform === "win32" ? { backgroundMaterial: "none" } : {}),
    webPreferences: {
      preload: join(desktopRoot, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
    },
  });
  petWindow.setAlwaysOnTop(true, "screen-saver");
  petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  petWindow.setIgnoreMouseEvents(true, { forward: true });
  petWindow.once("ready-to-show", () => {
    if (!petWindow.isDestroyed()) petWindow.show();
  });
  return petWindow.loadFile(join(desktopRoot, "pet/index.html"));
}

function movePetBy(dx, dy) {
  if (!petWindow || petWindow.isDestroyed()) return;
  const [x, y] = petWindow.getPosition();
  petWindow.setPosition(x + Math.round(dx), y + Math.round(dy));
}

function petMenu() {
  const menu = Menu.buildFromTemplate([
    { label: "打开汐灵", click: () => showMainWindow() },
    { label: "隐藏主窗口", click: () => hideMainWindow() },
    { type: "separator" },
    { label: "退出", click: () => app.quit() },
  ]);
  menu.popup({ window: petWindow });
}

async function stopServer() {
  if (!startedServer || !currentUrl) return;
  const tokenPath = resolve((process.env.XILING_DATA_ROOT ?? defaultDataRoot(process.platform)), "runtime", "access-token");
  let token = "";
  try { token = readFileSync(tokenPath, "utf8").trim(); } catch { /* first run */ }
  try {
    await fetch(new URL("api/system/stop", currentUrl), {
      method: "POST",
      headers: token ? { "x-xiling-token": token } : {},
      signal: AbortSignal.timeout(3_000),
    });
  } catch {
    serverProcess?.kill();
  }
}

function createTray() {
  const image = appIcon();
  tray = new Tray(image.isEmpty() ? nativeImage.createFromDataURL("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==") : image);
  tray.setToolTip("汐灵");
  tray.on("click", () => {
    if (mainWindow?.isVisible()) hideMainWindow();
    else showMainWindow();
  });
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开汐灵", click: () => showMainWindow() },
    { label: "退出", click: () => app.quit() },
  ]));
}

ipcMain.on("desktop:ignore-mouse", (_event, ignore) => {
  if (petWindow && !petWindow.isDestroyed()) petWindow.setIgnoreMouseEvents(Boolean(ignore), { forward: true });
});
ipcMain.on("desktop:pet-click", () => {
  if (mainWindow?.isVisible()) hideMainWindow();
  else showMainWindow();
});
ipcMain.on("desktop:pet-menu", () => petMenu());
ipcMain.on("desktop:pet-drag", (_event, dx, dy) => movePetBy(dx, dy));

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => showMainWindow());
  app.whenReady().then(async () => {
    if (process.platform === "win32") await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    await createPetWindow();
    sendPetStatus("starting");
    createTray();
    const { url } = await ensureServer();
    await createMainWindow(url);
    showMainWindow();
    await startPetWatch();
    console.log(`汐灵桌面端已打开：${url}`);
  }).catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    sendPetStatus("attention");
    log(message);
    try {
      await dialog.showMessageBox({
        type: "error",
        title: "汐灵无法启动",
        message,
        detail: `详细日志：${logFile()}`,
      });
    } catch {
      /* dialog may fail if app is already quitting */
    }
    app.exit(1);
  });
}

app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  if (petWatchTimer) clearInterval(petWatchTimer);
  void stopServer().finally(() => app.exit(0));
});
