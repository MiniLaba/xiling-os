// WorkspaceService（指南 §17/§18）：
// Workspace = 持久数据视图（独立于 Sandbox）；协作只通过有界、可过期的 mount。
// 第一版提供内存路径安全模型（resolve 后禁止逃出子树），物理文件由 persistence 层接管。

import { entityNotFound, newId, OsError, permissionDenied, workspaceId as makeWorkspaceId } from "@xiling/os-domain";
import { correlationFor } from "@xiling/os-domain";
import type { AgentId, OSOperationContext, TaskId, Workspace, WorkspaceMount } from "@xiling/os-domain";
import type { KernelServices } from "./kernel-services.js";
import type { OSKernel } from "./kernel.js";

export class WorkspaceService {
  constructor(
    private readonly kernel: OSKernel,
    private readonly services: KernelServices,
  ) {}

  async create(ownerAgentId: AgentId, root: string, ctx?: OSOperationContext | undefined): Promise<Workspace> {
    const workspace: Workspace = {
      workspaceId: makeWorkspaceId(newId("ws")),
      ownerAgentId,
      root,
      createdAt: new Date().toISOString(),
    };
    this.kernel.emit("workspace.created", { workspace }, correlationFor({ agentId: ownerAgentId }), ctx);
    return workspace;
  }

  get(workspaceIdValue: string): Workspace {
    const workspace = this.services.projection.workspaces.get(workspaceIdValue);
    if (!workspace) throw entityNotFound("workspace", workspaceIdValue);
    return workspace;
  }

  findByOwner(agentId: AgentId): Workspace | undefined {
    return [...this.services.projection.workspaces.values()].find((workspace) => workspace.ownerAgentId === agentId);
  }

  /** 协作挂载：只暴露子树、绑定任务、可过期（指南 §18 的 Coding Agent 只拿 /project/frontend） */
  async mount(input: {
    sourceWorkspaceId: string;
    path: string;
    targetAgentId: AgentId;
    access: "read" | "write";
    taskId: TaskId;
    expiresAt?: string | undefined;
    ctx?: OSOperationContext | undefined;
  }): Promise<WorkspaceMount> {
    const workspace = this.get(input.sourceWorkspaceId);
    const normalized = normalizeWorkspacePath(input.path);
    if (normalized === undefined) throw new OsError("invalid_command", `mount path "${input.path}" escapes the workspace root`);
    const mount: WorkspaceMount = {
      sourceWorkspaceId: workspace.workspaceId,
      path: normalized,
      targetAgentId: input.targetAgentId,
      access: input.access,
      taskId: input.taskId,
      expiresAt: input.expiresAt,
    };
    this.kernel.emit("workspace.mounted", { mount }, correlationFor({ agentId: input.targetAgentId, taskId: input.taskId }), input.ctx);
    return mount;
  }

  /**
   * 访问判定（Workspace Isolation 不变量）：
   * owner 全权；非 owner 必须存在覆盖该路径的有效 mount，且访问级别足够。
   */
  checkAccess(agentId: AgentId, workspaceIdValue: string, path: string, access: "read" | "write", at: Date = new Date()): { allowed: boolean; reason?: string | undefined } {
    const workspace = this.services.projection.workspaces.get(workspaceIdValue);
    if (!workspace) return { allowed: false, reason: `workspace ${workspaceIdValue} not found` };
    if (workspace.ownerAgentId === agentId) return { allowed: true };
    const normalized = normalizeWorkspacePath(path);
    if (normalized === undefined) return { allowed: false, reason: "path escapes workspace root" };
    for (const mount of this.services.projection.mounts) {
      if (mount.sourceWorkspaceId !== workspaceIdValue || mount.targetAgentId !== agentId) continue;
      if (mount.expiresAt !== undefined && new Date(mount.expiresAt).getTime() <= at.getTime()) continue;
      if (!pathWithin(normalized, mount.path)) continue;
      if (access === "write" && mount.access !== "write") continue;
      return { allowed: true };
    }
    return { allowed: false, reason: `agent ${agentId} has no mount covering ${normalized}` };
  }

  assertAccess(agentId: AgentId, workspaceIdValue: string, path: string, access: "read" | "write"): void {
    const verdict = this.checkAccess(agentId, workspaceIdValue, path, access);
    if (!verdict.allowed) throw permissionDenied(verdict.reason ?? "workspace access denied");
  }
}

/** 解析并规范化 workspace 内路径；逃出根（../、绝对路径）返回 undefined */
function normalizeWorkspacePath(path: string): string | undefined {
  const parts = path.split("/").filter((segment) => segment !== "" && segment !== ".");
  let depth = 0;
  for (const segment of parts) {
    if (segment === "..") {
      depth -= 1;
      if (depth < 0) return undefined;
    } else {
      depth += 1;
    }
  }
  return parts.filter((segment) => segment !== "..").join("/");
}

function pathWithin(path: string, mountPath: string): boolean {
  if (mountPath === "") return true;
  return path === mountPath || path.startsWith(`${mountPath}/`);
}
