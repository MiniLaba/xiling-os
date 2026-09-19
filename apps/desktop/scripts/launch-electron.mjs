import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(root, "..");
const require = createRequire(import.meta.url);
let electron;
try {
  electron = require("electron");
} catch {
  console.error("没有找到 Electron。请先双击「一键启动桌面端.bat」，或在仓库根目录运行 pnpm install。");
  process.exit(1);
}
if (typeof electron !== "string" || !existsSync(electron)) {
  console.error("Electron 安装不完整。请在仓库根目录重新运行 pnpm install。");
  process.exit(1);
}

const child = spawn(electron, ["."], {
  cwd: desktopRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    XILING_NODE_BINARY: process.execPath,
  },
});
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
