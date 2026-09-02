import { access, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const packageRoot = path.resolve(process.cwd());
const required = ["dist/main.js", "dist/preload.js", "dist/core-entry.js", "renderer/index.html", "renderer/shell.css"];
await Promise.all(required.map((file) => access(path.join(packageRoot, file))));

const main = await readFile(path.join(packageRoot, "dist/main.js"), "utf8");
const html = await readFile(path.join(packageRoot, "renderer/index.html"), "utf8");

for (const invariant of ["contextIsolation: true", "nodeIntegration: false", "sandbox: true", "requestSingleInstanceLock", "XiLing OS Desktop"]) {
  if (!main.includes(invariant)) throw new Error(`Desktop security invariant missing: ${invariant}`);
}
if (!html.includes("Content-Security-Policy")) throw new Error("Desktop renderer CSP missing");

console.log("Desktop foundation smoke passed");
