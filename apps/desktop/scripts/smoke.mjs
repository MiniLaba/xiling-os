import { access, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const packageRoot = path.resolve(process.cwd());
const required = [
  "dist/main.js",
  "dist/preload.cjs",
  "dist/core-entry.js",
  "renderer/index.html",
  "renderer/shell.css",
  "renderer/shell.js",
  "renderer/generated/window-runtime.js",
  "renderer/assets/dock-icons/la-capitaine/workbench.svg",
  "renderer/assets/dock-icons/la-capitaine/chat.svg",
  "renderer/assets/dock-icons/la-capitaine/research.svg",
  "renderer/assets/dock-icons/la-capitaine/literature.svg",
  "renderer/assets/dock-icons/la-capitaine/data.svg",
  "renderer/assets/dock-icons/la-capitaine/artifacts.svg",
  "renderer/assets/dock-icons/la-capitaine/settings.svg",
  "renderer/assets/dock-icons/la-capitaine/trash.svg",
  "renderer/assets/dock-icons/la-capitaine/applications-other.svg",
  "renderer/assets/dock-icons/la-capitaine/LICENSE",
  "renderer/assets/dock-icons/la-capitaine/COPYING",
  "renderer/assets/dock-icons/la-capitaine/Credits.md",
];
await Promise.all(required.map((file) => access(path.join(packageRoot, file))));

const main = await readFile(path.join(packageRoot, "dist/main.js"), "utf8");
const html = await readFile(path.join(packageRoot, "renderer/index.html"), "utf8");
const css = await readFile(path.join(packageRoot, "renderer/shell.css"), "utf8");
const shell = await readFile(path.join(packageRoot, "renderer/shell.js"), "utf8");

for (const invariant of ["contextIsolation: true", "nodeIntegration: false", "sandbox: true", "requestSingleInstanceLock", "XiLing OS Desktop"]) {
  if (!main.includes(invariant)) throw new Error(`Desktop security invariant missing: ${invariant}`);
}
if (!html.includes("Content-Security-Policy")) throw new Error("Desktop renderer CSP missing");
if (html.includes("generated/window-runtime.js")) {
  throw new Error("React window runtime must remain lazy and absent from cold-launch scripts");
}
if (html.includes('id="window-workspace"')) {
  throw new Error("Static workspace window must not coexist with the React window manager");
}
for (const dockIcon of ["workbench", "chat", "research", "artifacts", "settings", "trash"]) {
  if (!html.includes(`dock-icons/la-capitaine/${dockIcon}.svg`)) throw new Error(`La Capitaine dock icon missing: ${dockIcon}`);
}
if (html.includes("dock-gap")) throw new Error("Dock spacing must not reserve a separator slot");
if (!css.includes('.leopard-dock-tile[data-app="settings"]::after')) throw new Error("Dock separator must be decorative");
if (!css.includes("gap: 14px")) throw new Error("Dock spacing must remain comfortably expanded and uniform");
if (shell.includes("assets/oxygen/")) throw new Error("Dock must not fall back to the legacy Oxygen icon theme");
// 悬浮程序坞：玻璃台面与倒影已退场，弹跳仅作用于图标本体
for (const dockFloatingInvariant of [
  "@keyframes leopard-bounce-icon",
  '.leopard-dock-tile[data-bounce="true"] .dock-icon',
  ".dock-reflection, .dock-contact { display: none; }",
]) {
  if (!css.includes(dockFloatingInvariant)) throw new Error(`Floating dock invariant missing: ${dockFloatingInvariant}`);
}
if (html.includes("dock-shelf")) throw new Error("Floating dock must not render a glass shelf");
if (css.includes("leopard-bounce-reflection")) throw new Error("Reflection motion must be removed with the glass shelf");
for (const dockMagnificationInvariant of ["requestAnimationFrame(renderDockMagnification)", "cancelAnimationFrame(magnifyFrame)"]) {
  if (!shell.includes(dockMagnificationInvariant)) throw new Error(`Smooth dock magnification invariant missing: ${dockMagnificationInvariant}`);
}
for (const [name, pattern] of [
  ["menu buttons", /\.leopard-menubar button\s*\{[^}]*border-radius:\s*999px;/s],
  ["status items", /\.core-status,\s*\.menubar-system-icon,\s*\.leopard-clock\s*\{[^}]*border-radius:\s*999px;/s],
  ["centered brand", /\.leopard-menubar-brand\s*\{[^}]*align-items:\s*center;[^}]*justify-content:\s*center;[^}]*height:\s*26px;/s],
]) {
  if (!pattern.test(css)) throw new Error(`Apple-style menubar capsule invariant missing: ${name}`);
}

const windowRuntime = await readFile(path.join(packageRoot, "renderer/generated/window-runtime.js"));
const kernelHost = await readFile(path.join(packageRoot, "dist/os-kernel-host.js"), "utf8");
if (kernelHost.includes("ScriptedRuntimeAdapter") || kernelHost.includes("scripted noop")) {
  throw new Error("Production host must never simulate successful execution");
}
if (windowRuntime.byteLength > 350_000) {
  throw new Error(`React window runtime exceeds 350 KB: ${windowRuntime.byteLength}`);
}

console.log("Desktop foundation smoke passed");
