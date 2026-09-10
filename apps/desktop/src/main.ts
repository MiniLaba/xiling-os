import path from "node:path";
import { open as openFile, writeFile } from "node:fs/promises";
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
  protocol.handle("xiling", async (request) => {
    const url = new URL(request.url);
    const requestedPath = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const candidate = path.resolve(rendererDirectory, `.${requestedPath}`);

    if (candidate !== rendererDirectory && !candidate.startsWith(`${rendererDirectory}${path.sep}`)) {
      return new Response("Not found", { status: 404 });
    }

    const response = await net.fetch(pathToFileURL(candidate).toString());
    // 本地源文件直接服务：禁启发式缓存，避免迭代时渲染器拿到旧资源
    const headers = new Headers(response.headers);
    headers.set("cache-control", "no-cache");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
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
            XILING_OS_DATA_DIR: path.join(app.getPath("userData"), "os-data"),
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

  ipcMain.handle("desktop:os-status", async (event) => {
    assertTrustedSender(event);
    return requestCore("os.status", {});
  });

  ipcMain.handle("desktop:os-snapshot", async (event) => {
    assertTrustedSender(event);
    return requestCore("os.snapshot", {});
  });

  ipcMain.handle("desktop:os-apps-manage", async (event, payload: unknown) => {
    assertTrustedSender(event);
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || JSON.stringify(payload).length > 70_000) throw new Error("Invalid App command");
    return requestCore("os.apps.manage", payload);
  });

  ipcMain.handle("desktop:os-submit-goal", async (event, goal: unknown, sessionId: unknown, artifactIds: unknown = []) => {
    assertTrustedSender(event);
    if (typeof goal !== "string" || goal.trim() === "") throw new Error("请输入目标");
    if (goal.length > 12000 || (sessionId !== undefined && (typeof sessionId !== "string" || sessionId.length > 200))) throw new Error("Invalid goal or session");
    if (!Array.isArray(artifactIds) || artifactIds.length > 20 || artifactIds.some((id) => typeof id !== "string" || id.length > 200)) throw new Error("Invalid artifact selection");
    return requestCore("os.goal.submit", { goal, sessionId, artifactIds });
  });

  ipcMain.handle("desktop:os-task-cancel", async (event, taskId: unknown) => {
    assertTrustedSender(event);
    if (typeof taskId !== "string") throw new Error("Invalid task id");
    return requestCore("os.task.cancel", { taskId });
  });

  ipcMain.handle("desktop:os-task-retry", async (event, taskId: unknown) => {
    assertTrustedSender(event);
    if (typeof taskId !== "string") throw new Error("Invalid task id");
    return requestCore("os.task.retry", { taskId });
  });

  ipcMain.handle("desktop:os-task-priority", async (event, taskId: unknown, priority: unknown) => {
    assertTrustedSender(event);
    if (typeof taskId !== "string" || typeof priority !== "number") throw new Error("Invalid task priority");
    return requestCore("os.task.priority.set", { taskId, priority });
  });

  ipcMain.handle("desktop:os-artifact-get", async (event, artifactId: unknown) => {
    assertTrustedSender(event);
    if (typeof artifactId !== "string") throw new Error("Invalid artifact id");
    return requestCore("os.artifact.get", { artifactId });
  });
  ipcMain.handle("desktop:os-artifact-save-answer", async (event, messageId: unknown) => {
    assertTrustedSender(event);
    if (typeof messageId !== "string" || messageId.length > 200) throw new Error("Invalid message id");
    return requestCore("os.artifact.saveAnswer", { messageId });
  });
  ipcMain.handle("desktop:os-memory-manage", async (event, payload: unknown) => {
    assertTrustedSender(event);
    if (!payload || typeof payload !== "object" || JSON.stringify(payload).length > 10_000) throw new Error("Invalid memory request");
    return requestCore("os.memory.manage", payload);
  });
  ipcMain.handle("desktop:os-runtime-enable", async (event) => {
    assertTrustedSender(event);
    return requestCore("os.runtime.enable", {});
  });
  ipcMain.handle("desktop:os-artifact-import", async (event) => {
    assertTrustedSender(event);
    const choice = await dialog.showOpenDialog({ title: "导入文本作为显式任务材料", properties: ["openFile"], filters: [{ name: "文本", extensions: ["txt", "md", "csv", "json"] }] });
    const file = choice.filePaths[0];
    if (choice.canceled || !file) return {};
    if (!/\.(txt|md|csv|json)$/i.test(file)) throw new Error("当前仅支持 UTF-8 文本文件");
    const handle = await openFile(file, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 200_000) throw new Error("请选择不超过 200 KB 的普通文本文件");
      const buffer = Buffer.alloc(200_001);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 200_000) throw new Error("文件已变大，请重新选择");
      const content = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
      if (content.includes("\0")) throw new Error("不支持二进制内容");
      return requestCore("os.artifact.import", { name: path.basename(file), content });
    } finally { await handle.close(); }
  });
  ipcMain.handle("desktop:os-artifact-export", async (event, id: unknown) => {
    assertTrustedSender(event);
    if (typeof id !== "string") throw new Error("Invalid artifact id");
    const { artifact } = await requestCore("os.artifact.get", { artifactId: id });
    if (artifact.truncated) throw new Error("产物过大，不能将截断预览作为完整文件导出");
    const safeName = artifact.name.replace(/[\\/<>:"|?*\x00-\x1f]/g, "_").replace(/[. ]+$/, "");
    const choice = await dialog.showSaveDialog({ title: "导出产物", defaultPath: /\.(md|txt|csv|json)$/i.test(safeName) ? safeName : `${safeName || "artifact"}.txt` });
    if (choice.canceled || !choice.filePath) return { exported: false };
    if (!/\.(md|txt|csv|json)$/i.test(choice.filePath)) throw new Error("请使用文本文件扩展名");
    // Exclusive creation prevents symlink races and accidental replacement of user files.
    await writeFile(choice.filePath, artifact.content, { encoding: "utf8", flag: "wx" }).catch((error: NodeJS.ErrnoException) => { if (error.code === "EEXIST") throw new Error("目标已存在，请选择新的文件名；不会覆盖原文件"); throw error; });
    return { exported: true };
  });

  ipcMain.handle("desktop:os-decide-approval", async (event, approvalId: unknown, decision: unknown) => {
    assertTrustedSender(event);
    if (typeof approvalId !== "string") throw new Error("Invalid approval id");
    return requestCore("os.approval.decide", { approvalId, decision });
  });

  ipcMain.handle("desktop:os-models-list", async (event) => {
    assertTrustedSender(event);
    return requestCore("os.models.list", {});
  });

  ipcMain.handle("desktop:os-model-register", async (event, model: unknown) => {
    assertTrustedSender(event);
    if (!model || typeof model !== "object") throw new Error("Invalid model declaration");
    return requestCore("os.models.register", model);
  });

  ipcMain.handle("desktop:os-agent-model-set", async (event, assignment: unknown) => {
    assertTrustedSender(event);
    if (!assignment || typeof assignment !== "object") throw new Error("Invalid model assignment");
    return requestCore("os.agent.model.set", assignment);
  });

  ipcMain.handle("desktop:os-ui-action", async (event, payload: unknown) => {
    assertTrustedSender(event);
    if (!payload || typeof payload !== "object") throw new Error("Invalid UI action");
    return requestCore("os.ui.action", payload);
  });

  ipcMain.handle("desktop:os-credentials-list", async (event) => {
    assertTrustedSender(event);
    return requestCore("os.credentials.list", {});
  });
  ipcMain.handle("desktop:research-knowledge", async (event, payload: unknown) => {
    assertTrustedSender(event);
    if (!payload || typeof payload !== "object" || JSON.stringify(payload).length > 200_000) throw new Error("Invalid research request");
    return requestCore("research.knowledge", payload);
  });
  ipcMain.handle("desktop:voice", async (event, payload: unknown) => {
    assertTrustedSender(event);
    if (!payload || typeof payload !== "object" || JSON.stringify(payload).length > 8_100_000) throw new Error("无效语音请求");
    return requestCore("os.voice", payload);
  });
  ipcMain.handle("desktop:os-credentials-set", async (event, payload: unknown) => {
    assertTrustedSender(event);
    if (!payload || typeof payload !== "object") throw new Error("Invalid credential payload");
    return requestCore("os.credentials.set", payload);
  });
  ipcMain.handle("desktop:os-credentials-clear", async (event, providerId: unknown) => {
    assertTrustedSender(event);
    if (typeof providerId !== "string") throw new Error("Invalid provider id");
    return requestCore("os.credentials.clear", { providerId });
  });
  ipcMain.handle("desktop:os-credentials-test", async (event, providerId: unknown, modelId: unknown) => {
    assertTrustedSender(event);
    if (typeof providerId !== "string" || typeof modelId !== "string") throw new Error("Invalid connection test");
    return requestCore("os.credentials.test", { providerId, modelId });
  });

  // 插件 APP 的受控出网：核心网关校验 network.access 能力后，主进程代为 fetch。
  // 渲染器 CSP connect-src 'self' 保持不放行外网。
  ipcMain.handle("desktop:net-fetch", async (event, payload: unknown) => {
    assertTrustedSender(event);
    if (!payload || typeof payload !== "object") throw new Error("Invalid net-fetch payload");
    const { appId, url, method, headers } = payload as { appId?: unknown; url?: unknown; method?: unknown; headers?: unknown };
    if (typeof appId !== "string" || typeof url !== "string") throw new Error("net-fetch requires appId and url");
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("Only http(s) URLs are fetchable");
    await requestCore("network.authorize", { appId, capability: "network.access" });
    const fetchInit: RequestInit = { method: typeof method === "string" && method ? method : "GET" };
    if (headers && typeof headers === "object") fetchInit.headers = headers as Record<string, string>;
    const response = await net.fetch(url, fetchInit);
    const responseHeaders: Record<string, string> = {};
    for (const header of ["content-type", "retry-after"]) {
      const value = response.headers.get(header);
      if (value) responseHeaders[header] = value;
    }
    const bodyText = await response.text();
    return { status: response.status, headers: responseHeaders, bodyText };
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
      appId: "system.workspace",
      relativeDirectory,
    });
  });

  ipcMain.handle("desktop:workspace-page", async (event, relativeDirectory: unknown, offset: unknown) => {
    assertTrustedSender(event);
    if (typeof relativeDirectory !== "string" || typeof offset !== "number" || !Number.isFinite(offset)) {
      throw new Error("Invalid workspace page request");
    }
    return requestCore("workspace.page", { appId: "system.workspace", relativeDirectory, offset, limit: 120 });
  });

  ipcMain.handle("desktop:workspace-search", async (event, query: unknown) => {
    assertTrustedSender(event);
    if (typeof query !== "string") throw new Error("Invalid search query");
    return requestCore("workspace.search", { appId: "system.workspace", query, limit: 100 });
  });

  ipcMain.handle("desktop:workspace-mkdir", async (event, relativeDirectory: unknown, name: unknown) => {
    assertTrustedSender(event);
    if (typeof relativeDirectory !== "string" || typeof name !== "string") throw new Error("Invalid folder request");
    return requestCore("workspace.mkdir", { appId: "system.workspace", relativeDirectory, name });
  });

  ipcMain.handle("desktop:workspace-rename", async (event, uri: unknown, name: unknown) => {
    assertTrustedSender(event);
    if (typeof uri !== "string" || typeof name !== "string") throw new Error("Invalid rename request");
    return requestCore("workspace.rename", { appId: "system.workspace", uri, name });
  });

  ipcMain.handle("desktop:workspace-move", async (event, uri: unknown, targetDirectoryUri: unknown) => {
    assertTrustedSender(event);
    if (typeof uri !== "string" || (targetDirectoryUri !== null && typeof targetDirectoryUri !== "string")) {
      throw new Error("Invalid move request");
    }
    return requestCore("workspace.move", {
      appId: "system.workspace",
      uri,
      targetDirectoryUri: targetDirectoryUri ?? undefined,
    });
  });

  ipcMain.handle("desktop:workspace-preview", async (event, uri: unknown) => {
    assertTrustedSender(event);
    if (typeof uri !== "string" || !uri.startsWith("workspace://")) throw new Error("Invalid resource URI");
    return requestCore("workspace.preview", { appId: "system.workspace", uri });
  });

  ipcMain.handle("desktop:workspace-import", async (event, sourcePaths: unknown, targetDirectoryUri: unknown) => {
    assertTrustedSender(event);
    if (!Array.isArray(sourcePaths) || sourcePaths.some((item) => typeof item !== "string")) {
      throw new Error("Invalid import paths");
    }
    if (targetDirectoryUri !== null && typeof targetDirectoryUri !== "string") throw new Error("Invalid import destination");
    return requestCore("workspace.import", { appId: "system.workspace", sourcePaths, targetDirectoryUri: targetDirectoryUri ?? undefined });
  });

  ipcMain.handle("desktop:workspace-open", async (event, uri: unknown) => {
    assertTrustedSender(event);
    if (typeof uri !== "string" || !uri.startsWith("workspace://")) throw new Error("Invalid resource URI");
    const target = await requestCore("workspace.resolve", { appId: "system.workspace", uri });
    const failure = await shell.openPath(target.nativePath);
    if (failure) throw new Error(failure);
  });

  ipcMain.handle("desktop:workspace-trash", async (event, uri: unknown) => {
    assertTrustedSender(event);
    if (typeof uri !== "string" || !uri.startsWith("workspace://")) throw new Error("Invalid resource URI");
    const target = await requestCore("workspace.resolveWrite", { appId: "system.workspace", uri });
    await shell.trashItem(target.nativePath);
    return { trashed: true as const };
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

  ipcMain.handle("desktop:appearance-get", async (event) => {
    assertTrustedSender(event);
    return requestCore("preferences.get", {});
  });

  ipcMain.handle("desktop:appearance-set-dock-scale", async (event, value: unknown) => {
    assertTrustedSender(event);
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid dock scale");
    const preferences = await requestCore("preferences.set", { dockScale: value });
    mainWindow?.webContents.send("desktop:dock-scale-changed", preferences.dockScale);
    return preferences;
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
      preload: path.join(runtimeDirectory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => {
    const audioOnly = permission === "media" && "mediaTypes" in details && details.mediaTypes?.length === 1 && details.mediaTypes[0] === "audio";
    callback(contents === mainWindow?.webContents && contents.getURL().startsWith("xiling://app/") && audioOnly === true);
  });
  mainWindow.webContents.once("did-finish-load", () => {
    rendererReady = true;
    if (launchSmoke) {
      void requestCore("system.ping", {});
      void mainWindow?.webContents
        .executeJavaScript(`
          document.querySelector('[data-app="workspace"]')?.click();
          new Promise((resolve) => {
            const started = Date.now();
            const check = () => {
              if (document.querySelector('.managed-window[data-app="workspace"] .workspace-file-toolbar input[type="search"]') && document.querySelector('.workspace-breadcrumbs') && document.querySelector('.workspace-preview-panel') && document.querySelector('.managed-window-resizer')) return resolve(true);
              if (Date.now() - started > 5000) return resolve(false);
              setTimeout(check, 25);
            };
            check();
          });
        `)
        .then((ready) => {
          managedWindowReady = ready === true;
          if (!managedWindowReady) throw new Error("React workspace window did not open with resize controls");
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
