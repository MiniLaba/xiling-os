// ScriptedRuntimeAdapter：确定性脚本运行时（指南 §42"初期 Scheduler 不需要 AI"同理）。
// 不依赖网络与模型，让整条 OS 链路（Task/Artifact/Approval/GenUI/Recovery/A2A）
// 可以在无 LLM 的环境下确定性地开发、测试和回放。
// DeepSeekHarnessAdapter 未来实现同一个 AgentRuntime 接口即可接入。

import type { AgentId, RunId } from "@xiling/os-domain";
import type { ActivationSpec, AgentRuntime, RunRequest, RuntimeEvent } from "./port.js";

/** 供脚本使用的简化步骤：type + 除 runId 外的事件字段（可选 delayMs 控制节奏） */
export type ScriptedEvent = { delayMs?: number | undefined } & (
  { [K in RuntimeEvent["type"]]: Omit<Extract<RuntimeEvent, { type: K }>, "runId"> }[RuntimeEvent["type"]]
);

export interface ScriptedRun {
  /** 命中条件：goal 包含任一关键字（空数组 = 通配） */
  matchKeywords: string[];
  events: ScriptedEvent[];
}

export class ScriptedRuntimeAdapter implements AgentRuntime {
  readonly name: string;
  readonly nativeInputModalities = ["text"] as const;
  readonly nativeOutputModalities = ["text"] as const;

  private readonly runs = new Map<RunId, { interrupted: boolean }>();
  private readonly activeAgents = new Set<AgentId>();

  constructor(
    name: string,
    private readonly scripts: ScriptedRun[],
  ) {
    this.name = name;
  }

  async activate(spec: ActivationSpec): Promise<void> {
    this.activeAgents.add(spec.agentId);
  }

  async *run(request: RunRequest): AsyncIterable<RuntimeEvent> {
    const state = { interrupted: false };
    this.runs.set(request.runId, state);
    try {
      const script = this.scripts.find((candidate) =>
        candidate.matchKeywords.length === 0 || candidate.matchKeywords.some((keyword) => request.goal.includes(keyword)),
      ) ?? this.scripts[this.scripts.length - 1];
      if (!script) {
        yield { type: "run.failed", runId: request.runId, reason: "no scripted run configured" };
        return;
      }
      for (const step of script.events) {
        if (state.interrupted) {
          yield { type: "run.failed", runId: request.runId, reason: "interrupted" };
          return;
        }
        const { delayMs, ...rest } = step;
        if (delayMs !== undefined && delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          if (state.interrupted) {
            yield { type: "run.failed", runId: request.runId, reason: "interrupted" };
            return;
          }
        }
        yield { ...rest, runId: request.runId } as RuntimeEvent;
      }
    } finally {
      this.runs.delete(request.runId);
    }
  }

  async interrupt(runId: RunId): Promise<void> {
    const state = this.runs.get(runId);
    if (state) state.interrupted = true;
  }

  async suspend(agentId: AgentId): Promise<void> {
    this.activeAgents.delete(agentId);
  }

  async resume(agentId: AgentId): Promise<void> {
    this.activeAgents.add(agentId);
  }
}
