import { Agent, loadSkills, type AgentEvent, type AgentMessage, type AgentTool, type Skill, type StreamFn } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { ImageContent, Model, Provider, Usage } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { mistralProvider } from "@earendil-works/pi-ai/providers/mistral";
import { moonshotaiProvider } from "@earendil-works/pi-ai/providers/moonshotai";
import { zaiProvider } from "@earendil-works/pi-ai/providers/zai";
import { groqProvider } from "@earendil-works/pi-ai/providers/groq";
import type { AgentStreamEvent, ModelCatalogEntry, ModelProviderId, ModelRouteSettings, ModelRuntimeSettings, TokenLedgerEntry } from "@xiling/contracts";
import { appendFile, mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { createErrorStream, createOfflineStream } from "./mock-stream.js";

export { PiMcpGatewayManager, XILING_MCP_ADAPTER_VERSION } from "./mcp-host.js";
export type { PiMcpHostConfig, PiMcpServerDefinition } from "./mcp-host.js";

export const PI_COMPATIBILITY_BASELINE = {
  agentCore: "0.84.2",
  ai: "0.84.2",
  codingAgent: "0.84.2",
  mcpAdapter: "2.27.0",
  sessionFormat: 4,
} as const;

export interface RuntimeHistoryMessage {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  images?: ImageContent[];
}

export interface RuntimeToolResult<TDetails = unknown> {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  details?: TDetails;
  isError?: boolean;
}

export type RuntimeToolUpdateCallback<TDetails = unknown> = (update: RuntimeToolResult<TDetails>) => void | Promise<void>;

export interface RuntimeTool<TParameters = unknown, TDetails = unknown> {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute(
    toolCallId: string,
    parameters: TParameters,
    signal?: AbortSignal,
    onUpdate?: RuntimeToolUpdateCallback<TDetails>,
  ): Promise<RuntimeToolResult<TDetails>>;
}

const routeBinding: unique symbol = Symbol("xiling.pi.route");

export interface RuntimeModelRoute {
  providerId: string;
  modelId: string;
  contextWindow: number;
  maxOutputTokens: number;
  [routeBinding]: { model: Model<any>; streamFn: StreamFn };
}

export interface PiCompatibilityPort {
  readonly sessionId: string;
  subscribe(listener: RuntimeListener): () => void;
  setActiveTools(tools: RuntimeTool<any, any>[]): void;
  prompt(text: string, images?: ImageContent[]): Promise<void>;
  abort(): void;
  resume(): Promise<void>;
}

export interface PiRuntimeOptions {
  sessionId: string;
  systemPrompt: string;
  route?: RuntimeModelRoute;
  reasoning?: "off" | "low" | "medium" | "high";
  contextPolicy?: "deduplicate-adjacent";
  initialMessages?: RuntimeHistoryMessage[];
  onUsage?: (usage: Usage) => void | Promise<void>;
}

export type RuntimeListener = (event: AgentStreamEvent) => void | Promise<void>;

function mapEvent(sessionId: string, event: AgentEvent): AgentStreamEvent | undefined {
  switch (event.type) {
    case "agent_start":
      return { type: "session.started", sessionId };
    case "message_update":
      if (event.assistantMessageEvent.type === "text_delta") {
        return { type: "message.delta", delta: event.assistantMessageEvent.delta };
      }
      if (event.assistantMessageEvent.type === "error") {
        return { type: "session.error", sessionId, message: event.assistantMessageEvent.error.errorMessage ?? "模型调用失败" };
      }
      return undefined;
    case "tool_execution_start":
      return {
        type: "tool.started",
        toolName: event.toolName,
        callId: event.toolCallId,
        ...(event.args === undefined ? {} : { arguments: event.args }),
      };
    case "tool_execution_end":
      return event.isError ? {
        type: "tool.failed",
        toolName: event.toolName,
        callId: event.toolCallId,
        message: event.result?.content?.find?.((item: { type?: string; text?: string }) => item.type === "text")?.text ?? "Tool execution failed",
        ...(event.result?.details === undefined ? {} : { details: event.result.details }),
      } : {
        type: "tool.finished",
        toolName: event.toolName,
        callId: event.toolCallId,
        ...(event.result?.details === undefined ? {} : { details: event.result.details }),
      };
    case "agent_end": {
      const assistant = [...event.messages].reverse().find((message) => message.role === "assistant") as { stopReason?: string; errorMessage?: string; content?: Array<{ type: string; text?: string }> } | undefined;
      if (assistant?.stopReason === "error" || assistant?.stopReason === "aborted") {
        return { type: "session.error", sessionId, message: assistant.errorMessage ?? (assistant.stopReason === "aborted" ? "模型调用已取消" : "模型调用失败") };
      }
      const hasText = assistant?.content?.some((item) => item.type === "text" && Boolean(item.text?.trim()));
      return hasText ? { type: "session.finished", sessionId, stopReason: assistant?.stopReason ?? "stop" } : { type: "session.error", sessionId, message: "模型未返回文本内容；请检查模型 ID 与输出模态" };
    }
    default:
      return undefined;
  }
}

function toPiMessage(message: RuntimeHistoryMessage, model: Model<any> | undefined): AgentMessage {
  if (message.role === "user") return { role: "user", content: message.images?.length ? [{ type: "text", text: message.text }, ...message.images] : message.text, timestamp: message.timestamp };
  if (!model) return { role: "user", content: `此前汐灵回答：${message.text}`, timestamp: message.timestamp };
  return {
    role: "assistant",
    content: [{ type: "text", text: message.text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: message.timestamp,
  };
}

function deduplicateAdjacentMessages(messages: AgentMessage[]): AgentMessage[] {
  const result: AgentMessage[] = [];
  let previousSignature = "";
  for (const message of messages) {
    const candidate = message as AgentMessage & { role?: string; content?: unknown; toolCallId?: string };
    const signature = JSON.stringify({ role: candidate.role, content: candidate.content, toolCallId: candidate.toolCallId });
    if (signature === previousSignature) continue;
    result.push(message);
    previousSignature = signature;
  }
  return result;
}

export class PiRuntimeAdapter implements PiCompatibilityPort {
  readonly sessionId: string;
  private readonly agent: Agent;
  private readonly listeners = new Set<RuntimeListener>();
  private running = false;

  constructor(options: PiRuntimeOptions) {
    this.sessionId = options.sessionId;
    const binding = options.route?.[routeBinding];
    this.agent = new Agent({
      streamFn: binding?.streamFn ?? createOfflineStream(),
      sessionId: options.sessionId,
      initialState: {
        systemPrompt: options.systemPrompt,
        tools: [],
        messages: (options.initialMessages ?? []).map((message) => toPiMessage(message, binding?.model)),
        ...(binding ? { model: binding.model } : {}),
        ...(options.reasoning ? { thinkingLevel: options.reasoning } : {}),
      },
      ...(options.contextPolicy === "deduplicate-adjacent" ? { transformContext: async (messages: AgentMessage[]) => deduplicateAdjacentMessages(messages) } : {}),
    });
    this.agent.subscribe(async (event) => {
      if (event.type === "message_end" && event.message.role === "assistant" && options.onUsage) {
        const assistant = event.message as { usage?: Usage };
        if (assistant.usage) await options.onUsage(assistant.usage);
      }
      const mapped = mapEvent(this.sessionId, event);
      if (!mapped) return;
      for (const listener of this.listeners) await listener(mapped);
    });
  }

  subscribe(listener: RuntimeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setActiveTools(tools: RuntimeTool<any, any>[]): void {
    if (this.running) {
      throw new Error("Active tools can only change between Pi turns");
    }
    this.agent.state.tools = tools as AgentTool<any>[];
  }

  async prompt(text: string, images: ImageContent[] = []): Promise<void> {
    if (this.running) throw new Error("Pi runtime already has an active turn");
    this.running = true;
    try {
      await this.agent.prompt(text, images);
    } catch (error) {
      const failure: AgentStreamEvent = {
        type: "session.error",
        sessionId: this.sessionId,
        message: error instanceof Error ? error.message : String(error),
      };
      for (const listener of this.listeners) await listener(failure);
      throw error;
    } finally {
      this.running = false;
    }
  }

  abort(): void {
    this.agent.abort();
  }

  async resume(): Promise<void> {
    if (this.running) throw new Error("Pi runtime already has an active turn");
    this.running = true;
    try { await this.agent.continue(); }
    finally { this.running = false; }
  }
}

export interface SkillCatalogEntry {
  name: string;
  description: string;
  version: string;
  path: string;
  keywords: string[];
  capabilityIds: string[];
}

export interface ActivatedSkills {
  entries: SkillCatalogEntry[];
  skills: Skill[];
  prompt: string;
  diagnostics: Array<{ code: string; message: string; path: string }>;
  cacheHits: number;
  loadedCount: number;
}

/**
 * Host-owned Skill catalog. Only catalog metadata is resident; SKILL.md bodies are
 * loaded through Pi's native loader after a capability match and cached by version.
 */
export class LazySkillCatalog {
  private entries: SkillCatalogEntry[] = [];
  private readonly cache = new Map<string, Skill>();
  private initialized = false;

  constructor(private readonly root: string) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const raw = JSON.parse(await readFile(resolve(this.root, "catalog.json"), "utf8")) as unknown;
    if (!Array.isArray(raw)) throw new Error("Skill catalog must be an array");
    this.entries = raw.map((value) => validateSkillCatalogEntry(value));
    this.initialized = true;
  }

  list(): SkillCatalogEntry[] {
    if (!this.initialized) throw new Error("Skill catalog is not initialized");
    return structuredClone(this.entries);
  }

  async activate(query: string, capabilityIds: string[]): Promise<ActivatedSkills> {
    await this.initialize();
    const normalized = query.toLocaleLowerCase();
    const capabilities = new Set(capabilityIds);
    const entries = this.entries.filter((entry) => entry.capabilityIds.some((id) => capabilities.has(id)) || entry.keywords.some((keyword) => normalized.includes(keyword.toLocaleLowerCase())));
    const skills: Skill[] = [];
    const diagnostics: ActivatedSkills["diagnostics"] = [];
    let cacheHits = 0;
    let loadedCount = 0;
    for (const entry of entries) {
      const cacheKey = `${entry.name}@${entry.version}`;
      const cached = this.cache.get(cacheKey);
      if (cached) {
        cacheHits += 1;
        skills.push(cached);
        continue;
      }
      const directory = resolve(this.root, entry.path);
      const rootPrefix = this.root.endsWith(sep) ? this.root : `${this.root}${sep}`;
      if (!directory.startsWith(rootPrefix)) throw new Error(`Skill path escapes catalog root: ${entry.path}`);
      const loaded = await loadSkills(new NodeExecutionEnv({ cwd: this.root }), directory);
      diagnostics.push(...loaded.diagnostics.map(({ code, message, path }) => ({ code, message, path })));
      const skill = loaded.skills.find((candidate) => candidate.name === entry.name);
      if (!skill) {
        diagnostics.push({ code: "skill_not_loaded", message: `Skill ${entry.name} could not be loaded`, path: directory });
        continue;
      }
      this.cache.set(cacheKey, skill);
      skills.push(skill);
      loadedCount += 1;
    }
    const entryByName = new Map(entries.map((entry) => [entry.name, entry]));
    const prompt = skills.map((skill) => {
      const entry = entryByName.get(skill.name);
      const version = entry?.version ?? "unknown";
      return `<skill name="${escapeXml(skill.name)}" version="${escapeXml(version)}" location="skill://${escapeXml(skill.name)}@${escapeXml(version)}">\n${skill.content}\n</skill>`;
    }).join("\n\n");
    return { entries, skills, prompt, diagnostics, cacheHits, loadedCount };
  }
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;" })[character]!);
}

function validateSkillCatalogEntry(value: unknown): SkillCatalogEntry {
  if (!value || typeof value !== "object") throw new Error("Invalid Skill catalog entry");
  const candidate = value as Record<string, unknown>;
  const strings = (key: string) => Array.isArray(candidate[key]) && (candidate[key] as unknown[]).every((item) => typeof item === "string") ? candidate[key] as string[] : undefined;
  if (!["name", "description", "version", "path"].every((key) => typeof candidate[key] === "string") || !strings("keywords") || !strings("capabilityIds")) throw new Error("Invalid Skill catalog metadata");
  return { name: candidate.name as string, description: candidate.description as string, version: candidate.version as string, path: candidate.path as string, keywords: strings("keywords")!, capabilityIds: strings("capabilityIds")! };
}

const TOKEN_LEDGER_ROTATE_BYTES = 8 * 1024 * 1024;
const TOKEN_LEDGER_ENTRY_WINDOW_BYTES = 2_048;

export class TokenLedger {
  constructor(private readonly path: string, private readonly now: () => Date = () => new Date()) {}

  private async rotateIfNeeded(): Promise<void> {
    try {
      const stats = await stat(this.path);
      if (stats.size < TOKEN_LEDGER_ROTATE_BYTES) return;
      // One retained generation; metrics cover the current one only.
      await rename(this.path, `${this.path}.1`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  async record(input: Omit<TokenLedgerEntry, "id" | "createdAt">): Promise<TokenLedgerEntry> {
    await this.rotateIfNeeded();
    const entry: TokenLedgerEntry = { id: randomUUID(), createdAt: this.now().toISOString(), ...input };
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
    return entry;
  }

  private async parseTail(limit: number): Promise<TokenLedgerEntry[]> {
    try {
      // Ledger lines are small structured metrics; reading a bounded tail window
      // keeps both `list` and `summarize` O(limit) instead of O(file size).
      const handle = await open(this.path, "r");
      let text: string;
      try {
        const stats = await handle.stat();
        const start = Math.max(0, stats.size - limit * TOKEN_LEDGER_ENTRY_WINDOW_BYTES);
        const buffer = Buffer.alloc(stats.size - start);
        await handle.read(buffer, 0, buffer.length, start);
        text = buffer.toString("utf8");
      } finally { await handle.close(); }
      let lines = text.split("\n").filter(Boolean);
      if (lines.length && !text.endsWith("\n")) lines = lines.slice(1);
      if (lines.length < limit) lines = (await readFile(this.path, "utf8")).split("\n").filter(Boolean);
      return lines.slice(-limit).map((line) => JSON.parse(line) as TokenLedgerEntry);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }

  async list(limit = 100): Promise<TokenLedgerEntry[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("invalid token ledger limit");
    return this.parseTail(limit);
  }

  async summarize(limit = 1_000): Promise<{
    entries: number;
    totalTokens: number;
    cacheReadTokens: number;
    cacheHitEntries: number;
    contextAssemblyCacheHits: number;
    averageEstimatedContextTokens: number;
    averageContextUtilization: number;
    omittedHistoryEntries: number;
    averageSourceCoverage: number;
    deduplicatedHistoryEntries: number;
  }> {
    const entries = await this.list(limit);
    const withEstimate = entries.filter((entry) => entry.contextEstimatedTokens !== undefined && entry.contextAvailableTokens !== undefined);
    const utilization = withEstimate.reduce((total, entry) => total + (entry.contextAvailableTokens ? (entry.contextEstimatedTokens ?? 0) / entry.contextAvailableTokens : 0), 0);
    return {
      entries: entries.length,
      totalTokens: entries.reduce((total, entry) => total + entry.totalTokens, 0),
      cacheReadTokens: entries.reduce((total, entry) => total + entry.cacheReadTokens, 0),
      cacheHitEntries: entries.filter((entry) => entry.cacheReadTokens > 0).length,
      contextAssemblyCacheHits: entries.filter((entry) => entry.contextCacheHit).length,
      averageEstimatedContextTokens: withEstimate.length ? Math.round(withEstimate.reduce((total, entry) => total + (entry.contextEstimatedTokens ?? 0), 0) / withEstimate.length) : 0,
      averageContextUtilization: withEstimate.length ? utilization / withEstimate.length : 0,
      omittedHistoryEntries: entries.filter((entry) => (entry.omittedHistoryCount ?? 0) > 0).length,
      averageSourceCoverage: entries.length ? entries.reduce((total, entry) => total + (entry.contextSourceCoverage ?? 1), 0) / entries.length : 1,
      deduplicatedHistoryEntries: entries.reduce((total, entry) => total + (entry.contextDuplicateHistoryCount ?? 0), 0),
    };
  }
}

const providerFactories = {
  openai: openaiProvider,
  anthropic: anthropicProvider,
  google: googleProvider,
  openrouter: openrouterProvider,
  deepseek: deepseekProvider,
  xai: xaiProvider,
  mistral: mistralProvider,
  moonshotai: moonshotaiProvider,
  zai: zaiProvider,
  groq: groqProvider,
} as const;

const preferredModels: Record<ModelProviderId, string[]> = {
  openai: ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.5", "gpt-5.4"],
  anthropic: ["claude-sonnet-5", "claude-opus-5", "claude-sonnet-4-6", "claude-opus-4-8", "claude-haiku-4-5"],
  google: ["gemini-3.7-flash", "gemini-3.5-pro", "gemini-pro-latest", "gemini-flash-latest", "gemini-3.5-flash-lite"],
  // 区域可用性优先：连接测试与默认推荐取列表首项，DeepSeek/Kimi 在受限区域可直连，西方模型部分有区域限制
  openrouter: ["~deepseek/deepseek-v4-flash-latest", "~moonshotai/kimi-latest", "~anthropic/claude-sonnet-latest", "~google/gemini-pro-latest", "~google/gemini-flash-latest", "~openai/gpt-latest", "~openai/gpt-mini-latest"],
  deepseek: ["deepseek-v4-flash", "deepseek-v4-pro"],
  xai: ["grok-4.6", "grok-4.5"],
  mistral: ["mistral-large-latest", "mistral-small-latest"],
  moonshotai: ["kimi-k2.5", "kimi-k2-thinking"],
  zai: ["glm-5", "glm-4.7"],
  groq: ["openai/gpt-oss-120b", "llama-3.3-70b-versatile"],
  custom: [],
};

function describeModel(providerId: ModelProviderId, model: Model<any>): ModelCatalogEntry {
  return { providerId, id: model.id, name: model.name, contextWindow: model.contextWindow, maxOutputTokens: model.maxTokens, reasoning: model.reasoning, inputModalities: model.input.filter((item): item is "text" | "image" => item === "text" || item === "image"), outputModalities: ["text"] };
}

function resolveProviderModel(provider: Provider, modelId: string): Model<any> {
  const known = provider.getModels().find((item) => item.id === modelId);
  if (known) return known;
  const template = provider.getModels().find((item) => item.input.includes("text"));
  if (!template) throw new Error(`provider has no text model template: ${provider.id}`);
  return {
    ...template,
    id: modelId,
    name: modelId,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

export function resolveModelCatalogEntry(providerId: ModelProviderId, modelId: string): ModelCatalogEntry {
  if (providerId === "custom") return { providerId, id: modelId, name: modelId, contextWindow: 128_000, maxOutputTokens: 8_192, reasoning: false, inputModalities: ["text"], outputModalities: ["text"] };
  const model = resolveProviderModel(providerFactories[providerId]() as Provider, modelId);
  return describeModel(providerId, model);
}

export function findKnownModelCatalogEntry(providerId: ModelProviderId, modelId: string): ModelCatalogEntry | undefined {
  if (providerId === "custom") return undefined;
  const known = (providerFactories[providerId]() as Provider).getModels().find((model) => model.id === modelId);
  return known ? describeModel(providerId, known) : undefined;
}

export function listRecommendedModels(): ModelCatalogEntry[] {
  return (Object.keys(providerFactories) as Exclude<ModelProviderId, "custom">[]).flatMap((providerId) => {
    const provider = providerFactories[providerId]();
    const models = new Map(provider.getModels().map((model) => [model.id, model]));
    const preferred = preferredModels[providerId].map((id) => models.get(id)).filter((model): model is Model<any> => Boolean(model));
    const fallback = provider.getModels().filter((model) => model.input.includes("text") && !/realtime|audio|image/i.test(model.id) && !model.id.endsWith(":batch"));
    return [...new Map([...preferred, ...fallback].map((model) => [model.id, model])).values()].slice(0, 24).map((model) => describeModel(providerId, model));
  });
}

export interface CustomProviderRouteConfig { baseUrl: string; apiStyle: "openai-completions" | "openai-responses"; displayName?: string }

function runtimeRoute(model: Model<any>, streamFn: StreamFn): RuntimeModelRoute {
  return {
    providerId: model.provider,
    modelId: model.id,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxTokens,
    [routeBinding]: { model, streamFn },
  };
}

const offlineFixtureModel: Model<"openai-responses"> = {
  id: "xiling-offline",
  name: "XiLing Offline Fixture",
  api: "openai-responses",
  provider: "xiling-offline",
  baseUrl: "https://invalid.local",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
};

export function createOfflineRoute(chunks?: string[]): RuntimeModelRoute {
  return runtimeRoute(offlineFixtureModel, createOfflineStream(chunks));
}

export function createOfflineErrorRoute(message?: string): RuntimeModelRoute {
  return runtimeRoute(offlineFixtureModel, createErrorStream(message));
}

export function createLiveRoute(providerId: ModelProviderId, modelId: string, apiKey: string, custom?: CustomProviderRouteConfig, inputModalities?: Array<"text" | "image">): RuntimeModelRoute {
  if (providerId === "custom") {
    if (!custom) throw new Error("custom provider configuration is required");
    const templateProvider = custom.apiStyle === "openai-responses" ? openaiProvider() : deepseekProvider();
    const template = resolveProviderModel(templateProvider as Provider, modelId);
    const model = { ...template, id: modelId, name: custom.displayName ? `${custom.displayName} · ${modelId}` : modelId, provider: "custom", api: custom.apiStyle, baseUrl: custom.baseUrl, ...(inputModalities ? { input: inputModalities } : {}) } as Model<any>;
    return createProviderRoute({ ...(templateProvider as Provider), getModels: () => [model] } as Provider, modelId, apiKey, model);
  }
  const provider = providerFactories[providerId]() as Provider;
  const resolved = resolveProviderModel(provider, modelId);
  const model = inputModalities ? { ...resolved, input: inputModalities } as Model<any> : resolved;
  return createProviderRoute(provider, modelId, apiKey, model);
}

export function createProviderRoute(provider: Provider, modelId: string, apiKey: string, suppliedModel?: Model<any>): RuntimeModelRoute {
  if (!apiKey) throw new Error("model credential is required");
  const model = suppliedModel ?? resolveProviderModel(provider, modelId);
  const streamFn: StreamFn = (_model, context, options) => provider.streamSimple(model, context, {
    ...options,
    apiKey,
    maxRetries: 2,
    maxRetryDelayMs: 10_000,
    timeoutMs: 120_000,
  });
  return runtimeRoute(model, streamFn);
}

const defaultSettings = (): ModelRuntimeSettings => ({ roleRoutes: {}, updatedAt: new Date(0).toISOString() });

export class ModelRuntimeStore {
  private value = defaultSettings();
  constructor(private readonly path: string, private readonly now: () => Date = () => new Date()) {}

  async initialize(): Promise<void> {
    try { this.value = this.validate(JSON.parse(await readFile(this.path, "utf8")) as unknown); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  get(): ModelRuntimeSettings { return structuredClone(this.value); }

  async set(input: Omit<ModelRuntimeSettings, "updatedAt">): Promise<ModelRuntimeSettings> {
    const value = this.validate({ ...input, updatedAt: this.now().toISOString() }, true);
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporary, this.path);
    this.value = value;
    return this.get();
  }

  private validateRoute(value: unknown): ModelRouteSettings {
    if (!value || typeof value !== "object") throw new Error("invalid model route");
    const candidate = value as Partial<ModelRouteSettings>;
    const providerIds: ModelProviderId[] = ["openai", "anthropic", "google", "openrouter", "deepseek", "xai", "mistral", "moonshotai", "zai", "groq", "custom"];
    if (!candidate.providerId || !providerIds.includes(candidate.providerId)) throw new Error("invalid model provider");
    if (typeof candidate.modelId !== "string" || !candidate.modelId.trim() || candidate.modelId.length > 240) throw new Error("invalid model id");
    if (!(["off", "low", "medium", "high"] as const).includes(candidate.reasoning as ModelRouteSettings["reasoning"])) throw new Error("invalid reasoning level");
    const inputModalities = candidate.inputModalities;
    if (inputModalities && (!Array.isArray(inputModalities) || !inputModalities.length || inputModalities.some((item) => item !== "text" && item !== "image") || !inputModalities.includes("text"))) throw new Error("invalid native input modalities");
    if (candidate.capabilitySource !== undefined && candidate.capabilitySource !== "pi-catalog" && candidate.capabilitySource !== "native-probe") throw new Error("invalid capability source");
    if (candidate.capabilitiesVerifiedAt !== undefined && (typeof candidate.capabilitiesVerifiedAt !== "string" || Number.isNaN(Date.parse(candidate.capabilitiesVerifiedAt)))) throw new Error("invalid capability verification timestamp");
    if (inputModalities?.includes("image") && (!candidate.capabilitySource || !candidate.capabilitiesVerifiedAt)) throw new Error("image input requires verified model capabilities");
    return { providerId: candidate.providerId, modelId: candidate.modelId.trim(), reasoning: candidate.reasoning as ModelRouteSettings["reasoning"], ...(inputModalities ? { inputModalities: [...new Set(inputModalities)] } : {}), ...(candidate.capabilitySource ? { capabilitySource: candidate.capabilitySource } : {}), ...(candidate.capabilitiesVerifiedAt ? { capabilitiesVerifiedAt: candidate.capabilitiesVerifiedAt } : {}) };
  }

  private validate(value: unknown, requirePrimary = false): ModelRuntimeSettings {
    if (!value || typeof value !== "object") throw new Error("invalid model runtime settings");
    const candidate = value as Partial<ModelRuntimeSettings> & { mode?: string; providerId?: ModelProviderId; modelId?: string; reasoning?: ModelRouteSettings["reasoning"]; inputModalities?: Array<"text" | "image">; capabilitySource?: ModelRouteSettings["capabilitySource"]; capabilitiesVerifiedAt?: string };
    const migratedPrimary = candidate.primary ?? (candidate.mode === "live" && candidate.providerId && candidate.modelId ? { providerId: candidate.providerId, modelId: candidate.modelId, reasoning: candidate.reasoning ?? "medium", ...(candidate.inputModalities ? { inputModalities: candidate.inputModalities } : {}), ...(candidate.capabilitySource ? { capabilitySource: candidate.capabilitySource } : {}), ...(candidate.capabilitiesVerifiedAt ? { capabilitiesVerifiedAt: candidate.capabilitiesVerifiedAt } : {}) } : undefined);
    if (requirePrimary && !migratedPrimary) throw new Error("primary model route is required");
    if (!candidate.roleRoutes || typeof candidate.roleRoutes !== "object" || Array.isArray(candidate.roleRoutes)) candidate.roleRoutes = {};
    const roleEntries = Object.entries(candidate.roleRoutes);
    if (roleEntries.length > 16 || roleEntries.some(([roleId]) => !roleId || roleId.length > 80)) throw new Error("invalid role routes");
    if (typeof candidate.updatedAt !== "string" || Number.isNaN(Date.parse(candidate.updatedAt))) throw new Error("invalid settings timestamp");
    return { ...(migratedPrimary ? { primary: this.validateRoute(migratedPrimary) } : {}), roleRoutes: Object.fromEntries(roleEntries.map(([roleId, route]) => [roleId, this.validateRoute(route)])), updatedAt: candidate.updatedAt };
  }
}
