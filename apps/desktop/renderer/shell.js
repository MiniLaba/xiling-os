// 汐灵 AI 原生虚拟操作系统 renderer 宿主：菜单栏、桌面、多窗口与程序坞。
// 桌面图标、可拖动 Aqua 窗口、程序坞放大/弹跳）。无框架，直接操作 DOM；
// 动态样式走 CSSOM（CSP style-src 'self' 禁止内联样式属性）。

const MAG_RANGE = 78; // 高斯衰减半径（px）
const MAG_MAX = 0.8;  // 最大额外放大倍数
const MIN_DOCK_SCALE = 0.75;
const MAX_DOCK_SCALE = 1.25;
const DOCK_SCALE_STORAGE_KEY = "xiling:dock-scale";
function applyResearchTheme() {
  let preference = "lingjing";
  try { preference = localStorage.getItem("xiling-theme") || "lingjing"; } catch {}
  const resolved = preference === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "lingjing" : "poxiao") : preference === "poxiao" ? "poxiao" : "lingjing";
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved === "lingjing" ? "dark" : "light";
}
applyResearchTheme();
window.addEventListener("xiling:theme-change", applyResearchTheme);
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyResearchTheme);

const clock = document.querySelector("#clock");
const aboutClock = document.querySelector("#about-clock");
const runtime = document.querySelector("#runtime");
const dock = document.querySelector("#dock");
const dockFan = document.querySelector("#dock-fan");
const toast = document.querySelector("#toast");
const root = document.querySelector("#leopard");
let managedWindowRuntime;
let companionEnabled = false;
let companionModule;
let companionRevision = 0;
async function toggleCompanion(enabled) {
  companionEnabled = enabled === true;
  const revision = ++companionRevision;
  document.querySelector("#companion-toggle")?.setAttribute("aria-pressed", String(companionEnabled));
  try { localStorage.setItem("xiling:companion-enabled", String(companionEnabled)); } catch { /* preview */ }
  if (!companionEnabled) { companionModule?.mountCompanion(false); return; }
  try {
    companionModule ??= await import("./generated/companion.js");
    if (revision === companionRevision) companionModule.mountCompanion(true);
  } catch { document.querySelector("#companion-toggle")?.setAttribute("title", "伴侣加载失败，请重新构建应用"); }
}
document.querySelector("#companion-toggle")?.addEventListener("click", () => { void toggleCompanion(!companionEnabled); });
window.addEventListener("xiling:companion-enabled", (event) => { void toggleCompanion(event.detail); });
window.addEventListener("xiling:companion-open-app", (event) => { if (["chat", "tasks"].includes(event.detail)) void openManagedApp(event.detail); });
try { if (localStorage.getItem("xiling:companion-enabled") === "true") void toggleCompanion(true); } catch { /* preview */ }

function applyDockScale(value) {
  const numeric = Number(value);
  const scale = Number.isFinite(numeric) ? Math.min(MAX_DOCK_SCALE, Math.max(MIN_DOCK_SCALE, numeric)) : 1;
  dock?.style.setProperty("--dock-scale", String(scale));
  try { localStorage.setItem(DOCK_SCALE_STORAGE_KEY, String(scale)); } catch { /* file preview may deny storage */ }
}

try { applyDockScale(localStorage.getItem(DOCK_SCALE_STORAGE_KEY) ?? 1); } catch { applyDockScale(1); }
window.addEventListener("xiling:dock-scale-change", (event) => applyDockScale(event.detail));
void window.xilingDesktop?.appearance.get().then((preferences) => applyDockScale(preferences.dockScale));
window.xilingDesktop?.appearance.onDockScaleChanged(applyDockScale);

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
  return `${weekday} ${date} ${time}`;
}

function updateClock() {
  const text = leopardClockText();
  if (clock) clock.textContent = text;
  if (aboutClock) aboutClock.textContent = text;
}

updateClock();
setInterval(updateClock, 15_000);

/* ---------- AI OS 核心状态（IPC） ---------- */

async function updateRuntime() {
  try {
    const info = await window.xilingDesktop?.getRuntimeInfo();
    if (runtime) runtime.textContent = info?.coreReady ? "核心已就绪" : "核心待命";
    if (runtime) runtime.dataset.ready = info?.coreReady ? "true" : "false";
  } catch {
    if (runtime) runtime.textContent = "核心不可用";
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
}

function closeWindow(id) {
  const element = windowEl(id);
  if (element) {
    element.dataset.open = "false";
    scheduleWindowSave(element);
  }
}

const appIdForWindow = { about: "system.settings" };
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

const workspaceDesktopFiles = document.querySelector("#workspace-desktop-files");

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

async function refreshDesktopFiles() {
  try {
    const rootInfo = await window.xilingDesktop?.workspace.get();
    if (!rootInfo) {
      renderDesktopFiles([]);
      return;
    }
    renderDesktopFiles((await window.xilingDesktop.workspace.page("", 0)).entries);
  } catch (error) {
    showToast(error instanceof Error ? error.message : "无法读取桌面文件夹");
  }
}

for (const eventName of ["dragenter", "dragover"]) {
  root?.addEventListener(eventName, (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
  });
}
root?.addEventListener("drop", async (event) => {
  if (event.target.closest(".leopard-window, .managed-window, .leopard-dock")) return;
  event.preventDefault();
  const files = [...(event.dataTransfer?.files ?? [])];
  if (!files.length) return;
  try {
    await window.xilingDesktop?.workspace.importDroppedFiles(files);
    await refreshDesktopFiles();
    showToast(`已放入桌面 ${files.length} 个项目`);
  } catch (error) {
    showToast(error instanceof Error ? error.message : "无法放入桌面");
  }
});

window.addEventListener("xiling:workspace-entries", (event) => renderDesktopFiles(event.detail ?? []));

/* ---------- 桌面图标 ---------- */

for (const icon of document.querySelectorAll(".leopard-desktop-icon")) {
  icon.addEventListener("click", () => {
    for (const other of document.querySelectorAll(".leopard-desktop-icon")) {
      other.dataset.selected = other === icon ? "true" : "false";
    }
  });
  icon.addEventListener("dblclick", () => {
    if (icon.dataset.target === "workspace") void openManagedApp("workspace");
    else openWindow(icon.dataset.target);
  });
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

let tiles = dock ? [...dock.querySelectorAll(".leopard-dock-tile")] : [];
let figures = tiles.map((tile) => tile.querySelector(".dock-figure"));
let magnifyFrame = 0;
let dockPointerX = 0;

function refreshDockTiles() {
  tiles = dock ? [...dock.querySelectorAll(".leopard-dock-tile")] : [];
  figures = tiles.map((tile) => tile.querySelector(".dock-figure"));
}

function setMagnify(active) {
  if (dock) dock.dataset.magnify = active ? "true" : "false";
}

function resetScales() {
  if (magnifyFrame) window.cancelAnimationFrame(magnifyFrame);
  magnifyFrame = 0;
  for (const figure of figures) figure.style.transform = "scale(1)";
  setMagnify(false);
}

function renderDockMagnification() {
  magnifyFrame = 0;
  if (!dock) return;
  const dockLeft = dock.getBoundingClientRect().left;
  setMagnify(true);
  tiles.forEach((tile, index) => {
    const center = dockLeft + tile.offsetLeft + tile.offsetWidth / 2;
    const distance = dockPointerX - center;
    const scale = 1 + MAG_MAX * Math.exp(-(distance * distance) / (2 * MAG_RANGE * MAG_RANGE));
    figures[index].style.transform = `scale(${scale.toFixed(4)})`;
  });
}

dock?.addEventListener("pointermove", (event) => {
  dockPointerX = event.clientX;
  if (!magnifyFrame) magnifyFrame = window.requestAnimationFrame(renderDockMagnification);
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

// 点击/弹跳走事件委托：静态 tile 与插件注入的 tile 行为一致
const MANAGED_APPS = ["workspace", "chat", "tasks", "literature", "settings"];

dock?.addEventListener("click", (event) => {
  const tile = event.target.closest?.(".leopard-dock-tile");
  if (!tile) return;
  tile.dataset.bounce = "true";
  const app = tile.dataset.app;
  if (app === "about") openWindow(app);
  else if (app === "artifacts") setFanOpen(dockFan?.dataset.open !== "true");
  else if (MANAGED_APPS.includes(app)) void openManagedApp(app);
  else if (app !== "trash") showToast(`「${tile.getAttribute("aria-label")}」即将推出`);
});

dock?.addEventListener("animationend", (event) => {
  const tile = event.target.closest?.(".leopard-dock-tile");
  if (tile && event.animationName === "leopard-bounce-icon") tile.dataset.bounce = "false";
});

/* ---------- 插件 APP 注入：标准插件清单的 ui 描述符 → dock 图标 ---------- */

function iconSrcFor(iconKey) {
  const iconKeyName = String(iconKey ?? "").replace(/^system\./, "");
  const iconName = {
    workspace: "workbench",
    workbench: "workbench",
    chat: "chat",
    tasks: "research",
    literature: "literature",
    data: "data",
    artifacts: "artifacts",
    settings: "settings",
    trash: "trash",
  }[iconKeyName] ?? "applications-other";
  return `./assets/dock-icons/la-capitaine/${encodeURIComponent(iconName)}.svg`;
}

function buildPluginTile(app) {
  const tile = document.createElement("button");
  tile.className = "leopard-dock-tile";
  tile.type = "button";
  tile.dataset.app = (app.id ?? "").replace(/^system\./, "");
  tile.setAttribute("aria-label", app.name ?? app.id);
  tile.title = app.description ?? "";
  const figure = document.createElement("span");
  figure.className = "dock-figure";
  const label = document.createElement("span");
  label.className = "leopard-dock-label";
  label.textContent = app.name ?? "";
  const icon = document.createElement("span");
  icon.className = "dock-icon";
  const art = document.createElement("img");
  art.className = "dock-art";
  art.src = iconSrcFor(app.icon ?? app.id);
  art.alt = "";
  art.draggable = false;
  art.addEventListener("error", () => {
    if (art.dataset.fallback === "true") return;
    art.dataset.fallback = "true";
    art.src = iconSrcFor("applications-other");
  });
  icon.append(art);
  figure.append(label, icon);
  tile.append(figure);
  return tile;
}

async function syncDockFromApps() {
  if (!dock || !window.xilingDesktop?.listApps) return;
  let apps;
  try {
    apps = await window.xilingDesktop.listApps();
  } catch {
    return;
  }
  const known = new Set(tiles.map((tile) => tile.dataset.app));
  const trashTile = tiles.find((tile) => tile.dataset.app === "trash") ?? null;
  // tile 并非 #dock 的直接子元素（在 .dock-items 容器里）：插到 trash 的实际父节点
  const anchorParent = trashTile?.parentElement ?? dock;
  for (const app of apps) {
    if (!app.icon) continue;
    const appKey = (app.id ?? "").replace(/^system\./, "");
    if (known.has(appKey)) continue;
    const tile = buildPluginTile(app);
    anchorParent.insertBefore(tile, trashTile);
    known.add(appKey);
  }
  refreshDockTiles();
}

void syncDockFromApps();
