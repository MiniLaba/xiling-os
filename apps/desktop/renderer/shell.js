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
    if (runtime) runtime.textContent = info?.coreReady ? "科研核心已就绪" : "科研核心连接中";
    if (runtime) runtime.dataset.ready = info?.coreReady ? "true" : "false";
    if (!info?.coreReady) setTimeout(updateRuntime, 500);
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

function openWindow(id) {
  const element = windowEl(id);
  if (!element) return;
  element.dataset.open = "true";
  bringToFront(element);
}

function closeWindow(id) {
  const element = windowEl(id);
  if (element) element.dataset.open = "false";
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
    if (action === "minimize") void window.xilingDesktop?.minimize();
    if (action === "zoom") void window.xilingDesktop?.toggleMaximize();
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
    dragState.window = null;
  });
}

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
    else if (app !== "trash") showToast(`「${tile.getAttribute("aria-label")}」即将推出`);
  });
  tile.addEventListener("animationend", () => { tile.dataset.bounce = "false"; });
});
