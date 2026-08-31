import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function browserCommand(platform, url) {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") return { command: "cmd.exe", args: ["/d", "/s", "/c", "start", "", url] };
  return { command: "xdg-open", args: [url] };
}

export function appUrl(host, port) {
  const browserHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `http://${browserHost}:${port}/`;
}

export function defaultDataRoot(platform, environment = process.env) {
  if (platform === "win32" && environment.LOCALAPPDATA) return win32.resolve(environment.LOCALAPPDATA, "XiLingOS");
  return resolve(root, "data");
}

async function waitUntilHealthy(url, child, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Xi Ling OS exited before becoming healthy (code ${child.exitCode})`);
    try {
      const response = await fetch(new URL("health", url), { signal: AbortSignal.timeout(1_500) });
      if (response.ok && (await response.json()).status === "ok") return;
    } catch { /* startup race */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 350));
  }
  throw new Error(`Xi Ling OS did not become healthy within ${timeoutMs / 1_000} seconds`);
}

async function main() {
  const noBrowser = process.argv.includes("--no-browser") || process.env.XILING_NO_BROWSER === "1" || process.env.CI === "true";
  const host = process.env.XILING_HOST ?? "127.0.0.1";
  const port = Number.parseInt(process.env.XILING_PORT ?? "4317", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("XILING_PORT must be a valid TCP port");
  const url = appUrl(host, port);
  try {
    const existing = await fetch(new URL("health", url), { signal: AbortSignal.timeout(700) });
    if (existing.ok) throw new Error(`Xi Ling OS is already running at ${url}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Xi Ling OS is already running")) throw error;
  }
  const dataRoot = resolve(process.env.XILING_DATA_ROOT ?? defaultDataRoot(process.platform));
  const runtimeRoot = resolve(dataRoot, "runtime");
  const pidPath = resolve(runtimeRoot, "xiling-server.pid");
  await mkdir(runtimeRoot, { recursive: true });

  const child = spawn(process.execPath, [resolve(root, "apps/server/dist/index.js")], {
    cwd: root,
    env: { ...process.env, XILING_DATA_ROOT: dataRoot, XILING_HOST: host, XILING_PORT: String(port) },
    stdio: "inherit",
    windowsHide: true,
  });
  await writeFile(pidPath, `${child.pid}\n`, "utf8");
  const cleanup = () => rm(pidPath, { force: true }).catch(() => undefined);
  child.once("exit", cleanup);

  const stop = async () => {
    try { await fetch(new URL("api/system/stop", url), { method: "POST", signal: AbortSignal.timeout(3_000) }); }
    catch { child.kill(); }
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    await waitUntilHealthy(url, child);
    console.log(`Xi Ling OS is ready at ${url}`);
    if (!noBrowser) {
      const opener = browserCommand(process.platform, url);
      const browser = spawn(opener.command, opener.args, { detached: true, stdio: "ignore", windowsHide: true });
      browser.on("error", (error) => console.warn(`Could not open the browser automatically: ${error.message}`));
      browser.unref();
    }
    const code = child.exitCode ?? await new Promise((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("exit", (exitCode, signal) => resolvePromise(exitCode ?? (signal ? 1 : 0)));
    });
    process.exitCode = code;
  } catch (error) {
    child.kill();
    await cleanup();
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
