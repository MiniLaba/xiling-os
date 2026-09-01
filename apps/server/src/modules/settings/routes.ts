import { validationFailure } from "../../http-errors.js";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { credentialIdSchema, credentialValuesSchema, modelRuntimeSchema, providerTestSchema } from "@xiling/api-contracts";
import type { InstalledSkillsResponse, ModelProviderId, ModelRouteSettings, ModelRouteStatus, ModelRuntimeSettings, ModelRuntimeStatus } from "@xiling/contracts";
import type { CredentialStore } from "@xiling/credentials";
import { PiRuntimeAdapter, createLiveRoute, findKnownModelCatalogEntry, listRecommendedModels, resolveModelCatalogEntry, type CustomProviderRouteConfig, type ModelRuntimeStore } from "@xiling/pi-runtime";

export function humanizeModelFailure(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("guardrail restrictions") || lower.includes("settings/privacy")) return "已连接 OpenRouter，但账户隐私/数据策略没有允许该模型的可用端点；请检查 OpenRouter Privacy 设置或更换模型。";
  if (/\b401\b|unauthorized|invalid api key/.test(lower)) return "认证失败：API Key 无效、已过期或没有访问该模型的权限。";
  if (/\b403\b|not available in your region/.test(lower)) return "该模型在当前区域被限制访问（区域检查发生在密钥校验之前，因此无法据此判断密钥是否有效）；请改用 DeepSeek、Kimi、Qwen 等本区域可用模型重试。";
  if (/\b404\b|model not found|unknown model/.test(lower)) return "服务可达，但模型 ID 不存在或当前账户不可用。";
  if (/\b429\b|rate limit|quota/.test(lower)) return "服务可达，但当前配额不足或请求频率受限。";
  return message.slice(0, 500);
}

export class ModelSettingsService {
  constructor(readonly credentials: CredentialStore, private readonly modelRuntime: ModelRuntimeStore, private readonly credentialsReady: Promise<unknown>, private readonly modelRuntimeReady: Promise<unknown>) {}
  async status(): Promise<ModelRuntimeStatus> {
    await Promise.all([this.credentialsReady, this.modelRuntimeReady]);
    const settings = this.modelRuntime.get();
    const resolveStatus = (route: ModelRouteSettings): ModelRouteStatus => {
      const catalogModel = resolveModelCatalogEntry(route.providerId, route.modelId);
      const selectedModel = route.inputModalities ? { ...catalogModel, inputModalities: route.inputModalities } : catalogModel;
      const credentialConfigured = this.credentials.status(route.providerId).configured;
      return { ...route, selectedModel, credentialConfigured, ready: credentialConfigured, reason: credentialConfigured ? "ready" : "credential_required" };
    };
    const primary = settings.primary ? resolveStatus(settings.primary) : undefined;
    const roleRoutes = Object.fromEntries(Object.entries(settings.roleRoutes).map(([roleId, route]) => [roleId, resolveStatus(route)]));
    const reason = !primary ? "selection_required" : !primary.ready ? "credential_required" : "ready";
    return { ...(primary ? { primary } : {}), roleRoutes, updatedAt: settings.updatedAt, ready: reason === "ready", reason };
  }
  customRouteConfig(): CustomProviderRouteConfig {
    const baseUrl = this.credentials.get("custom", "baseUrl"); const apiStyle = this.credentials.get("custom", "apiStyle");
    if (!baseUrl) throw new Error("自定义 API 缺少 Base URL");
    const parsedUrl = new URL(baseUrl);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") throw new Error("Base URL 必须使用 http 或 https");
    if (apiStyle !== "openai-completions" && apiStyle !== "openai-responses") throw new Error("API 风格必须是 openai-completions 或 openai-responses");
    const displayName = this.credentials.get("custom", "displayName");
    return { baseUrl: parsedUrl.toString().replace(/\/$/, ""), apiStyle, ...(displayName ? { displayName } : {}) };
  }
  async setRuntime(input: Omit<ModelRuntimeSettings, "updatedAt">) {
    await Promise.all([this.credentialsReady, this.modelRuntimeReady]);
    const previous = this.modelRuntime.get();
    const normalizeRoute = async (route: ModelRouteSettings): Promise<ModelRouteSettings> => {
      if (!this.credentials.status(route.providerId).configured) throw new Error(`请先保存 ${route.providerId} 的 API 连接`);
      const requested = [...new Set(route.inputModalities ?? ["text"])] as Array<"text" | "image">;
      let capabilitySource: "pi-catalog" | "native-probe" | undefined;
      let capabilitiesVerifiedAt: string | undefined;
      if (requested.includes("image")) {
        const known = findKnownModelCatalogEntry(route.providerId, route.modelId);
        if (known) {
          if (!known.inputModalities.includes("image")) throw new Error("Pi 模型目录明确标记该模型不支持原生图像输入");
          capabilitySource = "pi-catalog";
          capabilitiesVerifiedAt = new Date().toISOString();
        } else {
          const existing = [previous.primary, ...Object.values(previous.roleRoutes)].find((candidate) => candidate?.providerId === route.providerId && candidate.modelId === route.modelId && candidate.capabilitySource === "native-probe" && candidate.inputModalities?.includes("image") && candidate.capabilitiesVerifiedAt);
          if (existing?.capabilitiesVerifiedAt) {
            capabilitySource = "native-probe";
            capabilitiesVerifiedAt = existing.capabilitiesVerifiedAt;
          } else {
            await this.probeNativeImage(route.providerId, route.modelId);
            capabilitySource = "native-probe";
            capabilitiesVerifiedAt = new Date().toISOString();
          }
        }
      }
      return { providerId: route.providerId, modelId: route.modelId, reasoning: route.reasoning, inputModalities: requested, ...(capabilitySource && capabilitiesVerifiedAt ? { capabilitySource, capabilitiesVerifiedAt } : {}) };
    };
    const primary = await normalizeRoute(input.primary!);
    const roleRoutes = Object.fromEntries(await Promise.all(Object.entries(input.roleRoutes).map(async ([roleId, route]) => [roleId, await normalizeRoute(route)] as const)));
    await this.modelRuntime.set({ primary, roleRoutes });
    return this.status();
  }

  private async probeNativeImage(providerId: ModelProviderId, modelId: string): Promise<void> {
    const apiKey = this.credentials.get(providerId, "apiKey") ?? (providerId === "custom" ? "xiling-local" : undefined);
    if (!apiKey) throw new Error("请先保存所选模型提供商的 API Key");
    const route = createLiveRoute(providerId, modelId, apiKey, providerId === "custom" ? this.customRouteConfig() : undefined, ["text", "image"]);
    let text = ""; let failure = "";
    const runtime = new PiRuntimeAdapter({ sessionId: `native-image-probe-${randomUUID()}`, systemPrompt: "Inspect the attached native image and reply with exactly OK.", route, reasoning: "off" });
    runtime.subscribe((event) => { if (event.type === "message.delta") text += event.delta; if (event.type === "session.error") failure = humanizeModelFailure(event.message); });
    await runtime.prompt("Inspect this attached 1×1 PNG and reply with exactly OK.", [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" }]);
    if (failure || !text.trim()) throw new Error(failure || "模型没有接受原生图像内容块");
  }
}

export function registerSettingsRoutes(app: FastifyInstance, service: ModelSettingsService, credentialsReady: Promise<unknown>, skills?: {
  ready: Promise<unknown>;
  list: () => Array<{ name: string; description: string; version: string; keywords: string[]; capabilityIds: string[] }>;
  capabilities: Array<{ id: string; description: string; toolName: string }>;
}): void {
  const credentials = service.credentials;
  app.get("/api/settings/providers", async () => { await credentialsReady; return credentials.listStatus(); });
  app.put("/api/settings/providers/:id", async (request, reply) => {
    await credentialsReady; const params = credentialIdSchema.safeParse(request.params); const body = credentialValuesSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send(validationFailure(params.error));
    if (!body.success) return reply.code(400).send(validationFailure(body.error));
    try { return await credentials.set(params.data.id, body.data.values); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.delete("/api/settings/providers/:id", async (request, reply) => {
    await credentialsReady; const params = credentialIdSchema.safeParse(request.params);
    return params.success ? credentials.clear(params.data.id) : reply.code(400).send(validationFailure(params.error));
  });
  app.post("/api/settings/providers/:id/test", async (request, reply) => {
    await credentialsReady; const params = credentialIdSchema.safeParse(request.params); const body = providerTestSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid connection test request" });
    const providerId = params.data.id;
    const modelProviders: ModelProviderId[] = ["openai", "anthropic", "google", "openrouter", "deepseek", "xai", "mistral", "moonshotai", "zai", "groq", "custom"];
    if (!modelProviders.includes(providerId as ModelProviderId)) return reply.code(400).send({ error: "该服务暂不支持模型连通测试" });
    const selectedProvider = providerId as ModelProviderId;
    if (!credentials.status(providerId).configured) return reply.code(409).send({ ok: false, message: "请先保存完整连接信息" });
    const modelId = body.data.modelId ?? (selectedProvider === "custom" ? credentials.get("custom", "testModel") : listRecommendedModels().find((item) => item.providerId === selectedProvider)?.id);
    if (!modelId) return reply.code(400).send({ ok: false, message: "缺少用于测试的模型 ID" });
    const started = Date.now(); let text = ""; let failure = "";
    try {
      const apiKey = credentials.get(providerId, "apiKey") ?? (selectedProvider === "custom" ? "xiling-local" : "");
      const route = createLiveRoute(selectedProvider, modelId, apiKey, selectedProvider === "custom" ? service.customRouteConfig() : undefined);
      const runtime = new PiRuntimeAdapter({ sessionId: `connection-test-${randomUUID()}`, systemPrompt: "Reply with exactly OK.", route, reasoning: "off" });
      runtime.subscribe((event) => { if (event.type === "message.delta") text += event.delta; if (event.type === "session.error") failure = humanizeModelFailure(event.message); });
      await runtime.prompt("Reply with exactly OK.");
    } catch (error) { failure = error instanceof Error ? error.message : String(error); }
    const result = { ok: Boolean(text.trim()) && !failure, providerId: selectedProvider, modelId, latencyMs: Date.now() - started, message: failure || `连接成功，模型返回：${text.trim().slice(0, 80)}`, testedAt: new Date().toISOString() };
    return reply.code(result.ok ? 200 : 422).send(result);
  });
  app.get("/api/settings/models", async () => ({ catalog: listRecommendedModels(), runtime: await service.status(), configuredProviderIds: credentials.listStatus().filter((provider) => provider.category === "model" && provider.configured).map((provider) => provider.id) }));
  app.put("/api/settings/models", async (request, reply) => {
    const parsed = modelRuntimeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(validationFailure(parsed.error));
    const normalizeRoute = (route: typeof parsed.data.primary): ModelRouteSettings => ({ providerId: route.providerId, modelId: route.modelId, reasoning: route.reasoning, ...(route.inputModalities ? { inputModalities: route.inputModalities } : {}) });
    try { return await service.setRuntime({ primary: normalizeRoute(parsed.data.primary), roleRoutes: Object.fromEntries(Object.entries(parsed.data.roleRoutes).map(([roleId, route]) => [roleId, normalizeRoute(route)])) }); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.get("/api/settings/skills", async (_request, reply) => {
    if (!skills) return reply.code(503).send({ error: "skill_catalog_unavailable" });
    await skills.ready;
    const capabilities = new Map(skills.capabilities.map((capability) => [capability.id, capability]));
    const response: InstalledSkillsResponse = {
      strategy: "lazy",
      residentMetadata: ["name", "description", "version", "keywords", "capabilities"],
      skills: skills.list().map((skill) => ({
        name: skill.name,
        description: skill.description,
        version: skill.version,
        keywords: skill.keywords,
        capabilities: skill.capabilityIds.flatMap((id) => capabilities.get(id) ? [capabilities.get(id)!] : [{ id, description: "未关联说明", toolName: "未关联工具" }]),
        loading: "on-demand",
      })),
    };
    return response;
  });
}
