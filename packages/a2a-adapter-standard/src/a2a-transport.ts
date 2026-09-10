// A2A 标准传输边界：负责远端 Task 的发送、进度、取消与终态回执。
// 本模块只依赖 os-domain，不依赖 OSKernel，也不假设 HTTP/WebSocket/进程内实现。

import {
  artifactId as makeArtifactId,
  delegationId as makeDelegationId,
  taskId as makeTaskId,
} from "@xiling/os-domain";
import type {
  A2AStatusEvent,
  ArtifactRef,
  DelegationRequest,
  Task as DomainTask,
} from "@xiling/os-domain";
import { fromA2ATaskState, toA2ATask } from "./a2a-mapping.js";
import type { A2ATask } from "./a2a-mapping.js";

export interface A2APeer {
  id: string;
  endpoint: string;
  headers?: Readonly<Record<string, string>> | undefined;
}

export interface A2ATransportUpdate {
  /** 完整快照而不是增量 patch，便于断线重放与幂等对账。 */
  task: A2ATask;
}

export interface A2ATransport {
  sendTask(peer: A2APeer, task: A2ATask, signal?: AbortSignal | undefined): AsyncIterable<A2ATransportUpdate>;
  cancelTask(peer: A2APeer, taskId: string, reason?: string | undefined): Promise<void>;
}

export interface A2AExecutionInput {
  peer: A2APeer;
  delegation: DelegationRequest;
  task: DomainTask;
  signal?: AbortSignal | undefined;
  onStatus(status: Omit<A2AStatusEvent, "at">): void | Promise<void>;
}

/**
 * 把不可信的 A2A wire 更新归一化为内核可消费的最小回执。
 * 关联字段和 ArtifactRef 在适配器边界校验，OSKernel 不接触 wire 数据。
 */
export class A2AStandardClient {
  constructor(private readonly transport: A2ATransport) {}

  async execute(input: A2AExecutionInput): Promise<Omit<A2AStatusEvent, "at">> {
    const request = toA2ATask(input.delegation, input.task);
    let terminal: Omit<A2AStatusEvent, "at"> | undefined;
    let cancellation: Promise<void> | undefined;

    const report = async (status: Omit<A2AStatusEvent, "at">): Promise<void> => {
      if (terminal !== undefined) return;
      await input.onStatus(status);
      if (isTerminal(status.state)) terminal = status;
    };

    const cancel = (): Promise<void> => {
      if (cancellation !== undefined) return cancellation;
      cancellation = this.transport.cancelTask(input.peer, input.task.id, "local abort")
        .then(() => report(this.status(input.delegation, "cancelled", [], "local abort")));
      return cancellation;
    };
    const onAbort = () => { void cancel(); };
    input.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      if (input.signal?.aborted === true) await cancel();
      if (terminal !== undefined) return terminal;

      for await (const update of this.transport.sendTask(input.peer, request, input.signal)) {
        this.assertCorrelation(input.delegation, update.task);
        const state = fromA2ATaskState(update.task.status.state);
        const artifacts = state === "completed" ? artifactRefs(update.task) : [];
        await report(this.status(input.delegation, state, artifacts, statusReason(update.task)));
        if (terminal !== undefined) break;
      }

      if (terminal === undefined && input.signal?.aborted === true) await cancel();
      if (terminal === undefined) {
        await report(this.status(input.delegation, "failed", [], "remote stream ended without a terminal status"));
      }
      return terminal!;
    } catch (error) {
      if (input.signal?.aborted === true) {
        await cancel();
        return terminal!;
      }
      const reason = error instanceof Error ? error.message : "A2A transport failed";
      await report(this.status(input.delegation, "failed", [], reason));
      return terminal!;
    } finally {
      input.signal?.removeEventListener("abort", onAbort);
    }
  }

  async cancel(input: Omit<A2AExecutionInput, "task" | "signal"> & { reason?: string | undefined }): Promise<Omit<A2AStatusEvent, "at">> {
    await this.transport.cancelTask(input.peer, input.delegation.taskId, input.reason);
    const status = this.status(input.delegation, "cancelled", [], input.reason ?? "delegation cancelled");
    await input.onStatus(status);
    return status;
  }

  private assertCorrelation(delegation: DelegationRequest, task: A2ATask): void {
    if (task.id !== delegation.taskId) {
      throw new Error(`A2A task mismatch: expected ${delegation.taskId}, received ${task.id}`);
    }
    if (task.contextId !== delegation.delegationId) {
      throw new Error(`A2A context mismatch: expected ${delegation.delegationId}, received ${String(task.contextId)}`);
    }
  }

  private status(
    delegation: DelegationRequest,
    state: A2AStatusEvent["state"],
    outputArtifacts: ArtifactRef[],
    reason?: string | undefined,
  ): Omit<A2AStatusEvent, "at"> {
    return {
      delegationId: makeDelegationId(delegation.delegationId),
      taskId: makeTaskId(delegation.taskId),
      fromAgentId: delegation.toAgentId,
      state,
      outputArtifacts,
      reason,
    };
  }
}

function artifactRefs(task: A2ATask): ArtifactRef[] {
  const refs: ArtifactRef[] = [];
  const seen = new Set<string>();
  for (const artifact of task.artifacts ?? []) {
    const dataPart = artifact.parts.find((part) => part.kind === "data");
    const data = dataPart?.data as { artifactId?: unknown; version?: unknown } | undefined;
    if (data === undefined || data === null || typeof data !== "object") {
      throw new Error(`A2A artifact ${artifact.artifactId} has no typed data part`);
    }
    if (typeof data.artifactId !== "string" || data.artifactId !== artifact.artifactId) {
      throw new Error(`A2A artifact identity mismatch: ${artifact.artifactId}`);
    }
    if (!Number.isSafeInteger(data.version) || (data.version as number) < 1) {
      throw new Error(`A2A artifact ${artifact.artifactId} has an invalid version`);
    }
    const key = `${data.artifactId}@${String(data.version)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ artifactId: makeArtifactId(data.artifactId), version: data.version as number });
  }
  return refs;
}

function statusReason(task: A2ATask): string | undefined {
  return task.status.message?.parts.find((part) => part.kind === "text" && part.text?.trim())?.text?.trim();
}

function isTerminal(state: A2AStatusEvent["state"]): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}
