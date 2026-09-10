// Artifact 领域模型（指南 §2.5/§27）：
// Chat Message = communication，Artifact = result。
// Artifact 默认不可变，通过 version 演进；lineage 记录派生链（可回答"这个结论来自什么"）。

import type { AgentId, ArtifactId, TaskId, ToolCallId } from "./ids.js";
import type { ArtifactRef } from "./task.js";

export type ArtifactType =
  | "report"
  | "dataset"
  | "code_patch"
  | "image"
  | "plan"
  | "decision_record"
  | "ui_model"
  | "api_result"
  | "workflow_result"
  | "context_export"
  | "generic";

export interface ArtifactProvenance {
  creatorAgentId: AgentId;
  taskId?: TaskId | undefined;
  sourceToolCallId?: ToolCallId | undefined;
  /** 由哪些 Artifact 派生 */
  derivedFrom?: ArtifactRef[] | undefined;
  note?: string | undefined;
}

export interface Artifact {
  artifactId: ArtifactId;
  type: ArtifactType;
  mimeType: string;
  name: string;
  version: number;
  creatorAgentId: AgentId;
  taskId?: TaskId | undefined;
  provenance: ArtifactProvenance;
  /** 内容寻址引用（blob://<sha256>），payload 与元数据分离存放 */
  storageRef: string;
  metadata: Record<string, unknown>;
  lineage: ArtifactRef[];
  createdAt: string;
}

export function artifactUri(artifactId: ArtifactId, version: number): string {
  return `artifact://${artifactId}/version/${version}`;
}
