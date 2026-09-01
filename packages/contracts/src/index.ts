export type ResourceUri =
  | `project://${string}`
  | `artifact://${string}`
  | `dataset://${string}`;

/** 内置「自由探索」项目：自动播种的开放问答模式，不绑定单一研究问题。 */
export const FREE_EXPLORATION_PROJECT_ID = "free-exploration";

export type ArtifactLifecycle = "staging" | "available" | "quarantined" | "archived";

export interface ArtifactRecord {
  id: string;
  projectId: string;
  uri: `artifact://sha256/${string}`;
  sha256: string;
  bytes: number;
  mimeType: string;
  name: string;
  /** Core names are generic; domain packages may use a namespaced kind. */
  kind: string;
  lifecycle: ArtifactLifecycle;
  producerRunId?: string;
  sourceUri?: ResourceUri | string;
  createdAt: string;
  verifiedAt?: string;
}

export type ResearchEntityKind =
  | "Project"
  | "ResearchQuestion"
  | "Hypothesis"
  | "Claim"
  | "ClaimRevision"
  | "EvidenceAssertion"
  | "Paper"
  | "SourceFragment"
  | "Dataset"
  | "DatasetSnapshot"
  | "ResearchPlan"
  | "Approval"
  | "ResearchRun"
  | "Artifact"
  | "ArtifactVersion"
  | "LifecycleEvent"
  | "ReviewReport"
  | "WikiRevisionRef"
  | "Actor";

export type EvidenceStance = "supports" | "refutes" | "qualifies" | "insufficient";

export type ResearchEntityStatus =
  | "draft"
  | "accepted"
  | "rejected"
  | "superseded"
  | "pending"
  | "approved"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "staging"
  | "verified"
  | "available"
  | "quarantined"
  | "active"
  | "archived";

export interface ResearchGraphEntity {
  id: string;
  projectId: string;
  kind: ResearchEntityKind;
  title: string;
  summary: string;
  status?: ResearchEntityStatus;
  revision: number;
  uri?: ResourceUri | string;
  contentHash: string;
  stance?: EvidenceStance;
  confidence?: number;
  sourceLocator?: string;
  properties: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type ResearchRelationKind =
  | "CONTAINS"
  | "HAS_REVISION"
  | "HAS_FRAGMENT"
  | "CITES"
  | "ASSERTS"
  | "BASED_ON"
  | "USED"
  | "GENERATED"
  | "DERIVED_FROM"
  | "EVALUATES"
  | "DOCUMENTS"
  | "SUPERSEDES"
  | "HAS_VERSION"
  | "TRANSITIONED_BY"
  | "ASSOCIATED_WITH"
  | "REFERENCES";

export interface ResearchGraphRelation {
  id: string;
  projectId: string;
  kind: ResearchRelationKind;
  sourceId: string;
  targetId: string;
  properties: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type ResearchGraphView = "all" | "literature" | "evidence" | "provenance" | "artifacts";

export interface ResearchGraphProjection {
  projectId: string;
  view: ResearchGraphView;
  nodes: ResearchGraphEntity[];
  relations: ResearchGraphRelation[];
  generatedAt: string;
}

export type ResearchGraphProposalStatus = "pending" | "accepted" | "rejected";

export type ResearchGraphProposalAction =
  | { type: "create_claim"; title: string; summary: string }
  | { type: "revise_claim"; claimId: string; title: string; summary: string };

/**
 * A user-reviewable scientific change. Agent and UI authors write proposals;
 * only an explicit decision may mutate the Research Graph.
 */
export interface ResearchGraphProposal {
  id: string;
  projectId: string;
  action: ResearchGraphProposalAction;
  status: ResearchGraphProposalStatus;
  createdAt: string;
  decidedAt?: string;
  appliedEntityIds: string[];
}

/**
 * Presentation-only state for the Scientific Canvas. Coordinates and viewport
 * are intentionally stored outside the Research Graph so moving a node can
 * never mutate scientific facts or provenance.
 */
export interface ScientificCanvasPosition {
  entityId: string;
  x: number;
  y: number;
}

export interface ScientificCanvasViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface ScientificCanvasLayout {
  projectId: string;
  view: ResearchGraphView;
  revision: number;
  positions: ScientificCanvasPosition[];
  viewport?: ScientificCanvasViewport;
  updatedAt?: string;
}

/**
 * Read-only projection of the durable Agent Harness journal. This graph is
 * deliberately separate from ResearchGraphProjection: it explains how the
 * Agent worked, not whether a scientific claim is true.
 */
export type AgentExecutionGraphScope = "session" | "project";
export type AgentExecutionNodeKind = "project" | "session" | "run" | "delegation" | "model" | "tool" | "message" | "compaction";
export type AgentExecutionNodeStatus = "active" | "archived" | "queued" | "running" | "completed" | "failed" | "cancelled" | "suspended";
export type AgentExecutionEdgeKind = "contains" | "started" | "continued" | "delegated" | "invoked" | "returned" | "produced" | "compacted";

export interface AgentExecutionNode extends Record<string, unknown> {
  id: string;
  projectId: string;
  kind: AgentExecutionNodeKind;
  title: string;
  summary: string;
  status?: AgentExecutionNodeStatus;
  timestamp: string;
  source: {
    sessionId?: string;
    runId?: string;
    delegationId?: string;
    operationId?: string;
    entryId?: string;
  };
  metrics?: {
    totalTokens?: number;
    cost?: number;
    durationMs?: number;
  };
}

export interface AgentExecutionEdge {
  id: string;
  source: string;
  target: string;
  kind: AgentExecutionEdgeKind;
  label?: string;
}

export interface AgentExecutionGraphProjection {
  projectId: string;
  scope: AgentExecutionGraphScope;
  sessionId?: string;
  nodes: AgentExecutionNode[];
  edges: AgentExecutionEdge[];
  generatedAt: string;
  truncated: boolean;
  counts: {
    sessions: number;
    runs: number;
    delegations?: number;
    operations: number;
    entries: number;
  };
}

export type CanvasNodeKind =
  | "prompt"
  | "response"
  | "paper"
  | "dataset"
  | "note"
  | "recipe"
  | "tool-result"
  | "artifact"
  | "checkpoint";

export type CanvasEdgeKind = "follow-up" | "quote" | "produced" | "checkpoint";

export interface CanvasNode {
  id: string;
  projectId: string;
  kind: CanvasNodeKind;
  title: string;
  summary: string;
  parentId?: string;
  artifactUri?: ResourceUri;
  createdAt: string;
}

export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  kind: CanvasEdgeKind;
}

export interface CanvasBranchContext {
  projectId: string;
  activeNodeId: string;
  quotedNodeIds: string[];
  updatedAt?: string | undefined;
}

export interface ContextCapsule {
  id: string;
  sourceNodeId: string;
  sourceRevision: string;
  summary: string;
  claims: string[];
  artifactUris: ResourceUri[];
  layer?: "node" | "branch";
  coveredNodeIds?: string[];
  updatedAt?: string;
}

export interface ContextProjectionRequest {
  activeNodeId: string;
  quotedNodeIds: string[];
  capabilityQuery?: string;
  activatedCapabilityIds?: string[];
}

export interface ContextProjection {
  activeBranchNodeIds: string[];
  quotedNodeIds: string[];
  capsules: ContextCapsule[];
  artifactUris: ResourceUri[];
  activatedCapabilities: string[];
  explanation: string[];
  projectionHash: string;
  economy: { uniqueArtifactCount: number; reusedArtifactReferences: number; selectedNodeCount: number; capsuleReuseCount?: number };
}

export interface ContextAssemblyTrace {
  projectionHash: string;
  includedNodeIds: string[];
  exactNodeIds: string[];
  capsuleNodeIds: string[];
  omittedHistoryCount: number;
  activatedCapabilityIds: string[];
  activatedSkillNames: string[];
  estimatedInputTokens: number;
  availableInputTokens: number;
  cache: "hit" | "miss";
  degradations: string[];
  tokenComposition: { fixed: number; toolSchemas: number; skills: number; research: number; history: number };
  sourceCoverage: { exactBlockCount: number; locatorRequiredCount: number; locatedCount: number; ratio: number };
  deduplicatedHistoryCount: number;
}

export interface TokenLedgerEntry {
  id: string;
  sessionId: string;
  providerId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens?: number;
  totalTokens: number;
  cost: number;
  projectionHash?: string;
  contextEstimatedTokens?: number;
  contextAvailableTokens?: number;
  contextCacheHit?: boolean;
  activatedCapabilityCount?: number;
  activatedSkillCount?: number;
  omittedHistoryCount?: number;
  contextSourceCoverage?: number;
  contextDuplicateHistoryCount?: number;
  createdAt: string;
}

export interface AttentionItem {
  id: string;
  projectId: string;
  kind: "approval" | "failed-run" | "review" | "evidence-gap" | "proposal";
  severity: "info" | "warning" | "critical";
  title: string;
  summary: string;
  targetView: "chat" | "canvas" | "project" | "wiki" | "papers";
  sourceId: string;
  createdAt: string;
}

export interface InstalledSkillSummary {
  name: string;
  description: string;
  version: string;
  keywords: string[];
  capabilities: Array<{ id: string; description: string; toolName: string }>;
  loading: "on-demand";
}

export interface InstalledSkillsResponse {
  strategy: "lazy";
  residentMetadata: Array<"name" | "description" | "version" | "keywords" | "capabilities">;
  skills: InstalledSkillSummary[];
}

export type McpTransportKind = "stdio" | "http";
export type McpAuthenticationKind = "none" | "bearer" | "oauth";
export type McpAccessMode = "approval-required" | "trusted";
export type McpRuntimeState = "connected" | "cached" | "failed" | "needs-auth" | "not-connected" | "disabled";

export interface McpServerSettings {
  name: string;
  description: string;
  keywords: string[];
  transport: McpTransportKind;
  command?: string;
  args?: string[];
  url?: string;
  authentication: McpAuthenticationKind;
  credentialConfigured: boolean;
  access: McpAccessMode;
  enabled: boolean;
  runtimeState: McpRuntimeState;
  toolCount: number;
  resourceCount: number;
}

export interface McpSettingsResponse {
  adapter: { package: "pi-mcp-adapter"; version: string; license: "MIT"; installed: true };
  strategy: "proxy-lazy";
  isolation: "child-process";
  residentToolSchemas: 1;
  servers: McpServerSettings[];
}

export interface McpConnectionTestResult {
  ok: boolean;
  serverName: string;
  latencyMs: number;
  state: McpRuntimeState;
  toolCount: number;
  message: string;
  testedAt: string;
}

export type ApprovalRisk = "read" | "network" | "compute" | "write";

export interface ApprovalRequest {
  id: string;
  projectId: string;
  action: string;
  risks: ApprovalRisk[];
  resources: ResourceUri[];
  expiresAt: string;
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export interface ResearchApproval {
  id: string;
  projectId: string;
  planHash: string;
  resources: ResourceUri[];
  status: ApprovalStatus;
  createdAt: string;
  decidedAt?: string;
}

export interface ResearchRun {
  id: string;
  projectId: string;
  planId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  artifactUris: ResourceUri[];
  startedAt?: string;
  finishedAt?: string;
}

export interface ReviewerReport {
  id: string;
  runId: string;
  verdict: "accepted" | "rejected";
  checks: Array<{ id: string; passed: boolean; detail: string }>;
  limitations: string[];
  createdAt: string;
}

export interface WikiRevision {
  id: string;
  pageId: string;
  title: string;
  markdown: string;
  artifactUris: ResourceUri[];
  createdAt: string;
}

export interface PaperRecord {
  id: string;
  title: string;
  year: number;
  authors: string[];
  citationCount: number;
  references: string[];
  source: "semantic-scholar" | "openalex" | "fixture";
  url?: string;
  abstract?: string;
}

export interface LiteratureGraphNode extends PaperRecord {
  seed: boolean;
  relevance: number;
}

export interface LiteratureGraphEdge {
  id: string;
  source: string;
  target: string;
  kind: "citation" | "recommendation" | "co-citation" | "bibliographic-coupling";
  score: number;
}

export interface LiteratureGraph {
  seedIds: string[];
  nodes: LiteratureGraphNode[];
  edges: LiteratureGraphEdge[];
  algorithm: string;
  provider: "semantic-scholar" | "openalex" | "fixture";
  fetchedAt: string;
}

export interface LiteratureSearchResponse {
  query: string;
  papers: PaperRecord[];
  provider: "semantic-scholar" | "openalex";
  fetchedAt: string;
  cache: "miss" | "hit" | "stale";
  sourceHash: string;
  degradedFrom?: "semantic-scholar";
  attempts: number;
}

export type ProjectStatus = "active" | "paused" | "archived";
export type ProjectItemKind = "milestone" | "task" | "experiment";
export type ProjectItemStatus = "backlog" | "ready" | "running" | "blocked" | "done";

export interface ResearchProject {
  id: string;
  name: string;
  description: string;
  researchQuestion: string;
  /** Installed science-domain packages composed for this project. */
  domainIds: string[];
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ChatSessionSummary {
  id: string;
  projectId: string;
  title: string;
  preview: string;
  messageCount: number;
  canvasContext?: CanvasBranchContext | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessageRecord {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  text: string;
  status: "complete" | "cancelled";
  attachments?: AgentInputAttachment[];
  createdAt: string;
}

export interface AgentInputAttachment {
  id: string;
  name: string;
  modality: "image";
  mimeType: string;
  size: number;
  sha256: string;
}

export interface ProjectItem {
  id: string;
  projectId: string;
  kind: ProjectItemKind;
  title: string;
  notes: string;
  status: ProjectItemStatus;
  createdAt: string;
  updatedAt: string;
}

export interface WikiPageSummary {
  id: string;
  projectId: string;
  slug: string;
  title: string;
  revisionCount: number;
  updatedAt: string;
}

export interface WikiPageRevision {
  id: string;
  pageId: string;
  version: number;
  markdown: string;
  artifactUris: ResourceUri[];
  createdAt: string;
}

export interface WikiPageDetail extends WikiPageSummary {
  currentRevision: WikiPageRevision;
  revisions: WikiPageRevision[];
  backlinks: Array<{ id: string; slug: string; title: string }>;
}

export interface WikiSearchResult {
  pageId: string;
  slug: string;
  title: string;
  excerpt: string;
  version: number;
  updatedAt: string;
}

export interface EvidenceRecord {
  id: string;
  projectId: string;
  paper: PaperRecord;
  note: string;
  stance: EvidenceStance;
  confidence: number;
  sourceQuote: string;
  sourceLocator?: string;
  limitations: string;
  claimRevisionId?: string;
  createdAt: string;
}

export type BuiltinModelProviderId = "openai" | "anthropic" | "google" | "openrouter" | "deepseek" | "xai" | "mistral" | "moonshotai" | "zai" | "groq" | "custom";
export type CredentialProviderId = string;
export type ModelModality = "text" | "image" | "audio" | "video";

export interface ModelProviderCapabilities {
  input: ModelModality[];
  output: ModelModality[];
  modelDependent: boolean;
  note: string;
}

export interface CredentialFieldDescriptor {
  id: string;
  label: string;
  secret: boolean;
  placeholder: string;
}

export interface CredentialProviderStatus {
  id: CredentialProviderId;
  category: "model" | "literature" | "data";
  title: string;
  description: string;
  documentationUrl: string;
  fields: CredentialFieldDescriptor[];
  configuredFields: string[];
  configured: boolean;
  source: "environment" | "local" | "none";
  capabilities?: ModelProviderCapabilities;
}

export type ModelProviderId = BuiltinModelProviderId;

export interface ModelCatalogEntry {
  providerId: ModelProviderId;
  id: string;
  name: string;
  contextWindow: number;
  maxOutputTokens: number;
  reasoning: boolean;
  inputModalities: ModelModality[];
  outputModalities: ModelModality[];
}

export interface ProviderConnectionTestResult {
  ok: boolean;
  providerId: ModelProviderId;
  modelId: string;
  latencyMs: number;
  message: string;
  testedAt: string;
}

export interface ModelRouteSettings {
  providerId: ModelProviderId;
  modelId: string;
  inputModalities?: Array<"text" | "image">;
  capabilitySource?: "pi-catalog" | "native-probe";
  capabilitiesVerifiedAt?: string;
  reasoning: "off" | "low" | "medium" | "high";
}

export interface ModelRuntimeSettings {
  primary?: ModelRouteSettings;
  roleRoutes: Record<string, ModelRouteSettings>;
  updatedAt: string;
}

export interface ModelRouteStatus extends ModelRouteSettings {
  selectedModel?: ModelCatalogEntry;
  credentialConfigured: boolean;
  ready: boolean;
  reason: "credential_required" | "ready";
}

export interface ModelRuntimeStatus extends ModelRuntimeSettings {
  primary?: ModelRouteStatus;
  roleRoutes: Record<string, ModelRouteStatus>;
  ready: boolean;
  reason: "selection_required" | "credential_required" | "ready";
}

export type AgentStreamEvent =
  | { type: "run.accepted"; runId: string; userEntryId: string; attachments?: AgentInputAttachment[] }
  | { type: "entry.persisted"; runId: string; entryId: string; kind: "user" | "assistant" | "tool-call" | "tool-result" | "compaction"; text: string; createdAt: string }
  | { type: "run.settled"; runId: string; status: "completed" | "failed" | "cancelled" | "suspended"; assistantEntryId?: string }
  | { type: "session.started"; sessionId: string }
  | { type: "context.ready"; trace: ContextAssemblyTrace }
  | { type: "message.delta"; delta: string }
  | { type: "tool.started"; toolName: string; callId: string; arguments?: unknown }
  | { type: "tool.finished"; toolName: string; callId: string; artifactUri?: ResourceUri; details?: unknown }
  | { type: "tool.failed"; toolName: string; callId: string; message: string; details?: unknown }
  | { type: "workflow.projected"; projector: string; projectionKey: string; workflowId: string; projectId: string; sessionId: string; runId: string; sourceCallId: string; sourceEventSequence: number; sourceOperationId?: string; requestHash: string; workflowStatus: string; approvalRequired: true }
  | { type: "workflow.projection.failed"; projector: string; projectionKey: string; projectId: string; sessionId: string; runId: string; sourceCallId: string; sourceEventSequence: number; sourceOperationId?: string; retryable: boolean; message: string }
  | { type: "session.finished"; sessionId: string; stopReason: string }
  | { type: "session.error"; sessionId: string; message: string };

/**
 * Conservative shared token estimate used by the context assembler and the
 * Agent harness guard rails: ASCII text runs about 4 characters per token and
 * every non-ASCII character (CJK tokenizers land near 1 token/character) is
 * counted as one token, so uncertainty overestimates — never underestimates.
 */
export function estimateTextTokens(text: string): number {
  const nonAscii = [...text].filter((character) => (character.codePointAt(0) ?? 0) >= 128).length;
  return nonAscii + Math.ceil((text.length - nonAscii) / 4);
}
