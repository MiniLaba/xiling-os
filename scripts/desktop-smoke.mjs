import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = resolve(root, "apps/desktop");
const failures = [];

for (const path of [
  "apps/desktop/src/main.mjs",
  "apps/desktop/preload.cjs",
  "apps/desktop/pet/index.html",
  "apps/desktop/pet/src/main.ts",
  "apps/desktop/icons/logo.png",
  "apps/desktop/scripts/bundle-pet.mjs",
  "apps/desktop/scripts/after-pack.cjs",
  "apps/desktop/scripts/fill-stage-deps.mjs",
  "apps/desktop/scripts/ensure-built.mjs",
  "apps/desktop/scripts/launch-electron.mjs",
  "apps/desktop/vendor/bloub/LICENSE",
  "apps/desktop/vendor/bloub/src/bot/engine.ts",
  "一键启动桌面端.bat",
  "一键启动桌面端.sh",
  "一键打包.bat",
  "一键打包.sh",
  ".github/workflows/desktop-pack.yml",
]) {
  if (!existsSync(resolve(root, path))) failures.push(`missing ${path}`);
}
const packBat = readFileSync(resolve(root, "一键打包.bat"), "utf8");
if (!packBat.includes("%~dp0安装包")) failures.push("pack bat must open the absolute 安装包 folder");
if (!packBat.includes("if not exist \"%OUT%\\*.exe\"")) failures.push("pack bat must refuse to open Explorer when no installer exists");
if (packBat.includes("pnpm desktop:pack") || packBat.includes("pnpm desktop")) failures.push("pack bat must call node pack.mjs directly");
if (!packBat.includes("apps\\desktop\\scripts\\pack.mjs")) failures.push("pack bat must run apps\\desktop\\scripts\\pack.mjs");
if (!readFileSync(resolve(desktop, "scripts/pack.mjs"), "utf8").includes("旧的${label}正在被占用")) {
  failures.push("pack script must explain a locked release folder in Chinese");
}
const startBat = readFileSync(resolve(root, "一键启动桌面端.bat"), "utf8");
if (startBat.includes("pnpm desktop")) failures.push("start bat must not call pnpm desktop");
if (!startBat.includes("apps\\desktop\\scripts\\launch-electron.mjs")) failures.push("start bat must run launch-electron.mjs");
const packSh = readFileSync(resolve(root, "一键打包.sh"), "utf8");
if (!packSh.includes("apps/desktop/scripts/pack.mjs") || packSh.includes("pnpm desktop:pack")) {
  failures.push("pack sh must call node pack.mjs directly");
}
const startSh = readFileSync(resolve(root, "一键启动桌面端.sh"), "utf8");
if (startSh.includes("pnpm desktop") || !startSh.includes("apps/desktop/scripts/launch-electron.mjs")) {
  failures.push("start sh must run launch-electron.mjs and not call pnpm desktop");
}
const packScript = readFileSync(resolve(desktop, "scripts/pack.mjs"), "utf8");
if (!packScript.includes('process.platform === "win32" && !existsSync(resolve(desktopRoot, "icons/icon.ico"))')) {
  failures.push("pack script must require icon.ico only on Windows so Mac/Linux can pack");
}

const main = readFileSync(resolve(desktop, "src/main.mjs"), "utf8");
for (const token of ["alwaysOnTop", "XILING_NODE_BINARY", "desktop:pet-click", "apps/server/dist/index.js", "XILING_WEB_ROOT", "XILING_SKILLS_ROOT", "api/agent-center/activity", "安装包不完整"]) {
  if (!main.includes(token)) failures.push(`desktop main is missing ${token}`);
}
const serverApp = readFileSync(resolve(root, "apps/server/src/app.ts"), "utf8");
if (!serverApp.includes("process.env.XILING_WEB_ROOT")) failures.push("server is missing XILING_WEB_ROOT for packaged desktop");
if (!serverApp.includes("process.env.XILING_SKILLS_ROOT")) failures.push("server is missing XILING_SKILLS_ROOT for packaged desktop");
const routes = readFileSync(resolve(root, "apps/server/src/modules/agent-center/routes.ts"), "utf8");
if (!routes.includes("/api/agent-center/activity")) failures.push("server is missing the desktop pet activity endpoint");

const pet = readFileSync(resolve(desktop, "pet/src/main.ts"), "utf8");
if (!pet.includes("vendor/bloub/src/bot/engine")) failures.push("pet renderer does not reuse the Bloub engine");
if (!pet.includes("#5EC8F8")) failures.push("pet renderer is missing the ocean color");
if (!pet.includes('starting: "swirl"')) failures.push("pet should start as swirl, not thinking");
if (!pet.includes("xilingDesktop?.onStatus")) failures.push("pet must not crash when preload is missing");

const license = readFileSync(resolve(desktop, "vendor/bloub/LICENSE"), "utf8");
if (!license.includes("MIT License")) failures.push("vendored Bloub LICENSE is not MIT");

if (failures.length) {
  console.error(`Desktop smoke failed:\n${failures.map((item) => `- ${item}`).join("\n")}`);
  process.exit(1);
}

const require = createRequire(resolve(desktop, "package.json"));
let esbuildBin;
try {
  esbuildBin = resolve(dirname(require.resolve("esbuild/package.json")), "bin/esbuild");
} catch {
  esbuildBin = undefined;
}
if (esbuildBin && existsSync(esbuildBin)) {
  const bundle = spawnSync(process.execPath, [resolve(desktop, "scripts/bundle-pet.mjs")], { cwd: desktop, stdio: "inherit" });
  if (bundle.status !== 0) process.exit(bundle.status ?? 1);
  if (!existsSync(resolve(desktop, "pet/dist/pet.js"))) {
    console.error("Desktop smoke failed: pet bundle was not written");
    process.exit(1);
  }
} else {
  console.log("esbuild not installed yet; skipped pet bundle in desktop smoke");
}

const desktopManifest = JSON.parse(readFileSync(resolve(desktop, "package.json"), "utf8"));
if (desktopManifest.scripts?.["make-installer"] !== "node scripts/bundle-pet.mjs && node scripts/pack.mjs") {
  console.error("Desktop installer script must be make-installer, not pnpm pack");
  process.exit(1);
}
if (desktopManifest.build?.productName !== "汐灵" || desktopManifest.build?.nsis?.shortcutName !== "汐灵") {
  console.error("Desktop installer name and shortcut must be 汐灵");
  process.exit(1);
}
if (desktopManifest.build?.win?.signAndEditExecutable === false) {
  console.error("Windows pack must keep signAndEditExecutable enabled so the water-drop icon is written into the exe");
  process.exit(1);
}
if (desktopManifest.build?.win?.signExecutable !== false) {
  console.error("Windows pack must set signExecutable false without skipping resource editing");
  process.exit(1);
}
if (desktopManifest.build?.afterPack !== "./scripts/after-pack.cjs") {
  console.error("Desktop pack must copy server node_modules and stamp the Windows icon in afterPack");
  process.exit(1);
}
if (desktopManifest.build?.win?.icon !== "icons/icon.ico" || desktopManifest.build?.nsis?.installerIcon !== "icons/icon.ico") {
  console.error("Windows installer must use icons/icon.ico");
  process.exit(1);
}
if (!existsSync(resolve(desktop, "icons/icon.ico"))) {
  console.error("Missing apps/desktop/icons/icon.ico for the Windows desktop shortcut");
  process.exit(1);
}
const afterPack = readFileSync(resolve(desktop, "scripts/after-pack.cjs"), "utf8");
if (!afterPack.includes("stamped windows icon") || !afterPack.includes("--set-icon")) {
  console.error("afterPack must stamp the water-drop icon onto the Windows exe");
  process.exit(1);
}
const rootManifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
if (!rootManifest.scripts?.desktop?.includes("ensure-built.mjs") || rootManifest.scripts.desktop.includes("pnpm build")) {
  console.error("Root desktop must skip rebuild when dist already exists");
  process.exit(1);
}
if (!rootManifest.scripts?.["desktop:pack"]?.includes("apps/desktop/scripts/pack.mjs") || rootManifest.scripts["desktop:pack"].includes("--filter")) {
  console.error("Root desktop:pack must run apps/desktop/scripts/pack.mjs directly, not pnpm pack or --filter");
  process.exit(1);
}
const ensureBuilt = readFileSync(resolve(desktop, "scripts/ensure-built.mjs"), "utf8");
if (ensureBuilt.includes("--filter")) {
  console.error("ensure-built must not use pnpm --filter (it prunes the workspace)");
  process.exit(1);
}
const npmrc = readFileSync(resolve(root, ".npmrc"), "utf8");
if (!npmrc.includes("verify-deps-before-run=false")) {
  console.error(".npmrc must disable verify-deps-before-run so pnpm scripts cannot prune node_modules");
  process.exit(1);
}

console.log("Desktop shell smoke: ok");
