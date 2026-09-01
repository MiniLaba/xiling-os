import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { Type } from "typebox";
import type { RuntimeTool, RuntimeToolResult } from "./index.js";

export const XILING_MCP_ADAPTER_VERSION = "2.27.0" as const;

export interface PiMcpServerDefinition {
  name: string;
  description: string;
  keywords: string[];
  definition: {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    url?: string;
    headers?: Record<string, string>;
    auth?: "oauth" | "bearer" | false;
    bearerToken?: string;
    bearerTokenStore?: true;
    lifecycle?: "lazy";
    requestTimeoutMs?: number;
    approveTools?: boolean;
    disabled?: boolean;
  };
}

export interface PiMcpHostConfig { servers: PiMcpServerDefinition[] }

export interface PiMcpStatusSnapshot {
  version: 1;
  servers: Array<{ name: string; status: "connected" | "cached" | "failed" | "needs-auth" | "not-connected" | "disabled"; toolCount: number; resourceCount?: number; failedAgoSeconds?: number; disabled: boolean }>;
  totalTools: number;
  totalResources: number;
  connectedCount: number;
  disabledCount: number;
}

const emptySnapshot = (): PiMcpStatusSnapshot => ({ version: 1, servers: [], totalTools: 0, totalResources: 0, connectedCount: 0, disabledCount: 0 });

const gatewayParameters = Type.Object({
  tool: Type.Optional(Type.String({ description: "要调用的 MCP 工具名称" })),
  args: Type.Optional(Type.Union([Type.String({ description: "JSON 字符串形式的工具参数" }), Type.Object({}, { additionalProperties: true, description: "对象形式的工具参数" })])),
  connect: Type.Optional(Type.String({ description: "惰性连接并刷新元数据的服务器名称" })),
  describe: Type.Optional(Type.String({ description: "读取单个 MCP 工具的参数说明" })),
  instructions: Type.Optional(Type.String({ description: "读取服务器使用说明" })),
  search: Type.Optional(Type.String({ description: "按名称或描述搜索 MCP 工具" })),
  regex: Type.Optional(Type.Boolean()),
  includeSchemas: Type.Optional(Type.Boolean()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 24 })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  server: Type.Optional(Type.String({ description: "限定服务器名称" })),
  action: Type.Optional(Type.Union([Type.Literal("auth-start"), Type.Literal("auth-complete")])),
}, { additionalProperties: false });

type GatewayParameters = {
  tool?: string;
  args?: string | Record<string, unknown>;
  connect?: string;
  describe?: string;
  instructions?: string;
  search?: string;
  regex?: boolean;
  includeSchemas?: boolean;
  limit?: number;
  offset?: number;
  server?: string;
  action?: "auth-start" | "auth-complete";
};

type WorkerResponse = { id?: string; ok?: boolean; result?: RuntimeToolResult; error?: string; event?: "status" | "fatal"; snapshot?: PiMcpStatusSnapshot };

class McpHostWorker {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, { resolve: (value: RuntimeToolResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; signal?: AbortSignal; onAbort?: () => void }>();
  private counter = 0;
  private closing = false;
  private exited = false;
  private fatalError: string | undefined;
  snapshot: PiMcpStatusSnapshot = emptySnapshot();

  private constructor(root: string, config: PiMcpHostConfig) {
    const workerPath = fileURLToPath(new URL("../mcp-host-worker.mjs", import.meta.url));
    const tsxLoader = import.meta.resolve("tsx");
    this.process = spawn(process.execPath, ["--import", tsxLoader, workerPath], {
      cwd: resolve(root),
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, XILING_MCP_HOST: "1", PI_CODING_AGENT_DIR: resolve(root, "agent") },
      shell: false,
    });
    const lines = createInterface({ input: this.process.stdout });
    lines.on("line", (line) => this.receive(line));
    let stderr = "";
    this.process.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8_000); });
    this.process.once("exit", (code, signal) => {
      this.exited = true;
      const message = this.closing ? "MCP host closed" : `MCP host exited (${code ?? signal ?? "unknown"})${stderr ? `: ${stderr.slice(-600)}` : ""}`;
      for (const request of this.pending.values()) { clearTimeout(request.timer); if (request.signal && request.onAbort) request.signal.removeEventListener("abort", request.onAbort); request.reject(new Error(this.fatalError ?? message)); }
      this.pending.clear();
    });
    this.send({ op: "init", root, config });
  }

  static async create(root: string, config: PiMcpHostConfig): Promise<McpHostWorker> {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const worker = new McpHostWorker(root, config);
    try { await worker.request("ready", {}, 20_000); }
    catch (error) { await worker.close().catch(() => undefined); throw error; }
    return worker;
  }

  private send(value: unknown): void {
    if (this.exited) return;
    try { this.process.stdin.write(`${JSON.stringify(value)}\n`); } catch { /* worker pipe is already gone */ }
  }

  private receive(line: string): void {
    let message: WorkerResponse;
    try { message = JSON.parse(line) as WorkerResponse; }
    catch { return; }
    if (message.event === "status" && message.snapshot) { this.snapshot = message.snapshot; return; }
    if (message.event === "fatal") {
      // Init failures arrive without a request id; surface them to every pending
      // caller (notably "ready") instead of answering success and failing later
      // with a misleading "gateway tool not registered" error.
      this.fatalError = `MCP host init failed: ${message.error ?? "unknown error"}`;
      const pending = [...this.pending.values()];
      this.pending.clear();
      for (const request of pending) { clearTimeout(request.timer); if (request.signal && request.onAbort) request.signal.removeEventListener("abort", request.onAbort); request.reject(new Error(this.fatalError)); }
      return;
    }
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
    if (message.ok && message.result) pending.resolve(message.result);
    else pending.reject(new Error(message.error ?? "MCP host request failed"));
  }

  request(op: string, payload: Record<string, unknown>, timeoutMs = 35_000, signal?: AbortSignal): Promise<RuntimeToolResult> {
    if (this.closing) return Promise.reject(new Error("MCP host is closing"));
    if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("MCP request cancelled"));
    const id = `mcp-${++this.counter}`;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
        this.send({ op: "cancel", requestId: id });
        reject(new Error(`MCP host ${op} timed out`));
      }, timeoutMs);
      timer.unref?.();
      const onAbort = signal ? () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id); clearTimeout(timer);
        if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
        this.send({ op: "cancel", requestId: id });
        reject(signal.reason instanceof Error ? signal.reason : new Error("MCP request cancelled"));
      } : undefined;
      if (signal && onAbort) signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, { resolve: resolvePromise, reject, timer, ...(signal ? { signal } : {}), ...(onAbort ? { onAbort } : {}) });
      this.send({ id, op, ...payload });
    });
  }

  async close(): Promise<void> {
    if (this.closing || this.exited) { this.closing = true; return; }
    this.closing = true;
    const exited = new Promise<void>((resolvePromise) => this.process.once("exit", () => resolvePromise()));
    this.send({ op: "close" });
    const timer = setTimeout(() => { try { this.process.kill(); } catch { /* already gone */ } }, 5_000);
    timer.unref?.();
    await exited;
    clearTimeout(timer);
  }
}

/**
 * Stable anti-corruption boundary around the TypeScript-source Pi plugin. The
 * plugin and every stdio MCP server run in a dedicated host process; the main
 * server sees only a versioned JSON-line protocol and one proxy tool schema.
 */
export class PiMcpGatewayManager {
  private current: McpHostWorker | undefined;
  private config: PiMcpHostConfig = { servers: [] };
  private generation = 0;

  constructor(private readonly root: string) {}

  async configure(config: PiMcpHostConfig): Promise<void> {
    const generation = ++this.generation;
    const nextConfig = structuredClone(config);
    if (nextConfig.servers.length === 0) {
      const previous = this.current;
      this.current = undefined;
      this.config = nextConfig;
      if (previous) await previous.close();
      return;
    }
    const next = await McpHostWorker.create(resolve(this.root, `runtime-${generation}`), nextConfig);
    if (generation !== this.generation) { await next.close(); return; }
    const previous = this.current;
    this.current = next;
    this.config = nextConfig;
    if (previous) await previous.close();
  }

  matches(query: string): boolean {
    const normalized = query.toLocaleLowerCase();
    if (/\bmcp\b/iu.test(normalized) || normalized.includes("模型上下文协议")) return this.config.servers.some((server) => server.definition.disabled !== true);
    return this.config.servers.some((server) => server.definition.disabled !== true && [server.name, server.description, ...server.keywords].some((value) => normalized.includes(value.toLocaleLowerCase())));
  }

  status(): PiMcpStatusSnapshot { return this.current?.snapshot ?? emptySnapshot(); }

  tool(): RuntimeTool<GatewayParameters> {
    return {
      name: "mcp",
      label: "MCP 按需能力网关",
      description: "仅在当前任务命中已配置 MCP 时使用。先 search/describe，再调用单个工具；不得猜测参数。服务器和完整工具 schema 不常驻上下文。",
      parameters: gatewayParameters,
      execute: async (callId, parameters, signal) => {
        if (signal?.aborted) throw signal.reason;
        if (!this.current) throw new Error("MCP host is not initialized");
        return this.current.request("call", { callId, parameters }, 60_000, signal);
      },
    };
  }

  async close(): Promise<void> {
    this.generation += 1;
    const current = this.current;
    this.current = undefined;
    if (current) await current.close();
  }
}
