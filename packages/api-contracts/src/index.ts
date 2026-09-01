import { z } from "zod";
import { FREE_EXPLORATION_PROJECT_ID, type PaperRecord, type ResourceUri } from "@xiling/contracts";
import type { OceanSubsetRequest } from "@xiling/domain-ocean";

export const projectIdSchema = z.string().min(1).max(120);
export const sessionIdSchema = z.string().min(1).max(160);
export const idParamsSchema = z.object({ id: sessionIdSchema });
export const projectIdQuerySchema = z.object({ projectId: projectIdSchema.default(FREE_EXPLORATION_PROJECT_ID) });
export const researchGraphProjectParamsSchema = z.object({ projectId: projectIdSchema });
export const researchGraphProjectionQuerySchema = z.object({ view: z.enum(["all", "literature", "evidence", "provenance", "artifacts"]).default("all") });
export const scientificCanvasLayoutSchema = z.object({
  revision: z.number().int().nonnegative(),
  positions: z.array(z.object({ entityId: z.string().min(1).max(240), x: z.number().finite(), y: z.number().finite() })).max(2_000),
  viewport: z.object({ x: z.number().finite(), y: z.number().finite(), zoom: z.number().finite().min(0.05).max(8) }).optional(),
});
export const researchGraphArtifactParamsSchema = researchGraphProjectParamsSchema.extend({ artifactVersionId: z.string().min(1).max(240) });
export const researchGraphProposalParamsSchema = researchGraphProjectParamsSchema.extend({ proposalId: z.string().uuid() });
export const researchGraphProposalCreateSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("create_claim"), title: z.string().trim().min(1).max(500), summary: z.string().trim().min(1).max(20_000) }),
  z.object({ type: z.literal("revise_claim"), claimId: z.string().min(1).max(240), title: z.string().trim().min(1).max(500), summary: z.string().trim().min(1).max(20_000) }),
]);
export const researchGraphProposalDecisionSchema = z.object({ decision: z.enum(["accept", "reject"]) });

export const branchContextSchema = z.object({
  activeNodeId: z.string().min(1).max(120),
  quotedNodeIds: z.array(z.string().min(1).max(120)).max(12).default([]),
});

export const projectionSchema = branchContextSchema.extend({
  projectId: projectIdSchema.default(FREE_EXPLORATION_PROJECT_ID),
  capabilityQuery: z.string().max(10_000).optional(),
});

export const connectorRequestSchema = z.object({
  connectorId: z.enum(["erddap", "argo-gdac", "copernicus-marine", "nasa-harmony"]),
  datasetId: z.string().min(1).max(240),
  variables: z.array(z.string().min(1).max(120)).min(1).max(20),
  region: z.object({ west: z.number(), east: z.number(), south: z.number(), north: z.number() }),
  depth: z.object({ min: z.number(), max: z.number() }).optional(),
  time: z.object({ start: z.string().min(1).max(40), end: z.string().min(1).max(40) }),
  outputFormat: z.enum(["NetCDF", "Zarr", "CSV"]),
  expectedShape: z.array(z.number().int().positive()).max(16).optional(),
  bytesPerValue: z.number().positive().optional(),
});
export type ConnectorRequest = z.infer<typeof connectorRequestSchema>;
export function toOceanSubsetRequest(value: ConnectorRequest): OceanSubsetRequest {
  const { depth, expectedShape, bytesPerValue, ...required } = value;
  return { ...required, ...(depth ? { depth } : {}), ...(expectedShape ? { expectedShape } : {}), ...(bytesPerValue ? { bytesPerValue } : {}) };
}
export const connectorJobSchema = z.object({ request: connectorRequestSchema, sourceHash: z.string().regex(/^[a-f0-9]{64}$/) });
export const projectWorkflowCreateSchema = z.object({ projectId: projectIdSchema, sessionId: sessionIdSchema, sourceCallId: z.string().min(1).max(200), request: connectorRequestSchema });

export const scienceDomainIdSchema = z.string().regex(/^[a-z0-9-]{2,80}$/);
export const projectCreateSchema = z.object({ name: z.string().min(1).max(160), description: z.string().max(1_000).default(""), researchQuestion: z.string().min(1).max(1_000), domainIds: z.array(scienceDomainIdSchema).min(1).max(8).default(["general-science"]) });
export const projectUpdateSchema = projectCreateSchema.partial().extend({ status: z.enum(["active", "paused", "archived"]).optional() });
export const itemCreateSchema = z.object({ projectId: projectIdSchema, kind: z.enum(["milestone", "task", "experiment"]), title: z.string().min(1).max(240), notes: z.string().max(2_000).default("") });
export const itemUpdateSchema = z.object({ title: z.string().min(1).max(240).optional(), notes: z.string().max(2_000).optional(), status: z.enum(["backlog", "ready", "running", "blocked", "done"]).optional() });
export const chatSessionCreateSchema = z.object({ projectId: projectIdSchema, title: z.string().trim().min(1).max(160) });

export const artifactUriSchema = z.string().startsWith("artifact://").transform((value) => value as `artifact://${string}`);
export const wikiCreateSchema = z.object({ projectId: projectIdSchema.optional(), title: z.string().min(1).max(240), markdown: z.string().max(100_000), artifactUris: z.array(artifactUriSchema).max(100).optional() });
export const wikiRevisionSchema = wikiCreateSchema.pick({ markdown: true, artifactUris: true }).extend({ title: z.string().min(1).max(240).optional() });
export const wikiSearchSchema = z.object({ projectId: projectIdSchema, q: z.string().trim().min(1).max(160), limit: z.coerce.number().int().min(1).max(50).default(20) });
export const wikiRevisionParamsSchema = idParamsSchema.extend({ version: z.coerce.number().int().positive() });

export const paperSchema = z.object({ id: z.string().min(1).max(240), title: z.string().min(1).max(1_000), year: z.number().int().min(0).max(3_000), authors: z.array(z.string().min(1).max(240)).max(200), citationCount: z.number().int().min(0), references: z.array(z.string().min(1).max(240)).max(10_000), source: z.enum(["semantic-scholar", "openalex", "fixture"]), url: z.string().url().optional(), abstract: z.string().max(50_000).optional() });
export const scopedPaperSchema = z.object({
  projectId: projectIdSchema,
  paper: paperSchema,
  note: z.string().max(20_000).default(""),
  stance: z.enum(["supports", "refutes", "qualifies", "insufficient"]).default("insufficient"),
  confidence: z.number().min(0).max(1).default(0.5),
  sourceQuote: z.string().trim().max(20_000).default(""),
  sourceLocator: z.string().trim().max(2_000).optional(),
  limitations: z.string().trim().max(10_000).default(""),
  claimRevisionId: z.string().trim().min(1).max(240).optional(),
});
export function toPaperRecord(paper: z.infer<typeof paperSchema>): PaperRecord { return { id: paper.id, title: paper.title, year: paper.year, authors: paper.authors, citationCount: paper.citationCount, references: paper.references, source: paper.source, ...(paper.url ? { url: paper.url } : {}), ...(paper.abstract ? { abstract: paper.abstract } : {}) }; }
export const literatureQuerySchema = z.object({ q: z.string().trim().min(2).max(200), limit: z.coerce.number().int().min(5).max(40).default(20) });

export const credentialIdSchema = z.object({ id: z.enum(["openai", "anthropic", "google", "openrouter", "deepseek", "xai", "mistral", "moonshotai", "zai", "groq", "custom", "semantic-scholar", "openalex", "copernicus-marine", "nasa-earthdata"]) });
export const credentialValuesSchema = z.object({ values: z.record(z.string().min(1).max(80), z.string().min(1).max(20_000)) });
export const modelProviderIdSchema = z.enum(["openai", "anthropic", "google", "openrouter", "deepseek", "xai", "mistral", "moonshotai", "zai", "groq", "custom"]);
export const modelRouteSchema = z.object({ providerId: modelProviderIdSchema, modelId: z.string().trim().min(1).max(240), inputModalities: z.array(z.enum(["text", "image"])).min(1).max(2).optional(), reasoning: z.enum(["off", "low", "medium", "high"]) }).refine((value) => !value.inputModalities || value.inputModalities.includes("text"), { message: "text input must remain enabled" });
export const modelRuntimeSchema = z.object({ primary: modelRouteSchema, roleRoutes: z.record(z.string().min(1).max(80), modelRouteSchema).refine((routes) => Object.keys(routes).length <= 16, { message: "too many role routes" }).default({}) });
export const providerTestSchema = z.object({ modelId: z.string().trim().min(1).max(240).optional() });


// ── Agent Center（正式 Chat command API）───────────────────────────────
export const agentCenterIdSchema = z.string().min(1).max(160);
export const agentAttachmentUploadSchema = z.object({
  name: z.string().trim().min(1).max(240),
  modality: z.enum(["image", "audio", "video"]),
  mimeType: z.string().trim().min(1).max(120),
  size: z.number().int().positive().max(8 * 1024 * 1024),
  data: z.string().min(4).max(12 * 1024 * 1024),
});
export const agentSessionCreateSchema = z.object({ id: agentCenterIdSchema.optional(), projectId: projectIdSchema });
export const agentRunCommandSchema = z.object({
  sessionId: agentCenterIdSchema,
  projectId: projectIdSchema,
  prompt: z.string().min(1).max(50_000),
  clientCommandId: agentCenterIdSchema,
  modelRoute: z.object({ providerId: modelProviderIdSchema, modelId: z.string().trim().min(1).max(240) }).optional(),
  context: z.object({ activeNodeId: z.string().min(1).max(120), quotedNodeIds: z.array(z.string().min(1).max(120)).max(12) }).optional(),
  attachments: z.array(agentAttachmentUploadSchema).max(4).optional(),
});

export interface ApiErrorBody { error: unknown; }
