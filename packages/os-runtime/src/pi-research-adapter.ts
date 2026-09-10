// PiResearchRuntimeAdapter：把 Pi（@earendil-works）放进 Runtime Boundary 后面。
//
// 定位（INTEGRATION.md）：Pi 是科研路线的默认 Harness；DSH 与音频是适配器，不是并列的
// 产品后端。本文件与 dsh-adapter.ts 并列，内核只看到 AgentRuntime 端口；Pi 的具体实现由
// 宿主注入工厂（apps/desktop 用 @xiling/pi-runtime 构造），os-runtime 不直接依赖任何引擎包。
//
// 真实能力声明（禁止夸大）：
// - nativeInputModalities 默认只有 text；只有宿主按已解析的模型路由显式声明后才包含 image。
// - nativeOutputModalities 只有 text：适配器只映射文本增量，不声称能取回图像/音频。
// - supportsHostTools 默认为 false：executeTool 尚未接入 Pi 的工具循环。任务一旦携带工具契约，
//   run() 明确失败，既不静默剥离工具，也不假装工具已执行。
// - 取消：Pi 的 abort() 只中断当前轮；不支持取消时不会声称可取消。

import type { AgentId, NativeInputModality, NativeOutputModality, RunId } from "@xiling/os-domain";
import type { ActivationSpec, AgentRuntime, RunRequest, RuntimeEvent } from "./port.js";
import { composePrompt } from "./prompt-composer.js";

/**
 * Pi 侧事件的结构化子集（= @xiling/contracts 的 AgentStreamEvent 子集）。
 * 只描述 OS 真正消费的领域事实；轨迹细节留在 Pi 会话里，OS 不复制第二套。
 */
export type PiStreamEventLike =
  | { type: "session.started"; sessionId: string }
  | { type: "message.delta"; delta: string }
  | { type: "tool.started"; toolName: string; callId: string; arguments?: unknown }
  | { type: "tool.finished"; toolName: string; callId: string; artifactUri?: string; details?: unknown }
  | { type: "tool.failed"; toolName: string; callId: string; message: string; details?: unknown }
  | { type: "session.finished"; sessionId: string; stopReason: string }
  | { type: "session.error"; sessionId: string; message: string };

/** 一个 Pi 轮次的最小客户端面（PiRuntimeAdapter 结构化满足）。 */
export interface PiTurnSession {
  subscribe(listener: (event: PiStreamEventLike) => void | Promise<void>): () => void;
  prompt(text: string, images?: readonly unknown[]): Promise<void>;
  abort(): void;
}

export interface PiTurnSessionFactoryInput {
  request: RunRequest;
  /** 与 Pi 会话绑定的稳定 ID（跨任务恢复需要它）。 */
  sessionId: string;
}

export type PiTurnSessionFactory = (input: PiTurnSessionFactoryInput) => PiTurnSession;

export interface PiResearchRuntimeOptions {
  sessionFactory: PiTurnSessionFactory;
  /** 宿主已把 executeTool 桥接进 Pi 工具循环时才可置 true。 */
  supportsHostTools?: boolean;
  /** 宿主已把内核编译的上下文交给 Pi 时才为 false；Pi 自己持有历史时才为 true。 */
  ownsSessionHistory?: boolean;
  /** 单轮静默等待上限（ms）；未设置表示按宿主定义的自然结束。 */
  turnTimeoutMs?: number | undefined;
  /** 真实送得进模型的输入模态；默认仅 text。 */
  nativeInputModalities?: readonly NativeInputModality[];
  /** 声明与 Pi 编码代理包版本对应的基线（设置界面与诊断用）。 */
  compatibilityBaseline?: { agentCore: string; ai: string; codingAgent: string; mcpAdapter: string; sessionFormat: number };
}

export class PiResearchRuntimeAdapter implements AgentRuntime {
  readonly name = "pi-research";
  readonly supportsHostTools: boolean;
  readonly ownsSessionHistory: boolean;
  readonly supportsCancellation = true;
  readonly nativeInputModalities: readonly NativeInputModality[];
  readonly nativeOutputModalities: readonly NativeOutputModality[] = ["text"];
  readonly compatibilityBaseline: PiResearchRuntimeOptions["compatibilityBaseline"];

  private readonly runs = new Map<RunId, { session: PiTurnSession; queue: PiEventQueue; cancelled: boolean }>();
  private readonly suspended = new Set<AgentId>();

  constructor(private readonly options: PiResearchRuntimeOptions) {
    this.supportsHostTools = options.supportsHostTools === true;
    this.ownsSessionHistory = options.ownsSessionHistory === true;
    this.nativeInputModalities = options.nativeInputModalities ?? ["text"];
    this.compatibilityBaseline = options.compatibilityBaseline;
  }

  async activate(_spec: ActivationSpec): Promise<void> {}

  async *run(request: RunRequest): AsyncIterable<RuntimeEvent> {
    if (request.tools.length > 0 && (!this.supportsHostTools || !request.executeTool)) {
      yield { type: "run.failed", runId: request.runId, reason: "Pi 工具桥未接入内核；拒绝执行无法兑现的工具契约" };
      return;
    }
    if (this.runs.has(request.runId) || this.suspended.has(request.agentId)) {
      yield { type: "run.failed", runId: request.runId, reason: "Pi 运行会话忙或 Agent 已挂起" };
      return;
    }
    const sessionId = piSessionId(request);
    let session: PiTurnSession;
    try {
      session = this.options.sessionFactory({ request, sessionId });
    } catch (error) {
      yield { type: "run.failed", runId: request.runId, reason: `Pi 运行时不可用：${describe(error)}` };
      return;
    }

    const queue = new PiEventQueue();
    const unsubscribe = session.subscribe((event) => queue.push(event));
    const record = { session, queue, cancelled: false };
    this.runs.set(request.runId, record);
    yield { type: "run.started", runId: request.runId };

    let finalText = "";
    let terminal = false;
    let failure: string | undefined;
    let promptError: unknown;
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      const prompt = session.prompt(composePrompt(request))
        .catch((error: unknown) => { promptError = error; })
        .finally(() => queue.close());
      if (this.options.turnTimeoutMs !== undefined) {
        timer = setTimeout(() => { this.cancelRun(record); }, this.options.turnTimeoutMs);
      }
      void prompt;

      for (;;) {
        const event = await queue.next();
        if (event === undefined) break;
        switch (event.type) {
          case "session.started":
            break;
          case "message.delta":
            finalText += event.delta;
            break;
          case "tool.started":
            yield { type: "tool.requested", runId: request.runId, stepId: "pi/0", toolCallId: event.callId, name: event.toolName, input: event.arguments };
            break;
          case "tool.finished":
            yield { type: "tool.completed", runId: request.runId, stepId: "pi/0", toolCallId: event.callId, output: event.details };
            break;
          case "tool.failed":
            yield { type: "tool.completed", runId: request.runId, stepId: "pi/0", toolCallId: event.callId, output: { error: event.message } };
            break;
          case "session.finished":
            terminal = true;
            break;
          case "session.error":
            terminal = true;
            failure = event.message;
            break;
        }
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      unsubscribe();
      queue.close();
      this.runs.delete(request.runId);
    }

    if (finalText.trim() !== "") yield { type: "message", runId: request.runId, text: finalText };
    if (failure !== undefined) {
      yield { type: "run.failed", runId: request.runId, reason: record.cancelled ? "Pi 轮次已取消" : failure };
      return;
    }
    if (!terminal) {
      const reason = promptError === undefined ? "Pi 轮次未产生结束事件" : `Pi 轮次失败：${describe(promptError)}`;
      yield { type: "run.failed", runId: request.runId, reason: record.cancelled ? "Pi 轮次已取消" : reason };
      return;
    }
    yield { type: "run.completed", runId: request.runId, ...(finalText.trim() === "" ? {} : { summary: finalText }) };
  }

  async interrupt(runId: RunId): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    this.cancelRun(run);
  }

  /**
   * 协作式取消：先 abort Pi 当前轮，再关闭事件队列让 run() 立刻收敛。
   * 关闭队列会丢弃 abort 之后才到达的细节事件，但取消结论本身是确定的。
   */
  private cancelRun(run: { session: PiTurnSession; queue: PiEventQueue; cancelled: boolean }): void {
    run.cancelled = true;
    run.session.abort();
    run.queue.close();
  }

  async suspend(agentId: AgentId): Promise<void> { this.suspended.add(agentId); }
  async resume(agentId: AgentId): Promise<void> { this.suspended.delete(agentId); }
}

/** Pi 会话 ID：与 DSH 采用同一形状，便于按 Session/Task 恢复而不混用轨迹。 */
export function piSessionId(request: RunRequest): string {
  return `xiling-pi-${request.agentId}-${request.sessionId === undefined ? `task-${request.taskId}` : `session-${request.sessionId}`}`;
}

/**
 * 事件队列：把 Pi 的推送式监听器转成适配器可 await 的顺序流。
 * prompt() 结束（成功或失败）时 close()，已经入队的事件仍会被消费完，未产生终态即判失败。
 */
export class PiEventQueue {
  private readonly buffer: PiStreamEventLike[] = [];
  private waiter: ((value: PiStreamEventLike | undefined) => void) | undefined;
  private closed = false;

  push(event: PiStreamEventLike): void {
    if (this.closed) return;
    const waiter = this.waiter;
    if (waiter !== undefined) { this.waiter = undefined; waiter(event); return; }
    this.buffer.push(event);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const waiter = this.waiter;
    if (waiter !== undefined) { this.waiter = undefined; waiter(undefined); }
  }

  next(): Promise<PiStreamEventLike | undefined> {
    const buffered = this.buffer.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    if (this.closed) return Promise.resolve(undefined);
    return new Promise<PiStreamEventLike | undefined>((resolve) => { this.waiter = resolve; });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
