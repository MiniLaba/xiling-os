import { BotEngine, type BotFrame } from "../../vendor/bloub/src/bot/engine";
import { NOTIF_BLUE } from "../../vendor/bloub/src/bot/decor";
import { RAYON, DEMI_VIEWBOX } from "../../vendor/bloub/src/bot/repere";
import { mixHex } from "../../vendor/bloub/src/bot/skins";
import type { StateId } from "../../vendor/bloub/src/bot/states";

declare global {
  interface Window {
    xilingDesktop: {
      ignoreMouse(ignore: boolean): void;
      petClick(): void;
      petMenu(): void;
      petDrag(dx: number, dy: number): void;
      onStatus(callback: (status: string) => void): () => void;
    };
  }
}

const OCEAN_INK = "#5EC8F8";
const OCEAN_PAPER = "#07263d";
const VB = DEMI_VIEWBOX;
const HIT_RADIUS = 108;

const statusToState: Record<string, StateId> = {
  starting: "swirl",
  idle: "idle",
  busy: "orbit",
  done: "burst",
  attention: "alert",
  sleep: "sleep",
};

const stage = document.getElementById("stage");
if (!stage) throw new Error("missing #stage");

const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
svg.setAttribute("viewBox", `${-VB} ${-VB} ${VB * 2} ${VB * 2}`);
svg.setAttribute("width", "100%");
svg.setAttribute("height", "100%");
svg.style.display = "block";
stage.append(svg);

const engine = new BotEngine(RAYON, "idle");
let clock = 0;
let last = 0;
let currentStatus = "idle";

function applyStatus(status: string) {
  currentStatus = status;
  const next = statusToState[status] ?? "idle";
  if (engine.state !== next) engine.setState(next, clock);
}

window.xilingDesktop?.onStatus?.(applyStatus);

function render(frame: BotFrame) {
  const uid = "pet";
  const dots = (behind: boolean) =>
    frame.dots
      .filter(() => frame.dotsBehind === behind)
      .map((dot) => {
        const fill = dot.color ?? (dot.depth === undefined ? OCEAN_INK : mixHex(OCEAN_PAPER, OCEAN_INK, dot.depth));
        if (dot.d) {
          return `<path d="${dot.d}" fill="${fill}" opacity="${dot.opacity}" transform="translate(${dot.x} ${dot.y}) rotate(${dot.rot ?? 0}) scale(${RAYON})"></path>`;
        }
        return `<circle cx="${dot.x}" cy="${dot.y}" r="${dot.r}" fill="${fill}" opacity="${dot.opacity}"></circle>`;
      })
      .join("");
  const arcs = (side: "back" | "front") =>
    frame.arcs
      .map((arc) => {
        const d = side === "back" ? arc.back : arc.front;
        if (!d) return "";
        return `<path d="${d}" fill="none" stroke="url(#arc-${uid}-${arc.id})" stroke-width="${arc.width}" stroke-linecap="round" opacity="${arc.opacity}"></path>`;
      })
      .join("");
  const grads = frame.arcs
    .map(
      (arc) =>
        `<linearGradient id="arc-${uid}-${arc.id}" x1="${arc.grad.x1}" y1="${arc.grad.y1}" x2="${arc.grad.x2}" y2="${arc.grad.y2}">${arc.grad.stops
          .map((stop, index) => `<stop offset="${index / Math.max(1, arc.grad.stops.length - 1)}" stop-color="${stop}"></stop>`)
          .join("")}</linearGradient>`,
    )
    .join("");
  const notch = frame.notch
    ? `<circle cx="${frame.notch.x}" cy="${frame.notch.y}" r="${frame.notch.r}" fill="#000"></circle>`
    : "";
  const eyes = frame.eyes
    .map((eye) => `<path d="${eye.d}" fill="#f7fbff" opacity="${eye.alpha}" transform="${eye.matrix}"></path>`)
    .join("");
  const notif = frame.notif
    ? `<circle cx="${frame.notif.x}" cy="${frame.notif.y}" r="${frame.notif.r}" fill="${NOTIF_BLUE}"></circle>`
    : "";
  svg.innerHTML = `
    <defs>
      <mask id="body-mask-${uid}">
        <rect x="${-VB}" y="${-VB}" width="${VB * 2}" height="${VB * 2}" fill="#fff"></rect>
        ${notch}
      </mask>
      ${grads}
    </defs>
    ${arcs("back")}
    ${dots(true)}
    <path d="${frame.bodyPath}" fill="${OCEAN_INK}" opacity="${frame.bodyAlpha}" mask="url(#body-mask-${uid})"></path>
    ${eyes}
    ${dots(false)}
    ${notif}
    ${arcs("front")}
  `;
}

function tick(ms: number) {
  requestAnimationFrame(tick);
  const dt = last ? Math.min((ms - last) / 1000, 0.064) : 0;
  last = ms;
  clock += dt;
  render(engine.sample(clock));
}
requestAnimationFrame(tick);

let pointerId: number | null = null;
let dragging = false;
let moved = false;
let lastX = 0;
let lastY = 0;

function pointInBall(event: PointerEvent) {
  const box = svg.getBoundingClientRect();
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;
  const nx = ((event.clientX - cx) / box.width) * (VB * 2);
  const ny = ((event.clientY - cy) / box.height) * (VB * 2);
  return Math.hypot(nx, ny) <= HIT_RADIUS;
}

window.addEventListener("pointermove", (event) => {
  if (pointerId === null) window.xilingDesktop?.ignoreMouse?.(!pointInBall(event));
  if (engine.state === "idle" || engine.state === "sleep") {
    const box = svg.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) {
      const nx = Math.max(-1, Math.min(1, (event.clientX - (box.left + box.width / 2)) / Math.max(1, window.innerWidth / 2)));
      const ny = Math.max(-1, Math.min(1, (event.clientY - (box.top + box.height / 2)) / Math.max(1, window.innerHeight / 2)));
      engine.setLook({ yaw: nx * 28, pitch: ny * 18, mix: 0.85, spin: 0, wander: 0.15 }, clock);
    }
  }
  if (pointerId !== event.pointerId) return;
  const dx = event.screenX - lastX;
  const dy = event.screenY - lastY;
  if (Math.hypot(dx, dy) > 3) {
    dragging = true;
    moved = true;
    stage.classList.add("dragging");
  }
  if (dragging) window.xilingDesktop?.petDrag?.(dx, dy);
  lastX = event.screenX;
  lastY = event.screenY;
});

stage.addEventListener("pointerdown", (event) => {
  if (event.button === 2) {
    event.preventDefault();
    window.xilingDesktop?.petMenu?.();
    return;
  }
  if (event.button !== 0 || !pointInBall(event)) return;
  pointerId = event.pointerId;
  dragging = false;
  moved = false;
  lastX = event.screenX;
  lastY = event.screenY;
  stage.setPointerCapture(event.pointerId);
});

stage.addEventListener("pointerup", (event) => {
  if (pointerId !== event.pointerId) return;
  stage.releasePointerCapture(event.pointerId);
  pointerId = null;
  stage.classList.remove("dragging");
  if (!moved) window.xilingDesktop?.petClick?.();
  dragging = false;
});

stage.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  window.xilingDesktop?.petMenu?.();
});

applyStatus(currentStatus);
