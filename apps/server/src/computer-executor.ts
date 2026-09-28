import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { BOT_DESKTOP_NAME } from "./vm-desktop.js";
import { assertOpenManusStep, type OpenManusExecutionTarget } from "./openmanus-boundary.js";

const executeFile = promisify(execFile);

export interface ComputerTarget {
  target: OpenManusExecutionTarget;
  sshHost?: string;
}

export interface ComputerRunResult {
  stdout: string;
  stderr: string;
}

export type ComputerRunner = (file: string, args: string[], timeoutMs: number) => Promise<ComputerRunResult>;

const OUTPUT_LIMIT = 8_000;
const MAX_DESKTOP_FILE_BYTES = 40 * 1024 * 1024;

export function reviewComputerRequest(input: { target: OpenManusExecutionTarget; command?: string; path?: string }): void {
  const text = `${input.command ?? ""}\n${input.path ?? ""}`;
  assertOpenManusStep({
    target: input.target,
    approved: true,
    changesFormalConclusion: /research-graph\.lbdb|knowledge\.sqlite|agent-center\.sqlite/i.test(text),
    largeDataDownload: /\b(wget|aria2c|yt-dlp|aws\s+s3\s+sync)\b/i.test(text) || (/\bcurl\b/i.test(text) && /(?:\s-[^\s]*O|\s--output\b)/.test(text)),
  });
}

export function publicHttpUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("只能打开 http 或 https 网址");
  if (url.username || url.password) throw new Error("网址里不能带账号密码");
  return url.toString();
}

function clip(text: string): string {
  const trimmed = text.replace(/\u0000/g, "").trim();
  return trimmed.length > OUTPUT_LIMIT ? `${trimmed.slice(0, OUTPUT_LIMIT)}\n…输出已截断` : trimmed;
}

function safeWorkspacePath(root: string, requested: string): string {
  const relative = requested.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!relative || relative.split("/").some((part) => part === ".." || part === "")) throw new Error("文件路径必须留在这台电脑的工作目录里");
  const full = resolve(root, relative);
  if (full !== root && !full.startsWith(`${root}${sep}`)) throw new Error("文件路径必须留在这台电脑的工作目录里");
  return full;
}

function vmPath(requested: string): string {
  const normalized = requested.replace(/\\/g, "/");
  const full = normalized.startsWith("/workspace") ? normalized : `/workspace/${normalized.replace(/^\/+/, "")}`;
  if (full.split("/").includes("..")) throw new Error("文件路径必须留在虚拟机的 /workspace");
  if (full !== "/workspace" && !full.startsWith("/workspace/")) throw new Error("文件路径必须留在虚拟机的 /workspace");
  return full;
}

async function defaultRunner(file: string, args: string[], timeoutMs: number): Promise<ComputerRunResult> {
  try {
    const result = await executeFile(file, args, { timeout: timeoutMs, maxBuffer: 12 * 1024 * 1024, windowsHide: true });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const stdout = error && typeof error === "object" && "stdout" in error ? String((error as { stdout?: unknown }).stdout ?? "") : "";
    const stderr = error && typeof error === "object" && "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "") : "";
    const message = error instanceof Error ? error.message : String(error);
    return { stdout, stderr: stderr || message };
  }
}

const TITLE_SCRIPT = `import os, re, urllib.request
url = os.environ.get("XILING_URL", "")
title = ""
try:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=12) as resp:
        raw = resp.read(400000)
        head = raw[:2500].decode("ascii", "ignore")
        match = re.search(r"""charset=["']?([A-Za-z0-9._-]+)""", head, re.I)
        text = raw.decode(match.group(1) if match else "utf-8", "replace")
        found = re.search(r"<title[^>]*>(.*?)</title>", text, re.I | re.S)
        if found:
            title = re.sub(r"\\s+", " ", found.group(1)).strip()[:180]
except Exception:
    title = ""
print("title:" + title)
`;

export function desktopFileName(preferred: string, url: string): string {
  const slug = preferred.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/giu, "_").replace(/^_+|_+$/gu, "").slice(0, 60);
  const id = url.match(/(\d{4}\.\d{4,5})/u)?.[1];
  const stem = slug && slug !== "paper" ? slug : (id || slug || "paper");
  return `${stem}.pdf`;
}

const DOWNLOAD_SCRIPT = `import os, urllib.request
url = os.environ["XILING_URL"]
target = os.environ["XILING_TARGET"]
limit = int(os.environ.get("XILING_MAX_BYTES", "40000000"))
os.makedirs(os.path.dirname(target), exist_ok=True)
req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
with urllib.request.urlopen(req, timeout=90) as resp:
    data = resp.read(limit + 1)
if len(data) > limit:
    raise SystemExit("文件超过单文件上限")
if not data.startswith(b"%PDF"):
    raise SystemExit("下载到的不是 PDF")
with open(target, "wb") as handle:
    handle.write(data)
print("saved:" + target)
`;

function desktopDownloadCommand(url: string, filename: string): string {
  const quotedUrl = shellQuote(url);
  const quotedName = shellQuote(filename);
  const encoded = Buffer.from(DOWNLOAD_SCRIPT, "utf8").toString("base64");
  return [
    `home=$(getent passwd "$(id -u)" | cut -d: -f6)`,
    `if [ -z "$home" ] || [ ! -d "$home" ]; then home=/headless; fi`,
    `desktop="$home/Desktop"`,
    `mkdir -p "$desktop"`,
    `export XILING_URL=${quotedUrl}`,
    `export XILING_TARGET="$desktop"/${quotedName}`,
    `export XILING_MAX_BYTES=${MAX_DESKTOP_FILE_BYTES}`,
    `if ! command -v python3 >/dev/null; then echo '虚拟机里没有 python3'; exit 1; fi`,
    `printf %s ${shellQuote(encoded)} | base64 -d | python3`,
  ].join("; ");
}

function desktopBrowseCommand(url: string): string {
  const quoted = shellQuote(url);
  const encoded = Buffer.from(TITLE_SCRIPT, "utf8").toString("base64");
  return [
    `home=$(getent passwd "$(id -u)" | cut -d: -f6)`,
    `if [ -z "$home" ] || [ ! -d "$home" ]; then home=/headless; fi`,
    `export HOME="$home"`,
    `export DISPLAY=:1`,
    `export XAUTHORITY="$HOME/.Xauthority"`,
    `if command -v firefox >/dev/null; then browser=firefox; elif command -v firefox-esr >/dev/null; then browser=firefox-esr; elif command -v chromium >/dev/null; then browser=chromium; else echo '桌面里没有浏览器'; exit 1; fi`,
    `"$browser" --new-window ${quoted} >"$HOME/xiling-browser.log" 2>&1 & echo opened`,
    `export XILING_URL=${quoted}`,
    `if command -v python3 >/dev/null; then printf %s ${shellQuote(encoded)} | base64 -d | python3; else printf 'title:\\n'; fi`,
  ].join("; ");
}

function pageTitle(stdout: string): string {
  const line = stdout.split(/\r?\n/u).find((item) => item.startsWith("title:"));
  const raw = line?.slice("title:".length).trim() ?? "";
  return raw
    .replace(/&#(\d+);/gu, (_, value: string) => String.fromCodePoint(Number(value)))
    .replace(/&#x([0-9a-f]+);/giu, (_, value: string) => String.fromCodePoint(Number.parseInt(value, 16)))
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, "\"")
    .replace(/&nbsp;/gu, " ")
    .trim();
}

export class ComputerExecutor {
  private readonly run: ComputerRunner;
  private readonly ensureVm: () => Promise<void>;
  private readonly target: () => ComputerTarget;
  readonly localRoot: string;

  constructor(options: { localRoot: string; target: () => ComputerTarget; ensureVm?: () => Promise<void>; run?: ComputerRunner }) {
    this.localRoot = options.localRoot;
    this.target = options.target;
    this.ensureVm = options.ensureVm ?? (async () => undefined);
    this.run = options.run ?? defaultRunner;
    mkdirSync(this.localRoot, { recursive: true });
  }

  private current(): ComputerTarget {
    const current = this.target();
    if (current.target === "ssh" && !current.sshHost?.trim()) throw new Error("远程 SSH 还没有填写主机");
    return current;
  }

  async browse(rawUrl: string): Promise<string> {
    const url = publicHttpUrl(rawUrl);
    const current = this.current();
    reviewComputerRequest({ target: current.target, command: url });
    if (current.target === "vm") {
      await this.ensureVm();
      const result = await this.run("docker", ["exec", "-u", "1000", BOT_DESKTOP_NAME, "bash", "-lc", desktopBrowseCommand(url)], 30_000);
      const opened = result.stdout.includes("opened");
      const title = pageTitle(result.stdout);
      return JSON.stringify({ success: opened, url, surface: "vm", ...(title ? { title } : {}), message: clip(opened ? "已在桌面的浏览器窗口中打开" : (result.stderr || result.stdout || "没能在桌面打开浏览器")) });
    }
    if (current.target === "local") {
      const file = process.platform === "win32" ? "powershell.exe" : "xdg-open";
      const args = process.platform === "win32" ? ["-NoProfile", "-NonInteractive", "-Command", `Start-Process '${url.replaceAll("'", "''")}'`] : [url];
      const result = await this.run(file, args, 20_000);
      return JSON.stringify({ success: !result.stderr.trim(), url, surface: "local", message: clip(result.stderr || "已在本机打开") });
    }
    const host = current.sshHost!;
    const result = await this.run("ssh", ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=12", host, `curl -fsSL --max-time 20 --max-filesize 200000 ${shellQuote(url)}`], 30_000);
    return JSON.stringify({ success: Boolean(result.stdout.trim()) && !result.stderr.includes("curl:"), url, surface: "ssh", message: clip(result.stdout || result.stderr) });
  }

  async downloadToDesktop(rawUrl: string, filename: string): Promise<string> {
    const url = publicHttpUrl(rawUrl);
    const safeName = desktopFileName(filename.replace(/\.pdf$/iu, ""), url);
    const current = this.current();
    assertOpenManusStep({ target: current.target, approved: true, changesFormalConclusion: false, largeDataDownload: false });
    if (current.target === "vm") {
      await this.ensureVm();
      const result = await this.run("docker", ["exec", "-u", "1000", BOT_DESKTOP_NAME, "bash", "-lc", desktopDownloadCommand(url, safeName)], 100_000);
      const saved = result.stdout.split(/\r?\n/u).find((line) => line.startsWith("saved:"))?.slice("saved:".length).trim();
      return JSON.stringify({ success: Boolean(saved), url, ...(saved ? { path: saved } : {}), message: clip(saved ? "已下载到桌面" : (result.stderr || result.stdout || "没能下载到桌面")) });
    }
    if (current.target === "local") {
      const desktop = resolve(process.env[process.platform === "win32" ? "USERPROFILE" : "HOME"] ?? this.localRoot, "Desktop");
      mkdirSync(desktop, { recursive: true });
      const target = resolve(desktop, safeName);
      const curl = process.platform === "win32" ? "curl.exe" : "curl";
      const result = await this.run(curl, ["-fsSL", "-L", "--max-time", "90", "--max-filesize", String(MAX_DESKTOP_FILE_BYTES), "-o", target, url], 100_000);
      const saved = !result.stderr.trim();
      return JSON.stringify({ success: saved, url, ...(saved ? { path: target } : {}), message: clip(saved ? "已下载到本机桌面" : (result.stderr || result.stdout || "没能下载到桌面")) });
    }
    const remote = `$HOME/Desktop/${safeName}`;
    const result = await this.run("ssh", ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=12", current.sshHost!, `mkdir -p "$HOME/Desktop" && curl -fsSL -L --max-time 90 --max-filesize ${MAX_DESKTOP_FILE_BYTES} -o "${remote}" ${shellQuote(url)} && echo saved:${remote}`], 100_000);
    const saved = result.stdout.includes("saved:");
    return JSON.stringify({ success: saved, url, ...(saved ? { path: remote } : {}), message: clip(saved ? "已下载到远程桌面" : (result.stderr || result.stdout || "没能下载到桌面")) });
  }

  async shell(command: string): Promise<string> {
    const text = command.trim();
    if (!text || text.length > 4_000) throw new Error("命令为空或过长");
    const current = this.current();
    reviewComputerRequest({ target: current.target, command: text });
    if (current.target === "vm") {
      await this.ensureVm();
      const result = await this.run("docker", ["exec", "-u", "1000", "-w", "/workspace", BOT_DESKTOP_NAME, "bash", "-lc", text], 50_000);
      return JSON.stringify({ stdout: clip(result.stdout), stderr: clip(result.stderr) });
    }
    if (current.target === "local") {
      const file = process.platform === "win32" ? "powershell.exe" : "bash";
      const args = process.platform === "win32" ? ["-NoProfile", "-NonInteractive", "-Command", text] : ["-lc", text];
      const result = await this.run(file, args, 50_000);
      return JSON.stringify({ cwd: this.localRoot, stdout: clip(result.stdout), stderr: clip(result.stderr) });
    }
    const result = await this.run("ssh", ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=12", current.sshHost!, text], 50_000);
    return JSON.stringify({ stdout: clip(result.stdout), stderr: clip(result.stderr) });
  }

  async readFile(requested: string): Promise<string> {
    const current = this.current();
    reviewComputerRequest({ target: current.target, path: requested });
    if (current.target === "vm") {
      await this.ensureVm();
      const result = await this.run("docker", ["exec", "-u", "1000", BOT_DESKTOP_NAME, "bash", "-lc", `cat ${shellQuote(vmPath(requested))}`], 20_000);
      return JSON.stringify({ path: vmPath(requested), text: clip(result.stdout), stderr: clip(result.stderr) });
    }
    if (current.target === "ssh") throw new Error("远程文件请用 computer_shell 读取");
    const full = safeWorkspacePath(this.localRoot, requested);
    const result = await this.run(process.platform === "win32" ? "powershell.exe" : "bash", process.platform === "win32" ? ["-NoProfile", "-NonInteractive", "-Command", `Get-Content -Raw -LiteralPath '${full.replaceAll("'", "''")}'`] : ["-lc", `cat ${shellQuote(full)}`], 20_000);
    return JSON.stringify({ path: full, text: clip(result.stdout), stderr: clip(result.stderr) });
  }

  async writeFile(requested: string, content: string): Promise<string> {
    if (content.length > 100_000) throw new Error("文件内容过长");
    const current = this.current();
    reviewComputerRequest({ target: current.target, path: requested });
    if (current.target === "vm") {
      await this.ensureVm();
      const path = vmPath(requested);
      const written = await this.run("docker", ["exec", "-u", "1000", BOT_DESKTOP_NAME, "bash", "-lc", `mkdir -p "$(dirname ${shellQuote(path)})" && cat > ${shellQuote(path)} << 'XILING_EOF'\n${content.replaceAll("XILING_EOF", "XILING_EO F")}\nXILING_EOF`], 20_000);
      return JSON.stringify({ path, bytes: content.length, stderr: clip(written.stderr) });
    }
    if (current.target === "ssh") throw new Error("远程文件请用 computer_shell 写入");
    const full = safeWorkspacePath(this.localRoot, requested);
    mkdirSync(resolve(full, ".."), { recursive: true });
    const encoded = Buffer.from(content, "utf8").toString("base64");
    const command = process.platform === "win32"
      ? `[IO.File]::WriteAllBytes('${full.replaceAll("'", "''")}', [Convert]::FromBase64String('${encoded}'))`
      : `printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(full)}`;
    const file = process.platform === "win32" ? "powershell.exe" : "bash";
    const args = process.platform === "win32" ? ["-NoProfile", "-NonInteractive", "-Command", command] : ["-lc", command];
    const result = await this.run(file, args, 20_000);
    return JSON.stringify({ path: full, bytes: content.length, stderr: clip(result.stderr) });
  }
}

function shellQuote(value: string): string {
  if (isAbsolute(value) || value.startsWith("/")) return `'${value.replaceAll("'", `'\\''`)}'`;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
