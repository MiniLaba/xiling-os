// DeepSeekHarnessSdkRuntimeAdapter（指南 §2.8 的落地）：
// 通过官方 @deepseek-ai/dsh-sdk-client 拉起显式配置的运行时子进程，
// 用 stdio JSON-RPC 驱动真正的 Agent Loop。本文件是全仓库唯一允许 import
// harness 具体实现的地方；对外只暴露 AgentRuntime 结构化接口。
//
// 复用对照（避免重复造轮子）：
// - Agent Loop / 模型调用 / 工具执行      → harness（ctx.agentLoop / ctx.llm / ctx.tools）
// - 会话轨迹持久化 / 重放 / 恢复          → harness（session-persistence-*），OS 只保存
//   确定性 Session/Task 映射，不按 Activation 混用轨迹
// - 审批                                  → harness approval/* 会话事件桥接为 OS RuntimeEvent
// - 沙箱 / 凭据 / jobs / workflow         → harness 执行层；OS 只保留所有权与调度模型

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { startToolBridge } from "./tool-bridge.js";
import type { ActivationId, AgentId, ResolvedModelRoute, RunId } from "@xiling/os-domain";
import type { ActivationSpec, AgentRuntime, RunRequest, RuntimeEvent } from "./port.js";

/** 线上通知的结构化子集（解耦 dsh 具体类型，保持内核零 harness 依赖）。 */
export interface HarnessNotificationLike {
  method: string;
  params: Record<string, unknown>;
}

export interface DshClientLike {
  subscribeSessionTree(sessionId: string): { next(): Promise<HarnessNotificationLike>; close(): void };
  prompt(sessionId: string, contentBlocks: Array<{ type: "text"; text: string }>): Promise<string>;
}

export interface DshHarnessLike {
  redactError?(message: string): string;
  start(): Promise<void>;
  client: DshClientLike;
  close(): Promise<void>;
}

export type DshHarnessFactory = (modelRoute?: ResolvedModelRoute, request?: RunRequest, bridge?: { url: string; token: string }) => DshHarnessLike;

export interface DeepSeekHarnessAdapterOptions {
  supportsHostTools?: boolean;
  ownsSessionHistory?: boolean;
  factory: DshHarnessFactory;
  /** 单轮等待上限（ms）；一轮合法地可以跑很久，默认不限时。 */
  turnTimeoutMs?: number | undefined;
}

export class DeepSeekHarnessSdkRuntimeAdapter implements AgentRuntime {
  get supportsHostTools(): boolean { return this.options.supportsHostTools === true; }
  get ownsSessionHistory(): boolean { return this.options.ownsSessionHistory === true; }
  readonly supportsCancellation = true;
  readonly name = "deepseek-harness-sdk";
  // 当前 SDK prompt 契约仅发送 text block；扩大前必须先实现真实原生附件传输。
  readonly nativeInputModalities = ["text"] as const;
  readonly nativeOutputModalities = ["text"] as const;

  private readonly runs = new Map<RunId, { controller: AbortController; close(): Promise<void> }>();
  private readonly sessions = new Set<string>();
  private readonly suspended = new Set<AgentId>();

  constructor(private readonly options: DeepSeekHarnessAdapterOptions) {}

  async activate(_spec: ActivationSpec): Promise<void> {}

  async *run(request: RunRequest): AsyncIterable<RuntimeEvent> {
    if (request.tools.length > 0 && (!this.supportsHostTools || !request.executeTool)) {
      yield { type: "run.failed", runId: request.runId, reason: "DSH SDK tool registration is not connected; refusing an unexecutable tool contract" };
      return;
    }
    const sessionId = harnessSessionId(request);
    if (this.sessions.has(sessionId) || this.runs.has(request.runId) || this.suspended.has(request.agentId)) {
      yield { type: "run.failed", runId: request.runId, reason: "runtime session busy or agent suspended" };
      return;
    }
    let harness: DshHarnessLike;
    const bridge = request.tools.length ? await startToolBridge(request) : undefined;
    try { harness = this.options.factory(request.modelRoute, request, bridge); }
    catch (error) {
      await bridge?.close();
      yield { type: "run.failed", runId: request.runId, reason: `deepseek harness runtime unavailable: ${describe(error)}` };
      return;
    }
    const controller = new AbortController();
    let closePromise: Promise<void> | undefined;
    const close = () => closePromise ??= (async () => { try { await bridge?.close(); } finally { await harness.close(); } })();
    this.runs.set(request.runId, { controller, close });
    this.sessions.add(sessionId);
    let subscription: ReturnType<DshClientLike["subscribeSessionTree"]> | undefined;
    const deadline = this.options.turnTimeoutMs !== undefined ? Date.now() + this.options.turnTimeoutMs : undefined;
    const wait = <T>(pending: Promise<T>) => beforeDeadline(pending, deadline, controller.signal);
    try {
      await wait(harness.start());
      subscription = harness.client.subscribeSessionTree(sessionId);
      const messageId = await wait(harness.client.prompt(sessionId, [{ type: "text", text: composePrompt(request) }]));
      let received = false;
      let finalText = "";
      while (true) {
        const notification = await wait(subscription.next());
        // Descendant events are not this task's output or completion.
        if (notification.params.sessionId !== sessionId) continue;
        const envelope = notification.params.event as { type?: string; data?: { inserted?: Array<{ id?: string }> } } | undefined;
        if (!received) {
          if (notification.method !== "session.event" || envelope?.type !== "agent/inbox/spliced" ||
              !envelope.data?.inserted?.some((item) => item.id === messageId)) continue;
          received = true;
        }
        const outcome = mapNotification(request.runId, notification, (text) => { finalText = text; });
        if (outcome.events.some((event) => event.type === "approval.requested")) {
          throw new Error("DSH SDK approval continuation is unavailable; runtime stopped without granting approval");
        }
        for (const event of outcome.events) yield event;
        if (outcome.failed !== undefined) throw new Error(outcome.failed);
        if (notification.method === "session.status" && notification.params.status === "idle") break;
      }
      // Reap the owned process before declaring success, including any queued work.
      await close();
      yield { type: "run.completed", runId: request.runId, summary: finalText || undefined };
    } catch (error) {
      let reason = describe(error);
      try { await close(); } catch (cleanupError) { reason += `; runtime cleanup failed: ${describe(cleanupError)}`; }
      yield { type: "run.failed", runId: request.runId, reason: `deepseek harness runtime unavailable or stopped: ${harness.redactError?.(reason) ?? reason}` };
    } finally {
      try {
        try { subscription?.close(); } finally {
          try { await close(); } finally {
            this.runs.delete(request.runId);
            this.sessions.delete(sessionId);
          }
        }
      } catch (error) { throw new Error(harness.redactError?.(describe(error)) ?? describe(error)); }
    }
  }

  /** SDK has no per-prompt cancel. Each run owns a process, so disposal cannot kill another run. */
  async interrupt(runId: RunId): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    run.controller.abort();
    await run.close();
  }

  async suspend(agentId: AgentId): Promise<void> { this.suspended.add(agentId); }
  async resume(agentId: AgentId): Promise<void> { this.suspended.delete(agentId); }

  async close(): Promise<void> {
    await Promise.all([...this.runs.keys()].map((id) => this.interrupt(id)));
  }
}

export function harnessSessionId(request: RunRequest): string {
  return `xiling-${request.agentId}-${request.sessionId === undefined ? `task-${request.taskId}` : `session-${request.sessionId}`}`;
}

/** 限制静默 transport 等待；超时不等于远端执行已取消。 */
async function beforeDeadline<T>(pending: Promise<T>, deadline: number | undefined, signal: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error("runtime interrupted"));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      if (deadline !== undefined) timer = setTimeout(() => reject(new Error("runtime deadline exceeded")), Math.max(0, deadline - Date.now()));
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

/** 从 RunRequest 组装投递给模型的 prompt（目标 + 最小上下文包 + 约束）。 */
export function composePrompt(request: RunRequest): string {
  const sections: string[] = [`目标：${request.goal}`];
  const bundle = request.contextBundle;
  if (bundle?.summary) sections.push(`背景：${bundle.summary}`);
  if (bundle?.facts?.length) {
    sections.push(`已知事实：\n${bundle.facts.map((fact) => `- ${fact.key}: ${String(fact.value)}`).join("\n")}`);
  }
  if (bundle?.constraints?.length) sections.push(`约束：\n${bundle.constraints.map((constraint) => `- ${constraint}`).join("\n")}`);
  if (request.inputArtifacts.length > 0) {
    sections.push(`输入产物：\n${request.inputArtifacts.map((ref) => `- artifact://${ref.artifactId}/version/${ref.version}`).join("\n")}`);
  }
  if (request.tools.length > 0) {
    sections.push(`可用工具：${request.tools.map((tool) => tool.name).join(", ")}`);
  }
  return sections.join("\n\n");
}

interface MapOutcome {
  events: RuntimeEvent[];
  failed?: string | undefined;
}

/**
 * 把一条线上通知映射为 0..n 个 RuntimeEvent。
 * 只挑 OS 关心的领域事实；轨迹细节留在 harness 会话日志里（§7 原则）。
 */
export function mapNotification(runId: RunId, notification: HarnessNotificationLike, onAssistantText: (text: string) => void): MapOutcome {
  if (notification.method !== "session.event") return { events: [] };
  const event = notification.params.event as { type?: string; data?: Record<string, unknown> } | undefined;
  const type = event?.type;
  const data = (event?.data ?? {}) as Record<string, unknown>;
  const stepId = data.step !== undefined ? `${String(data.turn)}/${String(data.step)}` : "0/0";
  switch (type) {
    case "step/start":
      return { events: [{ type: "step.started", runId, stepId }] };
    case "tool/call": {
      const callId = typeof data.callId === "string" ? data.callId : `call_${String(data.seq ?? "0")}`;
      return {
        events: [{
          type: "tool.requested",
          runId,
          stepId,
          toolCallId: callId,
          name: typeof data.name === "string" ? data.name : "unknown",
          input: safeParse(data.arguments),
        }],
      };
    }
    case "tool/result": {
      const message = data.message as { callId?: string; content?: unknown } | undefined;
      return {
        events: [{
          type: "tool.completed",
          runId,
          stepId,
          toolCallId: typeof message?.callId === "string" ? message.callId : "unknown",
          output: message?.content ?? message ?? data,
        }],
      };
    }
    case "assistant/message": {
      const text = assistantText(data.message);
      if (text !== "") onAssistantText(text);
      return { events: [{ type: "message", runId, text }] };
    }
    case "approval/asked":
      return {
        events: [{
          type: "approval.requested",
          runId,
          action: stringOr(data.action, "tool.confirm"),
          resource: stringOr(data.resource, "*"),
          reason: typeof data.reason === "string" ? data.reason : undefined,
        }],
      };
    default:
      return { events: [] };
  }
}

function assistantText(message: unknown): string {
  if (message === null || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (block !== null && typeof block === "object" && (block as { type?: string }).type === "text" ? String((block as { text?: unknown }).text ?? "") : ""))
      .join("");
  }
  return "";
}

function safeParse(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value !== "" ? value : fallback;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 默认工厂：使用宿主明确提供的可执行程序和 argv，不猜测 CLI/profile。
 * SDK 不捆绑可执行运行时。缺少启动配置时 run() 明确失败。
 */
export function createDefaultHarnessFactory(options: {
  provider?: string | undefined;
  model?: string | undefined;
  cwd?: string | undefined;
  env?: Record<string, string | undefined> | undefined;
  maxTokens?: number | undefined;
  /** 必须显式配置运行时；SDK 自身不包含可执行程序。 */
  dshBin?: string | undefined;
  dshArgs?: readonly string[] | undefined;
} = {}): DshHarnessFactory {
  return (modelRoute) => {
    const { command, args } = resolveDshLaunch(options.dshBin, options.dshArgs);
    const require = createRequire(import.meta.url);
    let clientModule: {
      DeepSeekHarness: new (harnessOptions: {
        launch: { command: string; args?: string[]; cwd?: string; env?: Record<string, string | undefined> };
        cwd?: string;
        provider?: string;
        model?: string;
        maxTokens?: number;
      }) => DshHarnessLike;
    };
    try {
      clientModule = require("@deepseek-ai/dsh-sdk-client") as typeof clientModule;
    } catch (error) {
      throw new Error(`@deepseek-ai/dsh-sdk-client is not installed (${describe(error)})`);
    }
    const harnessOptions: {
      launch: { command: string; args?: string[]; cwd?: string; env?: Record<string, string | undefined> };
      cwd?: string;
      provider?: string;
      model?: string;
      maxTokens?: number;
    } = {
      launch: { command, args },
    };
    const provider = modelRoute?.address.providerId ?? options.provider;
    const model = modelRoute?.address.modelId ?? options.model;
    if (provider !== undefined && provider !== "runtime") harnessOptions.provider = provider;
    if (model !== undefined && model !== "default") harnessOptions.model = model;
    if (options.maxTokens !== undefined) harnessOptions.maxTokens = options.maxTokens;
    if (options.cwd !== undefined) {
      harnessOptions.launch.cwd = options.cwd;
      harnessOptions.cwd = options.cwd;
    }
    if (options.env !== undefined) harnessOptions.launch.env = options.env;
    return new clientModule.DeepSeekHarness(harnessOptions);
  };
}

export function resolveDshLaunch(command: string | undefined, args: readonly string[] = []): { command: string; args: string[] } {
  if (typeof command !== "string" || !command.trim() || /[\0\r\n]/.test(command)) {
    throw new Error("请配置 XILING_DSH_BIN 为已安装的 Harness 可执行程序；SDK 不包含运行程序，不能仅保存模型密钥后运行");
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
    throw new Error("Harness 参数必须是字符串数组，不能是 shell 命令");
  }
  return { command, args: [...args] };
}

/** JSON argv preserves spaces/Unicode on all platforms; never interpreted by a shell. */
export function parseDshArgs(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("XILING_DSH_ARGS 必须是 JSON 字符串数组"); }
  if (!Array.isArray(value) || value.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
    throw new Error("XILING_DSH_ARGS 必须是 JSON 字符串数组");
  }
  return [...value] as string[];
}

/** Uses the shipped, executor-less composition; external overrides remain explicit. */
export function bundledHarnessLaunch(): { command: string; args: string[] } {
  return { command: process.execPath, args: [fileURLToPath(new URL("./harness-entry.js", import.meta.url))] };
}
