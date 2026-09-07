// CapabilityService（指南 §21/§23/§24/§53）：
// 五级判定中的前两级在这里完成：Agent Capability 目录 + Task Capability Grant。
// grant/revoke/attenuate 全部走事件；被委托权限永远 ⊆ 委托方权限。

import {
  OsError, entityNotFound, grantId as makeGrantId, newId, permissionDenied, correlationFor,
  grantCovers, attenuateGrant, isTerminalTaskState,
} from "@xiling/os-domain";
import type {
  AgentId, AttenuationRequest, CapabilityDescriptor, CapabilityGrant, CapabilityIssuer,
  GrantId, OSOperationContext, TaskId,
} from "@xiling/os-domain";
import type { KernelServices } from "./kernel-services.js";
import type { OSKernel } from "./kernel.js";

export class CapabilityService {
  /** Capability Registry：action 前缀 → 描述（谁拥有这个能力，由各服务注册） */
  private readonly registry = new Map<string, CapabilityDescriptor>();

  constructor(
    private readonly kernel: OSKernel,
    private readonly services: KernelServices,
  ) {}

  register(action: string, descriptor: CapabilityDescriptor = { action }): void {
    this.registry.set(action, descriptor);
  }

  unregister(action: string): void {
    this.registry.delete(action);
  }

  /** "谁拥有 capability = X"（指南 §21） */
  discover(prefix: string): CapabilityDescriptor[] {
    return [...this.registry.values()].filter((descriptor) => descriptor.action.startsWith(prefix));
  }

  mintId(): GrantId {
    return makeGrantId(newId("grant"));
  }

  async grant(input: {
    issuer: CapabilityIssuer;
    subject: AgentId;
    action: string;
    resource: string;
    taskId?: TaskId | undefined;
    expiresAt?: string | undefined;
    constraints?: Record<string, unknown> | undefined;
    ctx?: OSOperationContext | undefined;
  }): Promise<CapabilityGrant> {
    // 授权目录检查：subject 的 permissionPolicy 必须允许该 action
    const definition = this.services.agents.get(input.subject);
    if (!definition.permissionPolicy.allowedActions.some((allowed) => allowed === input.action || input.action.startsWith(`${allowed}.`) || allowed.endsWith(":*") && input.action.startsWith(allowed.slice(0, -1)))) {
      throw permissionDenied(`agent ${input.subject} policy does not allow action "${input.action}"`);
    }
    const grant: CapabilityGrant = {
      id: this.mintId(),
      issuer: input.issuer,
      subject: input.subject,
      action: input.action,
      resource: input.resource,
      taskId: input.taskId,
      constraints: input.constraints,
      expiresAt: input.expiresAt,
      createdAt: new Date().toISOString(),
    };
    this.kernel.emit("capability.granted", { grant }, correlationFor({ agentId: input.subject, taskId: input.taskId }), input.ctx);
    return grant;
  }

  async revoke(grantIdValue: string, reason: string, ctx?: OSOperationContext | undefined): Promise<void> {
    if (!this.services.projection.grants.has(makeGrantId(grantIdValue))) throw entityNotFound("grant", grantIdValue);
    this.kernel.emit("capability.revoked", { grantId: makeGrantId(grantIdValue), reason }, {}, ctx);
  }

  get(grantIdValue: string): CapabilityGrant {
    const grant = this.services.projection.grants.get(makeGrantId(grantIdValue));
    if (!grant) throw entityNotFound("grant", grantIdValue);
    return grant;
  }

  /**
   * 授权衰减（指南 §24）：从 delegator 持有的授权里派生更窄的授权给受托方。
   * 核心不变量：delegated ⊆ owned。
   */
  async attenuateForDelegation(input: {
    fromAgentId: AgentId;
    toAgentId: AgentId;
    taskId: TaskId;
    requests: AttenuationRequest[];
    ctx?: OSOperationContext | undefined;
  }): Promise<CapabilityGrant[]> {
    const mint = (prefix: string) => newId(prefix);
    const minted: CapabilityGrant[] = [];
    const recipient = this.services.agents.get(input.toAgentId);
    for (const request of input.requests) {
      const withinRecipientPolicy = recipient.permissionPolicy.allowedActions.some(
        (allowed) => allowed === request.action || allowed.endsWith(":*") && request.action.startsWith(allowed.slice(0, -2)) || allowed.endsWith(".*") && request.action.startsWith(allowed.slice(0, -2)),
      );
      if (!withinRecipientPolicy) {
        throw new OsError("attenuation_denied", `recipient ${input.toAgentId} policy does not allow ${request.action}`);
      }
      const owned = this.findOwnedGrant(input.fromAgentId, request.action, request.resource);
      if (!owned) {
        throw new OsError("attenuation_denied", `delegator ${input.fromAgentId} holds no grant covering ${request.action}:${request.resource}`);
      }
      minted.push(attenuateGrant(owned, { ...request, subject: input.toAgentId, taskId: input.taskId }, mint, new Date()));
    }
    for (const grant of minted) {
      this.kernel.emit("capability.granted", { grant }, correlationFor({ agentId: grant.subject, taskId: input.taskId }), input.ctx);
    }
    return minted;
  }

  private findOwnedGrant(agentId: AgentId, action: string, resource: string): CapabilityGrant | undefined {
    const now = new Date();
    return [...this.services.projection.grants.values()].find((grant) =>
      grant.subject === agentId && grantCovers(grant, action, resource, undefined, now).covered,
    );
  }

  /**
   * 五级判定的第 2 级：subject 在 task 上是否持有覆盖 action/resource 的有效授权。
   */
  check(input: {
    subject: AgentId;
    action: string;
    resource: string;
    taskId?: TaskId | undefined;
  }): { allowed: boolean; reason?: string | undefined } {
    const now = new Date();
    for (const grant of this.services.projection.grants.values()) {
      if (grant.subject !== input.subject) continue;
      const match = grantCovers(grant, input.action, input.resource, input.taskId, now);
      if (match.covered) return { allowed: true };
    }
    return { allowed: false, reason: `agent ${input.subject} has no valid grant for ${input.action}:${input.resource}` };
  }

  assertAllowed(input: { subject: AgentId; action: string; resource: string; taskId?: TaskId | undefined }): void {
    const verdict = this.check(input);
    if (!verdict.allowed) throw permissionDenied(verdict.reason ?? "permission denied");
  }

  /** 任务完成/取消时回收该任务作用域的授权（最小权限生命周期） */
  async releaseTaskGrants(taskId: TaskId): Promise<void> {
    const task = this.services.projection.tasks.get(taskId);
    if (!task || !isTerminalTaskState(task.state)) return;
    for (const grant of [...this.services.projection.grants.values()]) {
      if (grant.taskId === taskId) {
        await this.revoke(grant.id, `task ${taskId} is ${task.state}`);
      }
    }
  }
}
