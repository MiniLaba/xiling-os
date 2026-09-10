// Capability 领域模型（指南 §2.4/§21/§23/§24）：
// Capability 描述"谁，在什么 Task 中，对什么资源，可以做什么"。
// 授权衰减（attenuation）是 A2A 安全模型的基石：delegated ⊆ owned。

import { grantId } from "./ids.js";
import type { AgentId, GrantId, TaskId } from "./ids.js";

export type CapabilityIssuer = "user" | "system" | AgentId;

export interface CapabilityGrant {
  id: GrantId;
  issuer: CapabilityIssuer;
  subject: AgentId;
  action: string;
  /** "*" 表示全部资源；"repo/x" 前缀覆盖 "repo/x/**" */
  resource: string;
  taskId?: TaskId | undefined;
  constraints?: Record<string, unknown> | undefined;
  expiresAt?: string | undefined;
  createdAt: string;
}

export interface CapabilityDescriptor {
  action: string;
  description?: string | undefined;
}

export interface AttenuationRequest {
  subject: AgentId;
  action: string;
  resource: string;
  taskId?: TaskId | undefined;
  /** 委托有效期（分钟）；缺失时继承 owned 的剩余时长 */
  expiresInMinutes?: number | undefined;
}

export interface CapabilityMatchCheck {
  covered: boolean;
  reason?: string | undefined;
}

/** owned.action 是否覆盖 requested.action（"github.repo.write:*" ⊇ "github.repo.write" 与 "github.repo.write:repo/x"） */
export function actionCoveredBy(owned: string, requested: string): boolean {
  if (owned === requested) return true;
  if (owned.endsWith(":*")) return requested.startsWith(owned.slice(0, -2));
  if (owned.endsWith(".*")) return requested.startsWith(owned.slice(0, -2));
  return false;
}

/** owned.resource 是否覆盖 requested.resource（"*" ⊇ 一切；"reports/*" ⊇ "reports/q3/final"） */
export function resourceCoveredBy(owned: string, requested: string): boolean {
  if (owned === "*" || owned === requested) return true;
  if (requested.startsWith(`${owned}/`)) return true;
  // 段级通配：owned 的每一段匹配 requested 的对应段，"*" 匹配任意段
  const ownedParts = owned.split("/");
  const requestedParts = requested.split("/");
  return ownedParts.length <= requestedParts.length && ownedParts.every((part, index) => part === "*" || part === requestedParts[index]);
}

export function grantCovers(owned: CapabilityGrant, action: string, resource: string, taskId?: TaskId | undefined, at: Date = new Date()): CapabilityMatchCheck {
  if (owned.expiresAt !== undefined && new Date(owned.expiresAt).getTime() <= at.getTime()) {
    return { covered: false, reason: `grant ${owned.id} expired at ${owned.expiresAt}` };
  }
  if (!actionCoveredBy(owned.action, action)) {
    return { covered: false, reason: `grant ${owned.id} action "${owned.action}" does not cover "${action}"` };
  }
  if (!resourceCoveredBy(owned.resource, resource)) {
    return { covered: false, reason: `grant ${owned.id} resource "${owned.resource}" does not cover "${resource}"` };
  }
  if (owned.taskId !== undefined && owned.taskId !== taskId) {
    return { covered: false, reason: `grant ${owned.id} is scoped to task ${owned.taskId}` };
  }
  return { covered: true };
}

/**
 * 授权衰减：从 owned 派生一张更窄的新授权。
 * 新授权的 action/resource 必须被 owned 覆盖；有效期不得超过 owned 的剩余时长。
 * 不满足即抛错——被委托权限永远不超过委托方权限。
 */
export function attenuateGrant(owned: CapabilityGrant, request: AttenuationRequest, mint: (prefix: string) => string, now: Date = new Date()): CapabilityGrant {
  const check = grantCovers(owned, request.action, request.resource, request.taskId, now);
  if (!check.covered) {
    throw new Error(`capability attenuation denied: ${check.reason ?? "not covered"}`);
  }
  let expiresAt: string | undefined;
  if (owned.expiresAt !== undefined) {
    const ownedExpiry = new Date(owned.expiresAt);
    const requestedExpiry = request.expiresInMinutes !== undefined
      ? new Date(now.getTime() + request.expiresInMinutes * 60_000)
      : ownedExpiry;
    expiresAt = (requestedExpiry <= ownedExpiry ? requestedExpiry : ownedExpiry).toISOString();
  } else if (request.expiresInMinutes !== undefined) {
    expiresAt = new Date(now.getTime() + request.expiresInMinutes * 60_000).toISOString();
  }
  return {
    id: grantId(mint("grant")),
    issuer: owned.subject,
    subject: request.subject,
    action: request.action,
    resource: request.resource,
    taskId: request.taskId,
    constraints: owned.constraints,
    expiresAt,
    createdAt: now.toISOString(),
  };
}
