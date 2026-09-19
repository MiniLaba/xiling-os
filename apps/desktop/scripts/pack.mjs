import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { fillStageDependencies } from "./fill-stage-deps.mjs";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(desktopRoot, "../..");
const stage = resolve(desktopRoot, "stage");
const runtime = resolve(desktopRoot, "runtime");
const releaseDir = resolve(desktopRoot, "release");
const installerDir = resolve(repoRoot, "安装包");

function wait(ms) {
  spawnSync(process.execPath, ["-e", `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${ms})`], { windowsHide: true });
}

function stopPackLocks() {
  if (process.platform !== "win32") return;
  for (const image of ["汐灵.exe", "XiLing OS.exe", "xiling-desktop.exe"]) {
    spawnSync("taskkill", ["/IM", image, "/F"], { stdio: "ignore", windowsHide: true });
  }
}

function removeDir(path, label) {
  if (!existsSync(path)) return;
  stopPackLocks();
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 });
      return;
    } catch (error) {
      const busy = error && ["EPERM", "EBUSY", "ENOTEMPTY", "EACCES"].includes(error.code);
      if (!busy) throw error;
      console.log(`正在等待释放${label}（${attempt}/8）...`);
      wait(400);
    }
  }
  const parked = `${path}.old-${Date.now()}`;
  try {
    renameSync(path, parked);
    console.log(`旧的${label}正在被占用，已改名后继续打包`);
    return;
  } catch {
    console.error(`旧的${label}正在被占用，删不掉。`);
    console.error("请先关掉汐灵（主窗口和右下角悬浮球），并关掉打开该文件夹的资源管理器，然后重新双击「一键打包.bat」。");
    process.exit(1);
  }
}

function run(command, args, cwd = repoRoot, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: false,
    env: { ...process.env, ...extraEnv },
  });
  if (result.error) {
    console.error(`failed to spawn ${command}:`, result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function findPnpm() {
  if (process.env.npm_execpath && existsSync(process.env.npm_execpath) && /\.(exe|cjs|mjs|js|cmd)$/i.test(process.env.npm_execpath)) {
    return process.env.npm_execpath;
  }
  const lookup = spawnSync(process.platform === "win32" ? "where" : "which", ["pnpm"], { encoding: "utf8", shell: true });
  const candidates = lookup.stdout?.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) ?? [];
  return candidates.find((line) => existsSync(line) && /\.(exe|cmd|cjs|mjs|js)$/i.test(line)) ?? null;
}

function runPnpm(args, cwd = repoRoot) {
  const pnpm = findPnpm();
  const extraEnv = { CI: "true", NODE_ENV: "development" };
  if (pnpm && /\.exe$/i.test(pnpm)) {
    run(pnpm, args, cwd, extraEnv);
    return;
  }
  if (pnpm && /\.(c?js|mjs)$/i.test(pnpm)) {
    run(process.execPath, [pnpm, ...args], cwd, extraEnv);
    return;
  }
  const result = spawnSync(pnpm && /\.cmd$/i.test(pnpm) ? pnpm : "pnpm", args, {
    cwd,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, ...extraEnv },
  });
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!existsSync(resolve(repoRoot, "apps/server/dist/index.js")) || !existsSync(resolve(repoRoot, "apps/web/dist/index.html"))) {
  console.log("还没有构建产物，先执行 pnpm build");
  runPnpm(["build"]);
}

if (!existsSync(resolve(repoRoot, "apps/server/dist/index.js")) || !existsSync(resolve(repoRoot, "apps/web/dist/index.html"))) {
  console.error("pnpm build 之后仍然缺少 apps/server/dist 或 apps/web/dist");
  process.exit(1);
}

removeDir(stage, "临时目录");
removeDir(runtime, "运行时目录");
mkdirSync(runtime, { recursive: true });

console.log("creating a production server stage with pnpm deploy");
const deployTarget = resolve(tmpdir(), "xiling-desktop-stage");
rmSync(deployTarget, { recursive: true, force: true });
runPnpm(["--filter", "@xiling/server", "deploy", "--prod", "--legacy", deployTarget]);
mkdirSync(stage, { recursive: true });
cpSync(deployTarget, stage, { recursive: true, dereference: true });
mkdirSync(resolve(stage, "web"), { recursive: true });
cpSync(resolve(repoRoot, "apps/web/dist"), resolve(stage, "web/dist"), { recursive: true });
if (existsSync(resolve(repoRoot, "skills"))) {
  mkdirSync(resolve(stage, "skills"), { recursive: true });
  cpSync(resolve(repoRoot, "skills"), resolve(stage, "skills"), { recursive: true });
}
const filled = fillStageDependencies(stage, repoRoot);
console.log(`filled ${filled} missing production packages into the server stage`);

const nodeName = process.platform === "win32" ? "node.exe" : "node";
copyFileSync(process.execPath, resolve(runtime, nodeName));

run(process.execPath, [resolve(desktopRoot, "scripts/generate-icon.mjs")], desktopRoot);
if (!existsSync(resolve(desktopRoot, "icons/icon.png"))) {
  console.error("缺少 apps/desktop/icons/icon.png，桌面图标无法写入");
  process.exit(1);
}
if (process.platform === "win32" && !existsSync(resolve(desktopRoot, "icons/icon.ico"))) {
  console.error("缺少 apps/desktop/icons/icon.ico，Windows 桌面图标无法写入");
  process.exit(1);
}

removeDir(releaseDir, "打包目录");
const require = createRequire(import.meta.url);
const builderCli = resolve(dirname(require.resolve("electron-builder/package.json")), "cli.js");
const targets = process.platform === "darwin"
  ? ["--mac", "dmg"]
  : process.platform === "linux"
    ? ["--linux", "AppImage"]
    : ["--win", "nsis"];

run(process.execPath, [builderCli, ...targets, "--publish", "never"], desktopRoot, {
  CSC_IDENTITY_AUTO_DISCOVERY: "false",
});

if (!existsSync(releaseDir)) {
  console.error(`electron-builder 没有写出目录：${releaseDir}`);
  process.exit(1);
}
const installers = readdirSync(releaseDir).filter((name) => /\.(exe|dmg|AppImage)$/i.test(name));
if (installers.length === 0) {
  console.error(`打包完成但 ${releaseDir} 里没有安装包`);
  process.exit(1);
}

removeDir(installerDir, "安装包目录");
mkdirSync(installerDir, { recursive: true });
for (const name of installers) copyFileSync(join(releaseDir, name), join(installerDir, name));
console.log(`\n安装包已放到：${installerDir}`);
for (const name of installers) console.log(`  ${name}`);
