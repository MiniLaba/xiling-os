// 强类型 ID：防止把 TaskId 当 AgentId 用的那一类低级错误。
// 品牌类型在编译期区分、运行期就是 string，序列化零成本。

export type Brand<T, B extends string> = T & { readonly __brand: B };

export type AgentId = Brand<string, "AgentId">;
export type ActivationId = Brand<string, "ActivationId">;
export type SessionId = Brand<string, "SessionId">;
export type TaskId = Brand<string, "TaskId">;
export type RunId = Brand<string, "RunId">;
export type StepId = Brand<string, "StepId">;
export type ToolCallId = Brand<string, "ToolCallId">;
export type ArtifactId = Brand<string, "ArtifactId">;
export type GrantId = Brand<string, "GrantId">;
export type MemoryRecordId = Brand<string, "MemoryRecordId">;
export type WorkspaceId = Brand<string, "WorkspaceId">;
export type DelegationId = Brand<string, "DelegationId">;
export type ApprovalId = Brand<string, "ApprovalId">;
export type UiSurfaceId = Brand<string, "UiSurfaceId">;

import { randomUUID } from "node:crypto";

export const agentId = (value: string): AgentId => value as AgentId;
export const activationId = (value: string): ActivationId => value as ActivationId;
export const sessionId = (value: string): SessionId => value as SessionId;
export const taskId = (value: string): TaskId => value as TaskId;
export const runId = (value: string): RunId => value as RunId;
export const stepId = (value: string): StepId => value as StepId;
export const toolCallId = (value: string): ToolCallId => value as ToolCallId;
export const artifactId = (value: string): ArtifactId => value as ArtifactId;
export const grantId = (value: string): GrantId => value as GrantId;
export const memoryRecordId = (value: string): MemoryRecordId => value as MemoryRecordId;
export const workspaceId = (value: string): WorkspaceId => value as WorkspaceId;
export const delegationId = (value: string): DelegationId => value as DelegationId;
export const approvalId = (value: string): ApprovalId => value as ApprovalId;
export const uiSurfaceId = (value: string): UiSurfaceId => value as UiSurfaceId;

/** 生成带业务前缀的新 ID（task_9f2c…），便于日志与人眼排查。 */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}
