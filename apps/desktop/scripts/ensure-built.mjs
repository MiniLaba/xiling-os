import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const server = resolve(repoRoot, "apps/server/dist/index.js");
const web = resolve(repoRoot, "apps/web/dist/index.html");
const harness = resolve(repoRoot, "packages/agent-harness/dist/index.js");
const rootRequire = createRequire(resolve(repoRoot, "package.json"));
const webRequire = createRequire(resolve(repoRoot, "apps/web/package.json"));

function bin(req, pkg, file) {
  return resolve(dirname(req.resolve(`${pkg}/package.json`)), file);
}

function newestMtime(dir) {
  if (!existsSync(dir)) return 0;
  let latest = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== "dist") stack.push(path);
      } else if (entry.isFile()) {
        latest = Math.max(latest, statSync(path).mtimeMs);
      }
    }
  }
  return latest;
}

function fileTime(path) {
  return existsSync(path) ? statSync(path).mtimeMs : 0;
}

function runNode(args, cwd) {
  const result = spawnSync(process.execPath, args, { cwd, stdio: "inherit", env: process.env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function runPnpm(args) {
  const env = { ...process.env, CI: "true", NODE_ENV: "development" };
  const pnpm = process.env.npm_execpath;
  const result = pnpm && existsSync(pnpm) && /\.(exe|cjs|mjs|js|cmd)$/i.test(pnpm)
    ? spawnSync(/\.(c?js|mjs)$/i.test(pnpm) ? process.execPath : pnpm, /\.(c?js|mjs)$/i.test(pnpm) ? [pnpm, ...args] : args, {
      cwd: repoRoot,
      stdio: "inherit",
      shell: /\.cmd$/i.test(pnpm),
      env,
    })
    : spawnSync("pnpm", args, { cwd: repoRoot, stdio: "inherit", shell: true, env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function hasTypescript() {
  return existsSync(resolve(repoRoot, "node_modules/typescript/package.json"));
}

function restoreInstall() {
  console.log("开发依赖缺失，正在重新安装...");
  runPnpm(["install"]);
  if (!hasTypescript()) {
    console.error("重新安装后仍然没有 typescript。请在仓库根目录运行 pnpm install 后再试。");
    process.exit(1);
  }
}

if (!hasTypescript()) restoreInstall();

function buildTs(packageDir) {
  runNode([bin(rootRequire, "typescript", "bin/tsc"), "-p", "tsconfig.json"], packageDir);
}

const missingDist = !existsSync(server) || !existsSync(web);
const backendStale =
  newestMtime(resolve(repoRoot, "apps/server/src")) > fileTime(server)
  || newestMtime(resolve(repoRoot, "packages/agent-harness/src")) > fileTime(harness);
const webStale = newestMtime(resolve(repoRoot, "apps/web/src")) > fileTime(web);

if (!missingDist && !backendStale && !webStale) process.exit(0);

if (missingDist) {
  console.log("还没有构建过，先完整编译，请等几分钟...");
  runPnpm(["build"]);
} else {
  if (backendStale) {
    console.log("检测到后端代码有更新，正在编译 Server...");
    buildTs(resolve(repoRoot, "packages/agent-harness"));
    buildTs(resolve(repoRoot, "apps/server"));
  }
  if (webStale) {
    console.log("检测到界面代码有更新，正在编译 Web...");
    runNode([bin(rootRequire, "typescript", "bin/tsc"), "-b"], resolve(repoRoot, "apps/web"));
    runNode([bin(webRequire, "vite", "bin/vite.js"), "build"], resolve(repoRoot, "apps/web"));
  }
}

if (!existsSync(server) || !existsSync(web)) {
  console.error("构建后仍然缺少 apps/server/dist 或 apps/web/dist");
  process.exit(1);
}
