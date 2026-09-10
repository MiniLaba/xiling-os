// EventStore（指南 §2.6）：长期状态一律 Command → Domain Logic → Event → Store → Projection。
// 内存追加式实现；log() 持久化钩子留给未来替换成 PostgreSQL/文件存储，投影逻辑不变。

import { createHash } from "node:crypto";
import { newEventId } from "@xiling/os-domain";
import type { OSEvent, OSEventType, OSEventPayloads, UnserializedEvent, EventCorrelation } from "@xiling/os-domain";

export interface EventStoreHooks {
  /** 每条事件落库前的持久化钩子（JSON Lines 追加）；抛错则拒绝该事件 */
  append?: ((event: OSEvent) => void) | undefined;
}

export class EventStore {
  private readonly events: OSEvent[] = [];
  private readonly subscribers = new Set<(event: OSEvent) => void>();

  constructor(private readonly hooks: EventStoreHooks = {}) {}

  get size(): number {
    return this.events.length;
  }

  all(): readonly OSEvent[] {
    return this.events;
  }

  /**
   * 启动恢复专用：装载已经持久化的领域事件。
   *
   * 与 append() 不同，这里保留 eventId / seq / occurredAt，且不会再次调用
   * 持久化 hook；否则每次启动都会把历史事件当成新事件重复写回日志。
   * 为避免把两条时间线拼在一起，只允许在空 Store 上调用。
   */
  hydrate(persistedEvents: readonly OSEvent[]): void {
    if (this.events.length !== 0) throw new Error("event store can only be hydrated while empty");
    const validSequence = persistedEvents.every((event, index) =>
      Number.isInteger(event.seq) && event.seq > (index === 0 ? 0 : persistedEvents[index - 1]!.seq),
    );
    for (const [index, persisted] of persistedEvents.entries()) {
      // 早期 Desktop V2 曾在每次启动时重建 seq 并把恢复事件写回文件，形成
      // 1..N,1..2N 的断裂日志。保留文件顺序和 eventId，在内存中一次性修复 seq，
      // 使旧开发档案可读；合法时间线则逐字段原样保留。
      const event = structuredClone(persisted);
      if (!validSequence) event.seq = index + 1;
      this.events.push(event);
      for (const subscriber of this.subscribers) subscriber(event);
    }
  }

  /** 追加一条事件：分配全局单调 seq，通知订阅者（投影引擎）。 */
  append(unserialized: UnserializedEvent): OSEvent {
    const event = {
      seq: (this.events.at(-1)?.seq ?? 0) + 1,
      eventId: newEventId(),
      type: unserialized.type,
      occurredAt: new Date().toISOString(),
      correlation: unserialized.correlation ?? {},
      payload: unserialized.payload,
    } as OSEvent;
    this.hooks.append?.(event);
    this.events.push(event);
    for (const subscriber of this.subscribers) subscriber(event);
    return event;
  }

  subscribe(listener: (event: OSEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  byType<T extends OSEventType>(type: T): Array<OSEvent & { type: T; payload: OSEventPayloads[T] }> {
    return this.events.filter((event): event is OSEvent & { type: T; payload: OSEventPayloads[T] } => event.type === type);
  }

  /** 重放：从事件流重建投影（恢复与测试共用同一条路径） */
  replay<T>(project: (state: T, event: OSEvent) => T, seed: T): T {
    let state = seed;
    for (const event of this.events) state = project(state, event);
    return state;
  }
}

/** 内容寻址：artifact payload 的 storageRef（指南 §27） */
export function contentAddress(content: string): string {
  return `blob://${createHash("sha256").update(content).digest("hex")}`;
}
