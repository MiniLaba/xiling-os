// 状态机助手：所有长期实体的状态迁移必须走显式迁移表（指南 §2.6：
// 领域逻辑产出事件，而不是到处 UPDATE status）。

export class IllegalTransitionError extends Error {
  constructor(entity: string, from: string, to: string) {
    super(`${entity}: illegal state transition ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export function assertTransition<T extends string>(
  entity: string,
  transitions: Readonly<Record<T, readonly T[]>>,
  from: T,
  to: T,
): void {
  const allowed = transitions[from];
  if (!allowed?.includes(to)) throw new IllegalTransitionError(entity, from, to);
}
