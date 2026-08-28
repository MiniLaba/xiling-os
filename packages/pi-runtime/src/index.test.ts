import { describe, expect, it } from "vitest";
import { LazySkillCatalog, PiRuntimeAdapter, ModelRuntimeStore, TokenLedger, createLiveRoute, createOfflineErrorRoute, createOfflineRoute, createProviderRoute, listRecommendedModels } from "./index.js";
import { createOfflineStream } from "./mock-stream.js";
import type { Model, Provider, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("PiRuntimeAdapter", () => {
  it("maps Pi lifecycle and streaming deltas into transport-neutral events", async () => {
    const runtime = new PiRuntimeAdapter({
      sessionId: "s1",
      systemPrompt: "fixture",
      route: createOfflineRoute(["海洋", "科研"]),
    });
    const events: string[] = [];
    let text = "";
    runtime.subscribe((event) => {
      events.push(event.type);
      if (event.type === "message.delta") text += event.delta;
    });

    await runtime.prompt("分析海温");

    expect(text).toBe("海洋科研");
    expect(events).toContain("session.started");
    expect(events).toContain("session.finished");
  });

  it("refuses to mutate active tools during a turn", async () => {
    const runtime = new PiRuntimeAdapter({
      sessionId: "s2",
      systemPrompt: "fixture",
      route: createOfflineRoute(),
    });
    const running = runtime.prompt("run");
    expect(() => runtime.setActiveTools([])).toThrow("between Pi turns");
    await running;
  });

  it("surfaces provider protocol failures instead of reporting an empty success", async () => {
    const runtime = new PiRuntimeAdapter({ sessionId: "failure", systemPrompt: "fixture", route: createOfflineErrorRoute("unknown model") });
    const events: Array<{ type: string; message?: string }> = [];
    runtime.subscribe((event) => { events.push(event); });
    await runtime.prompt("run");
    expect(events).toContainEqual(expect.objectContaining({ type: "session.error", message: "unknown model" }));
    expect(events.some((event) => event.type === "session.finished")).toBe(false);
  });

  it("exposes a bounded Pi-owned model catalog and accepts future model ids", () => {
    const models = listRecommendedModels();
    expect(models.length).toBeGreaterThanOrEqual(16);
    const perProvider = new Map<string, string[]>();
    for (const model of models) perProvider.set(model.providerId, [...(perProvider.get(model.providerId) ?? []), model.id]);
    expect(new Set(perProvider.keys())).toEqual(new Set(["openai", "anthropic", "google", "openrouter", "deepseek", "xai", "mistral", "moonshotai", "zai", "groq"]));
    for (const ids of perProvider.values()) {
      expect(ids.length).toBeLessThanOrEqual(24);
      expect(ids.some((id) => id.endsWith(":batch"))).toBe(false);
    }
    expect(perProvider.get("openai")!.length).toBeGreaterThan(2);
    expect(() => createLiveRoute(models[0]!.providerId, models[0]!.id, "")).toThrow("credential");
    expect(createLiveRoute("openai", "future-model-id", "fixture-key").modelId).toBe("future-model-id");
  });

  it("injects a credential only into the selected provider request", async () => {
    const model = { id: "fixture", name: "Fixture", provider: "fixture", api: "openai-responses", baseUrl: "https://invalid.local", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000, maxTokens: 100 } as Model<any>;
    let captured: SimpleStreamOptions | undefined;
    const offline = createOfflineStream(["ok"]);
    const provider = { id: "fixture", name: "Fixture", auth: {} as Provider["auth"], getModels: () => [model], stream: () => { throw new Error("unused"); }, streamSimple: (_model, context, options) => { captured = options; return offline(model, context, options); } } as Provider;
    const route = createProviderRoute(provider, model.id, "fixture-secret");
    const runtime = new PiRuntimeAdapter({ sessionId: "provider-route", systemPrompt: "fixture", route });
    await runtime.prompt("probe");
    expect(captured).toMatchObject({ apiKey: "fixture-secret", maxRetries: 2, maxRetryDelayMs: 10_000, timeoutMs: 120_000 });
  });

  it("passes native image content to Pi without converting it to text", async () => {
    const model = { id: "vision-fixture", name: "Vision Fixture", provider: "fixture", api: "openai-responses", baseUrl: "https://invalid.local", reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000, maxTokens: 100 } as Model<any>;
    let capturedContent: unknown;
    const offline = createOfflineStream(["ok"]);
    const provider = { id: "fixture", name: "Fixture", auth: {} as Provider["auth"], getModels: () => [model], stream: () => { throw new Error("unused"); }, streamSimple: (_model, context, options) => { capturedContent = context.messages.at(-1)?.content; return offline(model, context, options); } } as Provider;
    const runtime = new PiRuntimeAdapter({ sessionId: "native-image", systemPrompt: "fixture", route: createProviderRoute(provider, model.id, "fixture-secret") });

    await runtime.prompt("解释图像", [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }]);

    expect(capturedContent).toEqual([{ type: "text", text: "解释图像" }, { type: "image", data: "aW1hZ2U=", mimeType: "image/png" }]);
  });

  it("persists offline-by-default model routing and validates live selection", async () => {
    const root = await mkdtemp(join(tmpdir(), "xiling-model-route-"));
    const path = join(root, "runtime.json");
    const first = new ModelRuntimeStore(path, () => new Date("2026-08-23T01:00:00.000Z"));
    await first.initialize();
    expect(first.get()).toMatchObject({ mode: "offline", reasoning: "medium" });
    const selected = listRecommendedModels()[0]!;
    await first.set({ mode: "live", reasoning: "low", providerId: selected.providerId, modelId: selected.id });
    const restored = new ModelRuntimeStore(path);
    await restored.initialize();
    expect(restored.get()).toMatchObject({ mode: "live", reasoning: "low", providerId: selected.providerId, modelId: selected.id });
    await restored.set({ mode: "live", reasoning: "medium", providerId: "openrouter", modelId: "vendor/new-model-preview" });
    expect(restored.get()).toMatchObject({ providerId: "openrouter", modelId: "vendor/new-model-preview" });
    await expect(restored.set({ mode: "live", reasoning: "medium" })).rejects.toThrow("requires a selected model");
  });

  it("persists only verified native image capability metadata for a directory-external model", async () => {
    const root = await mkdtemp(join(tmpdir(), "xiling-model-native-capability-"));
    const path = join(root, "runtime.json");
    const store = new ModelRuntimeStore(path, () => new Date("2026-08-25T01:00:00.000Z"));
    await store.initialize();
    await expect(store.set({ mode: "live", reasoning: "medium", providerId: "openrouter", modelId: "vendor/vision-preview", inputModalities: ["text", "image"] })).rejects.toThrow("requires verified model capabilities");
    await store.set({ mode: "live", reasoning: "medium", providerId: "openrouter", modelId: "vendor/vision-preview", inputModalities: ["text", "image"], capabilitySource: "native-probe", capabilitiesVerifiedAt: "2026-08-25T00:59:00.000Z" });
    const restored = new ModelRuntimeStore(path);
    await restored.initialize();
    expect(restored.get()).toMatchObject({ inputModalities: ["text", "image"], capabilitySource: "native-probe", capabilitiesVerifiedAt: "2026-08-25T00:59:00.000Z" });
  });

  it("persists provider usage as an append-only token ledger", async () => {
    const root = await mkdtemp(join(tmpdir(), "xiling-token-ledger-"));
    const ledger = new TokenLedger(join(root, "tokens.jsonl"), () => new Date("2026-08-23T02:00:00.000Z"));
    await ledger.record({ sessionId: "s1", providerId: "openrouter", modelId: "fixture", inputTokens: 20, outputTokens: 5, cacheReadTokens: 12, cacheWriteTokens: 0, totalTokens: 25, cost: 0.001, contextEstimatedTokens: 100, contextAvailableTokens: 1_000, contextCacheHit: true });
    expect(await ledger.list()).toMatchObject([{ sessionId: "s1", inputTokens: 20, cacheReadTokens: 12, createdAt: "2026-08-23T02:00:00.000Z" }]);
    expect(await ledger.summarize()).toMatchObject({ entries: 1, totalTokens: 25, cacheHitEntries: 1, contextAssemblyCacheHits: 1, averageEstimatedContextTokens: 100 });
  });

  it("loads only matched Skill bodies and caches them by version", async () => {
    const root = await mkdtemp(join(tmpdir(), "xiling-skill-catalog-"));
    await mkdir(join(root, "ocean-data"));
    await mkdir(join(root, "literature"));
    await writeFile(join(root, "catalog.json"), JSON.stringify([
      { name: "ocean-data", description: "ocean", version: "1", path: "ocean-data", keywords: ["argo"], capabilityIds: ["ocean.plan"] },
      { name: "literature", description: "paper", version: "1", path: "literature", keywords: ["论文"], capabilityIds: ["literature.search"] },
    ]));
    await writeFile(join(root, "ocean-data", "SKILL.md"), "---\nname: ocean-data\ndescription: Plan Argo subsets.\n---\n\nOnly plan approved subsets.\n");
    await writeFile(join(root, "literature", "SKILL.md"), "---\nname: literature\ndescription: Search papers.\n---\n\nKeep citations.\n");
    const catalog = new LazySkillCatalog(root);
    await catalog.initialize();
    const first = await catalog.activate("规划 Argo", ["ocean.plan"]);
    expect(first.skills.map((skill) => skill.name)).toEqual(["ocean-data"]);
    expect(first.prompt).toContain("Only plan approved subsets");
    expect(first.prompt).toContain("skill://ocean-data@1");
    expect(first.prompt).not.toContain(root);
    expect(first.prompt).not.toContain("Keep citations");
    expect(first.loadedCount).toBe(1);
    const second = await catalog.activate("规划 Argo", ["ocean.plan"]);
    expect(second.cacheHits).toBe(1);
    expect(second.loadedCount).toBe(0);
  });
});

export { createOfflineStream } from "./mock-stream.js";
