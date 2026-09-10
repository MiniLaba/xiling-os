// ArtifactService（指南 §2.5/§27/§53）：
// Chat Message = communication；Artifact = result。
// 不可变 + 版本演进 + 内容寻址 + lineage（可回答"这个结论来自什么"）。

import {
  artifactId as makeArtifactId, artifactUri, newId, correlationFor, entityNotFound,
} from "@xiling/os-domain";
import { contentAddress } from "./event-store.js";
import type { AgentId, Artifact, ArtifactProvenance, ArtifactRef, ArtifactType, OSOperationContext, TaskId } from "@xiling/os-domain";
import type { KernelServices } from "./kernel-services.js";
import type { OSKernel } from "./kernel.js";

export interface ArtifactCreateInput {
  name: string;
  type: ArtifactType;
  mimeType: string;
  content: string;
  creatorAgentId: AgentId;
  taskId?: TaskId | undefined;
  provenance?: Omit<ArtifactProvenance, "creatorAgentId"> | undefined;
  metadata?: Record<string, unknown> | undefined;
  derivedFrom?: ArtifactRef[] | undefined;
  ctx?: OSOperationContext | undefined;
}

export class ArtifactService {
  constructor(
    private readonly kernel: OSKernel,
    private readonly services: KernelServices,
  ) {}

  /** User promotion of an existing answer, never arbitrary renderer-supplied content. */
  async saveAnswer(messageId: string, ctx: OSOperationContext): Promise<Artifact> {
    if (ctx.actor !== "user") throw new Error("保存回答仅允许用户操作");
    const message = this.services.projection.messages.find((item) => item.id === messageId);
    if (!message || message.role !== "assistant" || !message.text.trim()) throw new Error("没有可保存的回答");
    const task = this.kernel.tasks.get(message.taskId);
    if (task.state !== "completed") throw new Error("任务完成后才可保存回答");
    const existing = [...this.services.projection.artifacts.values()].find((item) => item.metadata.sourceMessageId === message.id && item.metadata.creationMode === "user-saved-answer");
    if (existing) return existing;
    return this.create({ name: `${task.goal.slice(0, 60)}.md`, type: "generic", mimeType: "text/markdown", content: message.text,
      creatorAgentId: message.agentId, taskId: task.id,
      metadata: { creationMode: "user-saved-answer", sourceMessageId: message.id, sourceRunId: message.runId, savedBy: "user" }, ctx });
  }

  async create(input: ArtifactCreateInput): Promise<Artifact> {
    const artifactId = makeArtifactId(newId("art"));
    const artifact: Artifact = {
      artifactId,
      type: input.type,
      mimeType: input.mimeType,
      name: input.name,
      version: 1,
      creatorAgentId: input.creatorAgentId,
      taskId: input.taskId,
      provenance: { ...input.provenance, creatorAgentId: input.creatorAgentId },
      storageRef: contentAddress(input.content),
      metadata: input.metadata ?? {},
      lineage: input.derivedFrom ?? [],
      createdAt: new Date().toISOString(),
    };
    this.kernel.artifactContentStore.put(artifact.storageRef, input.content);
    this.kernel.emit("artifact.created", { artifact }, correlationFor({ agentId: input.creatorAgentId, taskId: input.taskId, artifactId }), input.ctx);
    if (input.taskId !== undefined) {
      this.kernel.emit("task.artifact_added", { taskId: input.taskId, artifactId, version: 1 }, correlationFor({ taskId: input.taskId, artifactId }), input.ctx);
    }
    return artifact;
  }

  /** 不可变演进：新版本 = 新事件，旧版本永不被覆盖 */
  async derive(artifactIdValue: string, input: Omit<ArtifactCreateInput, "derivedFrom">, ctx?: OSOperationContext | undefined): Promise<Artifact> {
    const previous = this.get(artifactIdValue);
    const next = await this.create({
      ...input,
      derivedFrom: [...previous.lineage, { artifactId: previous.artifactId, version: previous.version }],
      ctx,
    });
    this.kernel.emit("artifact.version_added", { artifact: next }, correlationFor({ artifactId: next.artifactId }), ctx);
    return next;
  }

  get(artifactIdValue: string): Artifact {
    const artifact = this.services.projection.artifacts.get(artifactIdValue);
    if (!artifact) throw entityNotFound("artifact", artifactIdValue);
    return artifact;
  }

  uri(artifactIdValue: string): string {
    return artifactUri(this.get(artifactIdValue).artifactId, this.get(artifactIdValue).version);
  }

  /** 通过事件事实读取不可变内容；调用方不需要越过服务边界扫描 EventStore。 */
  contentOf(artifactIdValue: string): string {
    const artifact = this.get(artifactIdValue);
    const content = this.kernel.artifactContentStore.get(artifact.storageRef);
    if (content === undefined) throw entityNotFound("artifact content", artifactIdValue);
    return content;
  }

  /** lineage 正向遍历：从根到该 Artifact 的派生链 */
  lineageOf(artifactIdValue: string): Artifact[] {
    const chain: Artifact[] = [];
    let current = this.get(artifactIdValue);
    while (true) {
      chain.unshift(current);
      const parentRef = current.lineage[current.lineage.length - 1];
      if (parentRef === undefined) break;
      const parent = this.services.projection.artifacts.get(parentRef.artifactId);
      if (!parent) break;
      current = parent;
      if (chain.length > 256) break;
    }
    return chain;
  }
}
