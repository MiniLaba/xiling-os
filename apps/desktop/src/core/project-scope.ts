// 项目作用域注册表：内部窗口 → 项目 的显式绑定。
//
// 契约（INTEGRATION.md §模块边界）：
// "项目上下文必须按内部窗口/请求显式携带，跨项目访问拒绝。文件夹是 Workspace 的
//  实际存储位置，不等于 Project。"
//
// 因此作用域不是渲染器里的一个可变全局选择，而是核心进程持久化的绑定事实：
// - 每个窗口显式绑定一个项目；
// - 请求可以重复携带同一个项目（幂等），携带别的项目一律拒绝；
// - 重新绑定到另一个项目需要显式确认，避免 UI 误切换导致跨项目读写。

import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export class ProjectScopeError extends Error {
  constructor(readonly code: "scope_unbound" | "scope_conflict" | "scope_unknown_project", message: string) {
    super(message);
    this.name = "ProjectScopeError";
  }
}

export interface ProjectScopeBinding {
  windowId: string;
  projectId: string;
  boundAt: string;
}

export class ProjectScopeRegistry {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS project_scopes (
        window_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        bound_at TEXT NOT NULL
      );
    `);
  }

  /** 读取某窗口当前绑定的项目；未绑定时返回 undefined。 */
  bindingOf(windowId: string): ProjectScopeBinding | undefined {
    const row = this.database.prepare("SELECT window_id, project_id, bound_at FROM project_scopes WHERE window_id = ?").get(windowId) as
      | { window_id: string; project_id: string; bound_at: string }
      | undefined;
    return row === undefined ? undefined : { windowId: row.window_id, projectId: row.project_id, boundAt: row.bound_at };
  }

  /**
   * 绑定/重新绑定。已绑定到别的项目时必须显式 confirm，否则拒绝。
   * 只在项目确实存在时才允许绑定（调用方通过 exists 回调提供权威判断）。
   */
  bind(input: { windowId: string; projectId: string; confirm?: boolean | undefined; exists: (projectId: string) => boolean; now?: string | undefined }): ProjectScopeBinding {
    requireIdentifier(input.windowId, "windowId");
    requireIdentifier(input.projectId, "projectId");
    if (!input.exists(input.projectId)) {
      throw new ProjectScopeError("scope_unknown_project", `项目 ${input.projectId} 不存在`);
    }
    const existing = this.bindingOf(input.windowId);
    if (existing && existing.projectId !== input.projectId && input.confirm !== true) {
      throw new ProjectScopeError("scope_conflict", `窗口 ${input.windowId} 已绑定项目 ${existing.projectId}；切换到别的项目需要显式确认`);
    }
    const boundAt = input.now ?? new Date().toISOString();
    this.database.prepare(
      "INSERT INTO project_scopes (window_id, project_id, bound_at) VALUES (?, ?, ?) ON CONFLICT(window_id) DO UPDATE SET project_id = excluded.project_id, bound_at = excluded.bound_at",
    ).run(input.windowId, input.projectId, boundAt);
    return { windowId: input.windowId, projectId: input.projectId, boundAt };
  }

  /**
   * 解析一次请求的项目作用域。
   * - 未绑定 + 请求带项目 → 用请求的项目建立绑定（首次进入）；
   * - 未绑定 + 请求不带项目 → 拒绝，要求先显式选择项目；
   * - 已绑定 + 请求带同一个项目 → 通过；
   * - 已绑定 + 请求带别的项目 → 跨项目拒绝。
   */
  resolve(input: { windowId: string; requestedProjectId?: string | undefined }): string {
    const binding = this.bindingOf(input.windowId);
    if (!binding) {
      if (input.requestedProjectId === undefined) {
        throw new ProjectScopeError("scope_unbound", `窗口 ${input.windowId} 尚未绑定项目；请先显式选择项目`);
      }
      throw new ProjectScopeError("scope_unbound", `窗口 ${input.windowId} 尚未绑定项目；请先显式绑定 ${input.requestedProjectId}`);
    }
    if (input.requestedProjectId !== undefined && input.requestedProjectId !== binding.projectId) {
      throw new ProjectScopeError("scope_conflict", `窗口 ${input.windowId} 绑定的是项目 ${binding.projectId}，不能访问项目 ${input.requestedProjectId}`);
    }
    return binding.projectId;
  }

  unbind(windowId: string): boolean {
    return Number(this.database.prepare("DELETE FROM project_scopes WHERE window_id = ?").run(windowId).changes) > 0;
  }

  list(): ProjectScopeBinding[] {
    const rows = this.database.prepare("SELECT window_id, project_id, bound_at FROM project_scopes ORDER BY bound_at, window_id").all() as Array<{ window_id: string; project_id: string; bound_at: string }>;
    return rows.map((row) => ({ windowId: row.window_id, projectId: row.project_id, boundAt: row.bound_at }));
  }

  /** 项目被删除时的清理路径：移除所有指向它的窗口绑定。 */
  dropProject(projectId: string): number {
    return Number(this.database.prepare("DELETE FROM project_scopes WHERE project_id = ?").run(projectId).changes);
  }

  close(): void { this.database.close(); }
}

function requireIdentifier(value: string, field: string): void {
  if (typeof value !== "string" || !value.trim() || value.length > 200) throw new Error(`${field} 无效`);
}
