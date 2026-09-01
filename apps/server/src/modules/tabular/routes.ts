import { createHash, randomUUID } from "node:crypto";
import { validationFailure } from "../../http-errors.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ArtifactRegistry } from "@xiling/artifacts";
import { ExecutionCoordinator, executionPlanHash, materializeExecution, type ExecutionPlan, type ExecutionRunner } from "@xiling/execution";
import { describeNumericColumns, importDelimitedText } from "@xiling/domain-tabular";

const requestSchema = z.object({ projectId: z.string().min(1).max(120), csvText: z.string().min(3).max(1_000_000), numericColumns: z.array(z.string().min(1).max(200)).min(1).max(64) });
const runSchema = requestSchema.extend({ approvedPlanHash: z.string().regex(/^[a-f0-9]{64}$/), idempotencyKey: z.string().min(1).max(200) });

export function registerTabularExecutionRoutes(app: FastifyInstance, dependencies: { artifacts: ArtifactRegistry; executions: ExecutionCoordinator; projectExists(projectId: string): boolean }): void {
  const recipeSource = `${importDelimitedText.toString()}\n${describeNumericColumns.toString()}\n`;
  const buildPlan = async (input: z.infer<typeof requestSchema>): Promise<ExecutionPlan> => {
    const code = await dependencies.artifacts.put({ projectId: input.projectId, name: "tabular-describe.recipe.js", mimeType: "text/javascript", kind: "code-snapshot", data: Buffer.from(recipeSource) });
    return { projectId: input.projectId, recipe: { id: "tabular.describe", version: "1.0.0" }, inputSelectors: { csvSha256: createHash("sha256").update(input.csvText).digest("hex") }, code: { uri: code.uri, sha256: code.sha256 }, parameters: { numericColumns: input.numericColumns }, randomSeed: 0, environment: { imageDigest: `sha256:${createHash("sha256").update("xiling-tabular-runtime-v1").digest("hex")}` }, resources: { cpu: 1, memoryBytes: 512 * 1024 * 1024, timeoutMs: 30_000 }, network: { mode: "none" } };
  };
  app.post("/api/v1/tabular/plans", async (request, reply) => {
    const parsed = requestSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send(validationFailure(parsed.error));
    if (!dependencies.projectExists(parsed.data.projectId)) return reply.code(404).send({ error: "Project not found" });
    try { const dataset = importDelimitedText(parsed.data.csvText); describeNumericColumns(dataset, parsed.data.numericColumns); const plan = await buildPlan(parsed.data); return { planHash: executionPlanHash(plan), recipe: plan.recipe, input: { rows: dataset.rows.length, columns: dataset.columns, sha256: plan.inputSelectors.csvSha256 }, resources: plan.resources, network: plan.network, disclosure: ["输入和输出进入项目 Artifact Registry", "执行不访问网络", "相同幂等键不会重复执行"] }; }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.post("/api/v1/tabular/runs", async (request, reply) => {
    const parsed = runSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send(validationFailure(parsed.error));
    if (!dependencies.projectExists(parsed.data.projectId)) return reply.code(404).send({ error: "Project not found" });
    try {
      const plan = await buildPlan(parsed.data); const planHash = executionPlanHash(plan);
      if (planHash !== parsed.data.approvedPlanHash) return reply.code(409).send({ error: "Approved plan hash does not match the current input or recipe" });
      const existing = dependencies.executions.getByKey(parsed.data.projectId, parsed.data.idempotencyKey);
      if (existing) return existing.specHash ? existing : reply.code(409).send({ error: "Invalid execution receipt" });
      const input = await dependencies.artifacts.put({ projectId: parsed.data.projectId, name: "experiment.csv", mimeType: "text/csv", kind: "tabular-dataset", data: Buffer.from(parsed.data.csvText) });
      const spec = materializeExecution(plan, [{ name: "dataset", uri: input.uri, sha256: input.sha256 }]);
      const record = await dependencies.executions.run(spec, { id: `approval-${randomUUID()}`, projectId: parsed.data.projectId, planHash, approvedAt: new Date().toISOString() }, parsed.data.idempotencyKey);
      return reply.code(record.status === "succeeded" ? 200 : 409).send(record);
    } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
}

export function createTabularExecutionRunner(artifacts: ArtifactRegistry): ExecutionRunner {
  return { execute: async (spec, signal) => {
    const startedAt = new Date().toISOString(); if (signal.aborted) throw new Error("execution cancelled");
    const input = spec.inputs.find((item) => item.name === "dataset"); if (!input) throw new Error("Tabular execution requires a dataset input");
    const content = await artifacts.read(spec.projectId, input.uri, 0, 4 * 1024 * 1024); const dataset = importDelimitedText(Buffer.from(content.data).toString("utf8"));
    const columns = spec.parameters.numericColumns; if (!Array.isArray(columns) || !columns.every((item) => typeof item === "string")) throw new Error("Tabular numericColumns parameter is invalid");
    const summary = describeNumericColumns(dataset, columns); const output = await artifacts.put({ projectId: spec.projectId, name: "statistical-summary.json", mimeType: "application/vnd.xiling.statistical-summary+json", kind: "statistical-summary", data: Buffer.from(`${JSON.stringify({ recipe: spec.recipe, input: input.uri, summary }, null, 2)}\n`) });
    const finishedAt = new Date().toISOString(); return { outputs: [{ name: output.name, path: output.name, mimeType: output.mimeType, kind: output.kind, artifactUri: output.uri }], exitCode: 0, startedAt, finishedAt, environmentDigest: spec.environment.imageDigest };
  } };
}
