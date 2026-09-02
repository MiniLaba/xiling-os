const clock = document.querySelector("#clock");
const runtime = document.querySelector("#runtime");

function updateClock() {
  if (clock) clock.textContent = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", weekday: "short" }).format(new Date());
}

updateClock();
setInterval(updateClock, 30_000);

async function updateRuntime() {
  try {
    const info = await window.xilingDesktop?.getRuntimeInfo();
    if (runtime) runtime.textContent = info?.coreReady ? "科研核心已就绪" : "科研核心连接中";
    if (!info?.coreReady) setTimeout(updateRuntime, 500);
  } catch {
    if (runtime) runtime.textContent = "科研核心不可用";
  }
}

void updateRuntime();
