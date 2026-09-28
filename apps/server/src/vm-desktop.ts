import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";

const executeFile = promisify(execFile);

export const BOT_DESKTOP_NAME = "xiling-bot-desktop";
/** Full XFCE desktop with Firefox, Chromium, a panel, and noVNC. Not a browser-only sandbox. */
const DEFAULT_IMAGE = "consol/debian-xfce-vnc:latest";
const DESKTOP_MARKER = "XILING_DESKTOP=xfce";
const DESKTOP_RESOLUTION = "1280x800";
const DOCKER_DESKTOP_EXE = "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe";

export type VmDesktopPhase = "stopped" | "starting" | "ready" | "unavailable";

export interface VmDesktopSnapshot {
  status: VmDesktopPhase;
  message: string;
  embedUrl?: string;
}

export type CommandRunner = (file: string, args: string[], timeoutMs: number) => Promise<{ stdout: string; stderr: string }>;

async function docker(file: string, args: string[], timeoutMs: number) {
  const result = await executeFile(file, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 });
  return { stdout: result.stdout, stderr: result.stderr };
}

async function probeDesktop(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return response.status < 500;
  } catch {
    return false;
  }
}

export function botDesktopImage(): string {
  const image = process.env.XILING_VM_IMAGE?.trim() || DEFAULT_IMAGE;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,200}$/.test(image)) throw new Error("虚拟机镜像名称无效");
  return image;
}

export function botDesktopContainerPort(): number {
  const port = Number(process.env.XILING_VM_PORT ?? 6901);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("虚拟机端口无效");
  return port;
}

/** Accepts only a loopback publish line from `docker port`. The page is the desktop's noVNC client. */
export function loopbackEmbedUrl(portListing: string, password = ""): string {
  const match = portListing.split(/\r?\n/).map((line) => line.trim()).map((line) => /^(?:127\.0\.0\.1|\[::1\]|localhost):(\d+)$/.exec(line)).find((found) => found);
  const hostPort = Number(match?.[1]);
  if (!match || hostPort < 1 || hostPort > 65535) throw new Error("虚拟机端口没有绑定到本机回环地址");
  const query = new URLSearchParams({ autoconnect: "1", resize: "scale" });
  if (password) query.set("password", password);
  return `http://127.0.0.1:${hostPort}/vnc.html?${query.toString()}`;
}

export function explainVmDesktopFailure(error: unknown): string {
  const stderr = error && typeof error === "object" && "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "") : "";
  const message = error instanceof Error ? error.message : "";
  const detail = `${stderr}\n${message}`;
  const missingEngine = (/ENOENT/i.test(detail) && /docker/i.test(detail)) || /docker.*(not recognized|不是内部或外部命令|command not found)/i.test(detail) || /(not recognized|不是内部或外部命令|command not found).*docker/i.test(detail);
  if (missingEngine) return "本机没有可用的 Docker，虚拟机无法打开。";
  if (/failed to connect to the docker API|Cannot connect to the Docker daemon|dockerDesktopLinuxEngine|error during connect/i.test(detail)) return "Docker 没有在运行，虚拟机无法打开。请先启动 Docker。";
  if (/registry-1\.docker\.io|no HTTPS proxy/i.test(detail)) return "下载虚拟机镜像失败。Docker 没有走本机代理，连不上镜像仓库。请在 Docker Desktop 的 Proxies 中填写代理后重新打开。";
  if (/Unable to find image|pull access denied|manifest unknown|no matching manifest/i.test(detail)) return "虚拟机镜像还没有准备好。请确认 Docker 可以拉取镜像，然后重新打开。";
  if (/ETIMEDOUT|timed out|timeout/i.test(detail)) return "打开虚拟机超时。";
  const line = (stderr.trim() || message).split(/\r?\n/).find((item) => item.trim()) ?? "虚拟机无法打开";
  return line.trim().slice(0, 180);
}

/** Starts Docker Desktop, installing it first when the program is not on this machine. */
export async function bootDockerDesktop(): Promise<void> {
  if (process.platform !== "win32") throw new Error("请先启动 Docker。");
  if (!existsSync(DOCKER_DESKTOP_EXE)) {
    await executeFile("winget", ["install", "--id", "Docker.DockerDesktop", "-e", "--disable-interactivity", "--accept-package-agreements", "--accept-source-agreements"], { timeout: 20 * 60_000, maxBuffer: 1024 * 1024 });
  }
  if (!existsSync(DOCKER_DESKTOP_EXE)) throw new Error("Docker 安装没有完成，虚拟机无法打开。");
  const child = spawn(DOCKER_DESKTOP_EXE, [], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

function missingContainer(error: unknown): boolean {
  const stderr = error && typeof error === "object" && "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "") : "";
  const message = error instanceof Error ? error.message : "";
  return /No such object|No such container|No such container:/i.test(`${stderr}\n${message}`);
}

export class VmDesktopSession {
  private phase: VmDesktopPhase = "stopped";
  private message = "虚拟机尚未打开";
  private embedUrl: string | undefined;
  private inflight: Promise<void> | undefined;
  private ticket = 0;
  private launched = false;
  private readonly run: CommandRunner;
  private readonly probe: (url: string) => Promise<boolean>;
  private readonly probeAttempts: number;
  private readonly probeIntervalMs: number;
  private readonly engineRetryMs: number;
  private readonly bootEngine: () => Promise<void>;
  private readonly vncPassword: string;

  constructor(options: { run?: CommandRunner; probe?: (url: string) => Promise<boolean>; probeAttempts?: number; probeIntervalMs?: number; engineRetryMs?: number; bootEngine?: () => Promise<void>; vncPassword?: string } = {}) {
    this.run = options.run ?? docker;
    this.probe = options.probe ?? probeDesktop;
    this.probeAttempts = options.probeAttempts ?? 90;
    this.probeIntervalMs = options.probeIntervalMs ?? 1_000;
    this.engineRetryMs = options.engineRetryMs ?? 3_000;
    this.bootEngine = options.bootEngine ?? bootDockerDesktop;
    this.vncPassword = options.vncPassword ?? randomBytes(4).toString("hex");
  }

  snapshot(): VmDesktopSnapshot {
    return { status: this.phase, message: this.message, ...(this.embedUrl ? { embedUrl: this.embedUrl } : {}) };
  }

  /** Returns immediately. The desktop publish happens in the background. */
  start(): VmDesktopSnapshot {
    if (this.inflight) return this.snapshot();
    if (this.phase === "ready" && this.embedUrl) return this.snapshot();
    this.phase = "starting";
    this.message = "正在打开虚拟机";
    this.embedUrl = undefined;
    this.inflight = this.open().finally(() => { this.inflight = undefined; });
    return this.snapshot();
  }

  settled(): Promise<void> {
    return this.inflight ?? Promise.resolve();
  }

  async stop(): Promise<VmDesktopSnapshot> {
    this.ticket += 1;
    await this.inflight?.catch(() => undefined);
    if (this.launched) await this.run("docker", ["rm", "--force", BOT_DESKTOP_NAME], 20_000).catch(() => undefined);
    this.launched = false;
    this.phase = "stopped";
    this.embedUrl = undefined;
    this.message = "虚拟机已关闭";
    return this.snapshot();
  }

  private async open(): Promise<void> {
    const ticket = ++this.ticket;
    try {
      const url = await this.launch();
      if (ticket !== this.ticket) return;
      let reachable = false;
      for (let attempt = 0; attempt < this.probeAttempts; attempt += 1) {
        if (ticket !== this.ticket) return;
        if (await this.probe(url)) { reachable = true; break; }
        if (this.probeIntervalMs > 0) await new Promise((resolve) => setTimeout(resolve, this.probeIntervalMs));
      }
      if (ticket !== this.ticket) return;
      if (!reachable) throw new Error("虚拟机已启动，但页面尚未响应");
      this.phase = "ready";
      this.embedUrl = url;
      this.message = "虚拟机已嵌入，里面有任务栏、文件、终端和浏览器。";
    } catch (error) {
      if (ticket !== this.ticket) return;
      this.phase = "unavailable";
      this.embedUrl = undefined;
      this.message = explainVmDesktopFailure(error);
    }
  }

  private async ensureEngine(): Promise<void> {
    const probe = () => this.run("docker", ["info", "--format", "{{.ServerVersion}}"], 20_000);
    try {
      await probe();
      return;
    } catch (error) {
      const explained = explainVmDesktopFailure(error);
      if (!explained.includes("没有可用的 Docker") && !explained.includes("请先启动 Docker")) throw error;
      this.message = explained.includes("没有可用的 Docker") ? "正在安装 Docker，请允许系统安装提示" : "正在启动 Docker";
      await this.bootEngine();
      const deadline = Date.now() + 180_000;
      let last: unknown = error;
      while (Date.now() < deadline) {
        try {
          await probe();
          return;
        } catch (again) {
          last = again;
          if (this.engineRetryMs > 0) await new Promise((resolve) => setTimeout(resolve, this.engineRetryMs));
        }
      }
      throw last;
    }
  }

  private async launch(): Promise<string> {
    await this.ensureEngine();
    const image = botDesktopImage();
    const containerPort = botDesktopContainerPort();
    let running = false;
    try {
      const inspected = await this.run("docker", ["inspect", "--format", "{{.State.Running}}", BOT_DESKTOP_NAME], 15_000);
      running = inspected.stdout.trim() === "true";
    } catch (error) {
      if (!missingContainer(error)) throw error;
    }
    if (running) {
      const env = await this.run("docker", ["inspect", "--format", "{{range .Config.Env}}{{println .}}{{end}}", BOT_DESKTOP_NAME], 15_000);
      if (!env.stdout.includes(DESKTOP_MARKER)) running = false;
    }
    if (!running) {
      await this.run("docker", ["rm", "--force", BOT_DESKTOP_NAME], 20_000).catch((error: unknown) => { if (!missingContainer(error)) throw error; });
      try {
        await this.run("docker", ["image", "inspect", "--format", "{{.Id}}", image], 20_000);
      } catch (error) {
        const stderr = error && typeof error === "object" && "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "") : "";
        const message = error instanceof Error ? error.message : "";
        if (!/No such image/i.test(`${stderr}\n${message}`)) throw error;
        this.message = "正在准备虚拟机镜像，第一次打开需要下载";
        await this.run("docker", ["pull", image], 45 * 60_000);
      }
      const args = ["run", "-d", "--name", BOT_DESKTOP_NAME, "--label", "org.xiling.sandbox=true", "--label", "org.xiling.role=bot-desktop", "-p", `127.0.0.1::${containerPort}`, "--shm-size", "1g", "--memory", String(4 * 1024 ** 3), "--cpus", "2", "--pids-limit", "1024", "-e", DESKTOP_MARKER, "-e", `VNC_PW=${this.vncPassword}`, "-e", `VNC_RESOLUTION=${DESKTOP_RESOLUTION}`, "-e", "VNC_COL_DEPTH=24", image];
      await this.run("docker", args, 45 * 60_000);
    }
    this.launched = true;
    this.message = "正在打开虚拟机";
    await this.run("docker", ["exec", "-u", "0", BOT_DESKTOP_NAME, "bash", "-lc", "mkdir -p /workspace && chown 1000:1000 /workspace"], 20_000).catch(() => undefined);
    const published = await this.run("docker", ["port", BOT_DESKTOP_NAME, `${containerPort}/tcp`], 15_000);
    try {
      return loopbackEmbedUrl(published.stdout, this.vncPassword);
    } catch (error) {
      await this.run("docker", ["rm", "--force", BOT_DESKTOP_NAME], 20_000).catch(() => undefined);
      this.launched = false;
      throw error;
    }
  }
}

export function registerVmDesktopRoutes(app: FastifyInstance, session: VmDesktopSession, executionTarget: () => string): void {
  app.get("/api/v1/bot/desktop", async () => session.snapshot());
  app.post("/api/v1/bot/desktop", async (_request, reply) => {
    if (executionTarget() !== "vm") return reply.code(409).send({ error: "当前执行目标不是虚拟机" });
    return reply.code(202).send(session.start());
  });
  app.delete("/api/v1/bot/desktop", async () => session.stop());
}
