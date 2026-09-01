import { validationFailure } from "../../http-errors.js";
import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { z } from "zod";
import { connectorJobSchema, connectorRequestSchema, idParamsSchema, toOceanSubsetRequest } from "@xiling/api-contracts";
import { listConnectors, preflightConnector, resolveConnectorMetadata, type ConnectorMetadataProbe, type ConnectorWorkflowService } from "@xiling/connectors";
import type { CredentialStore } from "@xiling/credentials";
import type { ConnectorMetadataSummary } from "@xiling/domain-ocean";

export interface ConnectorRouteDependencies {
  root: string;
  mode: "fixture" | "live";
  credentials: CredentialStore;
  credentialsReady: Promise<unknown>;
  probe: ConnectorMetadataProbe;
  workflow: ConnectorWorkflowService;
  workflowReady: Promise<unknown>;
  metadata: Map<string, { requestHash: string; metadata: ConnectorMetadataSummary }>;
  activeRuns: Map<string, AbortController>;
}

const credentialIdFor = (connectorId: string) => connectorId === "copernicus-marine" ? "copernicus-marine" : connectorId === "nasa-harmony" ? "nasa-earthdata" : undefined;

export function registerConnectorRoutes(app: FastifyInstance, dependencies: ConnectorRouteDependencies): void {
  const { root, credentials, credentialsReady, probe, workflow, workflowReady, metadata, activeRuns } = dependencies;

  app.get("/api/v1/connectors", async () => {
    await credentialsReady;
    return listConnectors().map((connector) => {
      const credentialId = credentialIdFor(connector.id);
      const status = credentialId ? credentials.status(credentialId) : undefined;
      return { ...connector, credentialConfigured: connector.authentication === "none" || Boolean(status?.configured), credentialSource: status?.source ?? "none", runtimeMode: dependencies.mode };
    });
  });

  app.post("/api/v1/connectors/preflight", async (request, reply) => {
    const parsed = connectorRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(validationFailure(parsed.error));
    try {
      await credentialsReady;
      const { depth, expectedShape, bytesPerValue, ...required } = parsed.data;
      const plan = preflightConnector({ ...required, ...(depth ? { depth } : {}), ...(expectedShape ? { expectedShape } : {}), ...(bytesPerValue ? { bytesPerValue } : {}) });
      const credentialId = credentialIdFor(parsed.data.connectorId);
      if (!credentialId || !credentials.status(credentialId).configured) return plan;
      return { ...plan, status: plan.estimatedBytes === undefined ? "metadata_required" as const : "ready" as const };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/v1/connectors/metadata", async (request, reply) => {
    const parsed = connectorRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(validationFailure(parsed.error));
    await credentialsReady;
    const credentialId = credentialIdFor(parsed.data.connectorId);
    if (credentialId && !credentials.status(credentialId).configured) return reply.code(409).send({ error: "credential_required" });
    try {
      const input = toOceanSubsetRequest(parsed.data);
      const result = await probe.probe(input);
      if (result.provider !== parsed.data.connectorId) throw new Error("metadata provider mismatch");
      const plan = preflightConnector(input);
      metadata.set(result.sourceHash, { requestHash: plan.requestHash, metadata: result });
      return { metadata: result, preflight: resolveConnectorMetadata(input, result, !credentialId || credentials.status(credentialId).configured) };
    } catch (error) {
      return reply.code(503).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/v1/connector-jobs", async () => { await workflowReady; return workflow.list(); });
  app.post("/api/v1/connector-jobs", async (request, reply) => {
    const parsed = connectorJobSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(validationFailure(parsed.error));
    await Promise.all([credentialsReady, workflowReady]);
    const input = toOceanSubsetRequest(parsed.data.request);
    const preflight = preflightConnector(input);
    const cached = metadata.get(parsed.data.sourceHash);
    if (!cached || cached.requestHash !== preflight.requestHash) return reply.code(409).send({ error: "metadata_expired; probe again" });
    const credentialId = credentialIdFor(input.connectorId);
    try { return reply.code(201).send(await workflow.prepare(input, cached.metadata, !credentialId || credentials.status(credentialId).configured)); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
  });

  const parseId = (value: unknown) => idParamsSchema.safeParse(value);
  app.post("/api/v1/connector-jobs/:id/approve", async (request, reply) => {
    const parsed = parseId(request.params); if (!parsed.success) return reply.code(400).send(validationFailure(parsed.error));
    await workflowReady; try { return await workflow.approve(parsed.data.id); } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.post("/api/v1/connector-jobs/:id/reject", async (request, reply) => {
    const parsed = parseId(request.params); if (!parsed.success) return reply.code(400).send(validationFailure(parsed.error));
    await workflowReady; try { return await workflow.reject(parsed.data.id); } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.post("/api/v1/connector-jobs/:id/run", async (request, reply) => {
    const parsed = parseId(request.params); if (!parsed.success) return reply.code(400).send(validationFailure(parsed.error));
    await workflowReady; if (activeRuns.has(parsed.data.id)) return reply.code(409).send({ error: "connector download is already active" });
    const controller = new AbortController(); activeRuns.set(parsed.data.id, controller);
    try { return await workflow.download(parsed.data.id, controller.signal); }
    catch (error) { return reply.code(controller.signal.aborted ? 499 : 409).send({ error: error instanceof Error ? error.message : String(error) }); }
    finally { activeRuns.delete(parsed.data.id); }
  });
  app.post("/api/v1/connector-jobs/:id/cancel", async (request, reply) => {
    const parsed = parseId(request.params); if (!parsed.success) return reply.code(400).send(validationFailure(parsed.error));
    const controller = activeRuns.get(parsed.data.id); if (!controller) return reply.code(409).send({ error: "connector download is not active" });
    controller.abort("cancelled by user"); return { status: "cancelling" };
  });

  app.get("/api/v1/connector-artifacts/:sha", async (request, reply) => {
    const parsed = z.object({ sha: z.string().regex(/^[a-f0-9]{64}$/) }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "invalid artifact hash" });
    try { return reply.type("application/json; charset=utf-8").send(await readFile(resolve(root, "connector-artifacts", `${parsed.data.sha}.json`))); }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? reply.code(404).send({ error: "Artifact not found" }) : reply.code(500).send({ error: "Artifact read failed" }); }
  });
  app.get("/api/v1/connector-run-artifacts/:runId/*", async (request, reply) => {
    const parsed = z.object({ runId: z.string().uuid(), "*": z.string().min(1) }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid connector artifact path" });
    const relative = parsed.data["*"];
    if (relative.includes("\\") || relative.split("/").includes("..")) return reply.code(400).send({ error: "Invalid connector artifact path" });
    const artifactRoot = resolve(root, "connector-runs", parsed.data.runId, "artifacts");
    const artifactPath = resolve(artifactRoot, relative);
    if (!artifactPath.startsWith(`${artifactRoot}${sep}`)) return reply.code(400).send({ error: "Invalid connector artifact path" });
    try {
      const extension = relative.split(".").at(-1)?.toLowerCase() ?? "";
      const contentTypes: Record<string, string> = { nc: "application/x-netcdf", nc4: "application/x-netcdf", csv: "text/csv; charset=utf-8", json: "application/json; charset=utf-8", zip: "application/zip" };
      return reply.type(contentTypes[extension] ?? "application/octet-stream").send(await readFile(artifactPath));
    } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? reply.code(404).send({ error: "Artifact not found" }) : reply.code(500).send({ error: "Artifact read failed" }); }
  });
}
