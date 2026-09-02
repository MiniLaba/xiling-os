// 汐灵科研桌面 V2 renderer 逻辑：Leopard 桌面外壳（时钟、核心状态、
// 桌面图标、可拖动 Aqua 窗口、程序坞放大/弹跳）。无框架，直接操作 DOM；
// 动态样式走 CSSOM（CSP style-src 'self' 禁止内联样式属性）。

const MAG_RANGE = 78; // 高斯衰减半径（px）
const MAG_MAX = 0.8;  // 最大额外放大倍数

const clock = document.querySelector("#clock");
const aboutClock = document.querySelector("#about-clock");
const runtime = document.querySelector("#runtime");
const dock = document.querySelector("#dock");
const dockFan = document.querySelector("#dock-fan");
const toast = document.querySelector("#toast");
const root = document.querySelector("#leopard");
let managedWindowRuntime;

async function openManagedApp(app) {
  managedWindowRuntime ??= import("./generated/window-runtime.js");
  const runtimeModule = await managedWindowRuntime;
  runtimeModule.openManagedApp(app);
}

/* ---------- 时钟 ---------- */

function leopardClockText() {
  const now = new Date();
  const date = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" }).format(now);
  const weekday = new Intl.DateTimeFormat("zh-CN", { weekday: "short" }).format(now);
  const time = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
  return `${date} ${weekday} ${time}`;
}

function updateClock() {
  const text = leopardClockText();
  if (clock) clock.textContent = text;
  if (aboutClock) aboutClock.textContent = text;
}

updateClock();
setInterval(updateClock, 15_000);

/* ---------- 科研核心状态（IPC） ---------- */

async function updateRuntime() {
  try {
    const info = await window.xilingDesktop?.getRuntimeInfo();
    if (runtime) runtime.textContent = info?.coreReady ? "科研核心已就绪" : "科研核心按需待命";
    if (runtime) runtime.dataset.ready = info?.coreReady ? "true" : "false";
  } catch {
    if (runtime) runtime.textContent = "科研核心不可用";
    if (runtime) runtime.dataset.ready = "error";
  }
}

void updateRuntime();

/* ---------- 窗口管理 ---------- */

let zCounter = 10;
const dragState = { window: null, dx: 0, dy: 0 };

function windowEl(id) {
  return document.querySelector(`#window-${id}`);
}

function bringToFront(element) {
  zCounter += 1;
  element.style.zIndex = String(zCounter);
}

let windowStateRestored = false;

async function openWindow(id) {
  await restoreWindowStates();
  const element = windowEl(id);
  if (!element) return;
  element.dataset.open = "true";
  element.dataset.minimized = "false";
  bringToFront(element);
  scheduleWindowSave(element);
  if (id === "workspace") void refreshWorkspaceFiles();
}

function closeWindow(id) {
  const element = windowEl(id);
  if (element) {
    element.dataset.open = "false";
    if (id === "workspace") disconnectWorkspaceWatcher();
    scheduleWindowSave(element);
  }
}

const appIdForWindow = { workspace: "system.research", about: "system.settings" };
let windowSaveTimer = 0;

function windowState(element) {
  const rect = element.getBoundingClientRect();
  const id = element.id.replace("window-", "");
  return {
    id,
    appId: appIdForWindow[id] ?? "system.settings",
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    zIndex: Number(element.style.zIndex || 10),
    state: element.dataset.open !== "true" ? "minimized" : element.dataset.maximized === "true" ? "maximized" : "open",
    payload: {},
    updatedAt: new Date().toISOString(),
  };
}

function scheduleWindowSave(element) {
  window.clearTimeout(windowSaveTimer);
  windowSaveTimer = window.setTimeout(() => void window.xilingDesktop?.windowState.save(windowState(element)), 180);
}

async function restoreWindowStates() {
  if (windowStateRestored) return;
  windowStateRestored = true;
  try {
    const states = await window.xilingDesktop?.windowState.list();
    for (const state of states ?? []) {
      const element = windowEl(state.id);
      if (!element) continue;
      element.style.left = `${state.x}px`;
      element.style.top = `${state.y}px`;
      element.style.width = `${state.width}px`;
      element.style.height = `${state.height}px`;
      element.style.zIndex = String(state.zIndex);
      element.style.transform = "none";
      element.dataset.open = state.state === "minimized" ? "false" : "true";
      element.dataset.maximized = state.state === "maximized" ? "true" : "false";
      zCounter = Math.max(zCounter, state.zIndex);
    }
  } catch {
    // First launch has no persisted window state.
  }
}

function topOpenWindow() {
  const open = [...document.querySelectorAll(".leopard-window[data-open='true']")];
  return open.sort((a, b) => Number(b.style.zIndex || 10) - Number(a.style.zIndex || 10))[0];
}

for (const trigger of document.querySelectorAll("[data-open-window]")) {
  trigger.addEventListener("click", () => openWindow(trigger.dataset.openWindow));
}

for (const button of document.querySelectorAll("[data-window-action]")) {
  button.addEventListener("click", () => {
    const action = button.dataset.windowAction;
    if (action === "close" && button.dataset.window) closeWindow(button.dataset.window);
    if (action === "minimize" && button.dataset.window) closeWindow(button.dataset.window);
    if (action === "zoom" && button.dataset.window) {
      const element = windowEl(button.dataset.window);
      if (element) {
        element.dataset.maximized = element.dataset.maximized === "true" ? "false" : "true";
        bringToFront(element);
        scheduleWindowSave(element);
      }
    }
  });
}

window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (dockFan?.dataset.open === "true") {
    dockFan.dataset.open = "false";
    return;
  }
  const top = topOpenWindow();
  if (top) top.dataset.open = "false";
});

root?.addEventListener("pointerdown", (event) => {
  if (event.target !== root) return;
  for (const other of document.querySelectorAll(".leopard-desktop-icon")) {
    other.dataset.selected = "false";
  }
  if (dockFan) dockFan.dataset.open = "false";
});

/* ---------- 窗口拖动 ---------- */

for (const titlebar of document.querySelectorAll("[data-drag]")) {
  titlebar.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button")) return;
    const element = titlebar.closest(".leopard-window");
    if (!element) return;
    const rect = element.getBoundingClientRect();
    element.style.left = `${rect.left}px`;
    element.style.top = `${rect.top}px`;
    element.style.transform = "none";
    bringToFront(element);
    dragState.window = element;
    dragState.dx = event.clientX - rect.left;
    dragState.dy = event.clientY - rect.top;
    titlebar.setPointerCapture(event.pointerId);
  });
  titlebar.addEventListener("pointermove", (event) => {
    if (dragState.window !== titlebar.closest(".leopard-window")) return;
    dragState.window.style.left = `${event.clientX - dragState.dx}px`;
    dragState.window.style.top = `${event.clientY - dragState.dy}px`;
  });
  titlebar.addEventListener("pointerup", () => {
    if (dragState.window) scheduleWindowSave(dragState.window);
    dragState.window = null;
  });
}

/* ---------- 真实桌面文件夹 ---------- */

const chooseWorkspace = document.querySelector("#choose-workspace");
const refreshWorkspace = document.querySelector("#refresh-workspace");
const workspaceTitle = document.querySelector("#workspace-title");
const workspaceList = document.querySelector("#workspace-file-list");
const workspaceEmpty = document.querySelector("#workspace-empty");
const workspaceDropzone = document.querySelector("#workspace-dropzone");
const workspaceDesktopFiles = document.querySelector("#workspace-desktop-files");
let disconnectWorkspaceChanges;

function connectWorkspaceWatcher() {
  disconnectWorkspaceChanges ??= window.xilingDesktop?.workspace.onChanged(() => void refreshWorkspaceFiles());
}

function disconnectWorkspaceWatcher() {
  disconnectWorkspaceChanges?.();
  disconnectWorkspaceChanges = undefined;
}

function formatBytes(bytes) {
  if (bytes == null) return "文件夹";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function renderWorkspaceEntries(entries) {
  if (!workspaceList || !workspaceEmpty) return;
  workspaceList.replaceChildren();
  workspaceEmpty.hidden = entries.length > 0;
  for (const entry of entries) {
    const row = document.createElement("li");
    row.className = "workspace-file-row";
    const icon = document.createElement("span");
    icon.textContent = entry.kind === "directory" ? "▸" : "·";
    const name = document.createElement("span");
    name.className = "workspace-file-name";
    name.textContent = entry.name;
    const meta = document.createElement("span");
    meta.className = "workspace-file-meta";
    meta.textContent = formatBytes(entry.size);
    row.append(icon, name, meta);
    row.addEventListener("dblclick", () => void window.xilingDesktop?.workspace.open(entry.uri));
    workspaceList.append(row);
  }
  renderDesktopFiles(entries);
}

function renderDesktopFiles(entries) {
  if (!workspaceDesktopFiles) return;
  workspaceDesktopFiles.replaceChildren();
  const visible = entries.slice(0, 8);
  for (const entry of visible) {
    const button = document.createElement("button");
    button.className = "leopard-desktop-icon";
    button.type = "button";
    button.dataset.resourceUri = entry.uri;
    const tile = document.createElement("span");
    tile.className = "leopard-icon-tile";
    const symbol = document.createElement("span");
    symbol.className = "project-symbol neutral";
    symbol.textContent = entry.kind === "directory" ? "▰" : "▤";
    tile.append(symbol);
    const label = document.createElement("span");
    label.className = "leopard-icon-label";
    label.textContent = entry.name;
    button.append(tile, label);
    button.addEventListener("click", () => {
      for (const other of document.querySelectorAll(".leopard-desktop-icon")) other.dataset.selected = other === button ? "true" : "false";
    });
    button.addEventListener("dblclick", () => void window.xilingDesktop?.workspace.open(entry.uri));
    workspaceDesktopFiles.append(button);
  }
  if (entries.length > visible.length) {
    const more = document.createElement("span");
    more.className = "workspace-desktop-more";
    more.textContent = `另有 ${entries.length - visible.length} 项`;
    workspaceDesktopFiles.append(more);
  }
}

async function refreshWorkspaceFiles() {
  try {
    const rootInfo = await window.xilingDesktop?.workspace.get();
    if (!rootInfo) {
      if (workspaceTitle) workspaceTitle.textContent = "尚未选择桌面目录";
      renderWorkspaceEntries([]);
      return;
    }
    if (workspaceTitle) workspaceTitle.textContent = rootInfo.label;
    renderWorkspaceEntries(await window.xilingDesktop.workspace.list(""));
    connectWorkspaceWatcher();
  } catch (error) {
    showToast(error instanceof Error ? error.message : "无法读取桌面文件夹");
  }
}

chooseWorkspace?.addEventListener("click", async () => {
  const selected = await window.xilingDesktop?.workspace.select();
  if (selected) await refreshWorkspaceFiles();
});
refreshWorkspace?.addEventListener("click", () => void refreshWorkspaceFiles());

for (const eventName of ["dragenter", "dragover"]) {
  workspaceDropzone?.addEventListener(eventName, (event) => {
    event.preventDefault();
    workspaceDropzone.dataset.dragOver = "true";
  });
}
workspaceDropzone?.addEventListener("dragleave", () => { workspaceDropzone.dataset.dragOver = "false"; });
workspaceDropzone?.addEventListener("drop", async (event) => {
  event.preventDefault();
  workspaceDropzone.dataset.dragOver = "false";
  const files = [...(event.dataTransfer?.files ?? [])];
  if (!files.length) return;
  try {
    await window.xilingDesktop?.workspace.importDroppedFiles(files);
    await refreshWorkspaceFiles();
    showToast(`已导入 ${files.length} 个项目`);
  } catch (error) {
    showToast(error instanceof Error ? error.message : "导入失败");
  }
});

for (const eventName of ["dragenter", "dragover"]) {
  root?.addEventListener(eventName, (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
  });
}
root?.addEventListener("drop", async (event) => {
  if (event.target.closest(".leopard-window, .leopard-dock")) return;
  event.preventDefault();
  const files = [...(event.dataTransfer?.files ?? [])];
  if (!files.length) return;
  try {
    await window.xilingDesktop?.workspace.importDroppedFiles(files);
    await refreshWorkspaceFiles();
    showToast(`已放入桌面 ${files.length} 个项目`);
  } catch (error) {
    showToast(error instanceof Error ? error.message : "无法放入桌面");
  }
});

window.addEventListener("beforeunload", disconnectWorkspaceWatcher);

/* ---------- 桌面图标 ---------- */

for (const icon of document.querySelectorAll(".leopard-desktop-icon")) {
  icon.addEventListener("click", () => {
    for (const other of document.querySelectorAll(".leopard-desktop-icon")) {
      other.dataset.selected = other === icon ? "true" : "false";
    }
  });
  icon.addEventListener("dblclick", () => openWindow(icon.dataset.target));
}

root?.addEventListener("pointerdown", (event) => {
  if (event.target !== root) return;
  for (const other of document.querySelectorAll(".leopard-desktop-icon")) {
    other.dataset.selected = "false";
  }
});

/* ---------- 轻提示 ---------- */

let toastTimer = 0;
function showToast(text) {
  if (!toast) return;
  toast.textContent = text;
  toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { toast.hidden = true; }, 1600);
}

/* ---------- 程序坞 ---------- */

const tiles = dock ? [...dock.querySelectorAll(".leopard-dock-tile")] : [];
const figures = tiles.map((tile) => tile.querySelector(".dock-figure"));

function setMagnify(active) {
  if (dock) dock.dataset.magnify = active ? "true" : "false";
}

function resetScales() {
  for (const figure of figures) figure.style.transform = "scale(1)";
  setMagnify(false);
}

dock?.addEventListener("pointermove", (event) => {
  const dockLeft = dock.getBoundingClientRect().left;
  setMagnify(true);
  tiles.forEach((tile, index) => {
    const center = dockLeft + tile.offsetLeft + tile.offsetWidth / 2;
    const distance = event.clientX - center;
    const scale = 1 + MAG_MAX * Math.exp(-(distance * distance) / (2 * MAG_RANGE * MAG_RANGE));
    figures[index].style.transform = `scale(${scale.toFixed(3)})`;
  });
});

dock?.addEventListener("pointerleave", resetScales);

function setFanOpen(open) {
  if (dockFan) dockFan.dataset.open = open ? "true" : "false";
}

for (const item of dockFan?.querySelectorAll(".fan-item") ?? []) {
  item.addEventListener("click", (event) => {
    event.stopPropagation();
    showToast(`产物「${item.dataset.label}」即将推出`);
  });
}

tiles.forEach((tile) => {
  tile.addEventListener("click", () => {
    tile.dataset.bounce = "true";
    const app = tile.dataset.app;
    if (app === "workspace" || app === "about") openWindow(app);
    else if (app === "artifacts") setFanOpen(dockFan?.dataset.open !== "true");
    else if (["chat", "research", "literature", "data", "settings"].includes(app)) void openManagedApp(app);
    else if (app !== "trash") showToast(`「${tile.getAttribute("aria-label")}」即将推出`);
  });
  tile.addEventListener("animationend", () => { tile.dataset.bounce = "false"; });
});
