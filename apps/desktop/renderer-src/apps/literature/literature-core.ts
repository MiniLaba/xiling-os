// 文献检索与构图核心：自旧版 @xiling/literature 包（providers.ts + index.ts）原样移植。
// 差异只有两处：fetch 经桌面网络代理 IPC（network.access 能力），缓存用 localStorage
// 替代文件缓存（保留 hit/stale 语义与 24h TTL）。构图算法逐行未动。
// 沙箱渲染器无 node:crypto：哈希用确定性 FNV-1a（仅作缓存键/内容指纹，非安全用途）。

import type { LiteratureGraph, LiteratureGraphEdge, LiteratureGraphNode, LiteratureSearchResponse, PaperRecord } from "./contracts.js";

function shaLikeHash(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let index = 0; index < input.length; index += 1) {
    h1 = (h1 ^ input.charCodeAt(index)) * 0x01000193 >>> 0;
    h2 = (h2 + input.charCodeAt(index) * (index + 7)) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}${input.length.toString(16)}`;
}

/** 桌面网桥的网络代理段（全局类型在 window-runtime 中声明，这里只做窄化视图） */
interface NetFetchBridge {
  netFetch?: (payload: { appId: string; url: string; method?: string; headers?: Record<string, string> }) => Promise<{ status: number; headers: Record<string, string>; bodyText: string }>;
}

const APP_ID = "system.literature";

/** 经主进程 net.fetch 代理的 fetch（渲染器 CSP connect-src 'self' 不放行外网）。 */
async function proxiedFetch(url: string | URL, init?: { headers?: Record<string, string>; signal?: AbortSignal }): Promise<Response> {
  if (!init || init.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const bridge = (window as { xilingDesktop?: NetFetchBridge }).xilingDesktop;
  const netFetch = bridge?.netFetch;
  if (!netFetch) throw new Error("网络代理不可用：桌面网桥未就绪");
  const payload: { appId: string; url: string; method: string; headers?: Record<string, string> } = {
    appId: APP_ID,
    url: String(url),
    method: "GET",
  };
  if (init.headers !== undefined) payload.headers = init.headers;
  const result = await netFetch(payload);
  return new Response(result.bodyText, { status: result.status, headers: result.headers });
}

export type LiteratureFetch = typeof proxiedFetch;
export interface LiteratureProvider {
  readonly id: "semantic-scholar" | "openalex";
  search(query: string, limit: number, signal?: AbortSignal): Promise<PaperRecord[]>;
}

export class LiteratureHttpError extends Error {
  constructor(readonly provider: string, readonly status: number, readonly retryAfterMs?: number) { super(`${provider} request failed with ${status}`); }
}

const parseRetryAfter = (value: string | null, now = Date.now()): number | undefined => {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(value); return Number.isNaN(date) ? undefined : Math.max(0, date - now);
};

async function jsonRequest(fetchFn: LiteratureFetch, provider: string, url: URL, headers: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
  const response = await fetchFn(url, { headers, ...(signal ? { signal } : {}) });
  if (!response.ok) throw new LiteratureHttpError(provider, response.status, parseRetryAfter(response.headers.get("retry-after")));
  return response.json() as Promise<unknown>;
}

const text = (value: unknown): string => typeof value === "string" ? value : "";
const integer = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

function abstractFromInvertedIndex(value: unknown): string {
  const positions = Object.entries(record(value)).flatMap(([word, indices]) => array(indices).map((index) => [integer(index), word] as const));
  return positions.sort((left, right) => left[0] - right[0]).map((entry) => entry[1]).join(" ").trim();
}

export class SemanticScholarProvider implements LiteratureProvider {
  readonly id = "semantic-scholar" as const;
  constructor(private readonly fetchFn: LiteratureFetch = proxiedFetch, private readonly apiKey?: string | (() => string | undefined)) {}
  async search(query: string, limit: number, signal?: AbortSignal): Promise<PaperRecord[]> {
    const url = new URL("https://api.semanticscholar.org/graph/v1/paper/search");
    url.searchParams.set("query", query.replaceAll("-", " "));
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("fields", "title,year,authors,citationCount,references.paperId,url,abstract");
    const apiKey = typeof this.apiKey === "function" ? this.apiKey() : this.apiKey;
    const body = record(await jsonRequest(this.fetchFn, this.id, url, apiKey ? { "x-api-key": apiKey } : {}, signal));
    return array(body.data).map((item) => {
      const paper = record(item);
      return {
        id: text(paper.paperId), title: text(paper.title), year: integer(paper.year),
        authors: array(paper.authors).map((author) => text(record(author).name)).filter(Boolean),
        citationCount: integer(paper.citationCount),
        references: array(paper.references).map((reference) => text(record(reference).paperId)).filter(Boolean),
        source: this.id, ...(text(paper.url) ? { url: text(paper.url) } : {}), ...(text(paper.abstract) ? { abstract: text(paper.abstract) } : {}),
      } satisfies PaperRecord;
    }).filter((paper) => paper.id && paper.title);
  }
}

const openAlexId = (value: unknown): string => text(value).replace(/^https:\/\/openalex\.org\//, "");

export class OpenAlexProvider implements LiteratureProvider {
  readonly id = "openalex" as const;
  constructor(private readonly fetchFn: LiteratureFetch = proxiedFetch, private readonly apiKey?: string | (() => string | undefined)) {}
  async search(query: string, limit: number, signal?: AbortSignal): Promise<PaperRecord[]> {
    const url = new URL("https://api.openalex.org/works");
    url.searchParams.set("search", query); url.searchParams.set("per_page", String(limit)); url.searchParams.set("sort", "relevance_score:desc");
    url.searchParams.set("select", "id,display_name,publication_year,authorships,cited_by_count,referenced_works,doi,abstract_inverted_index");
    const apiKey = typeof this.apiKey === "function" ? this.apiKey() : this.apiKey;
    if (apiKey) url.searchParams.set("api_key", apiKey);
    const body = record(await jsonRequest(this.fetchFn, this.id, url, {}, signal));
    return array(body.results).map((item) => {
      const work = record(item);
      const abstract = abstractFromInvertedIndex(work.abstract_inverted_index);
      return {
        id: openAlexId(work.id), title: text(work.display_name), year: integer(work.publication_year),
        authors: array(work.authorships).map((authorship) => text(record(record(authorship).author).display_name)).filter(Boolean),
        citationCount: integer(work.cited_by_count), references: array(work.referenced_works).map(openAlexId).filter(Boolean), source: this.id,
        ...(text(work.doi) ? { url: text(work.doi) } : text(work.id) ? { url: text(work.id) } : {}), ...(abstract ? { abstract } : {}),
      } satisfies PaperRecord;
    }).filter((paper) => paper.id && paper.title);
  }
}

export interface RetryPolicy { attempts?: number; baseDelayMs?: number; maxDelayMs?: number; sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; }
const defaultSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolvePromise, reject) => {
  const timer = setTimeout(resolvePromise, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
});

export async function withLiteratureRetry<T>(operation: () => Promise<T>, policy: RetryPolicy = {}): Promise<{ value: T; attempts: number }> {
  const attempts = Math.min(Math.max(policy.attempts ?? 3, 1), 5); const base = policy.baseDelayMs ?? 300; const cap = policy.maxDelayMs ?? 5_000; const sleep = policy.sleep ?? defaultSleep;
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return { value: await operation(), attempts: attempt }; }
    catch (error) {
      last = error;
      const retryable = error instanceof LiteratureHttpError ? error.status === 429 || error.status >= 500 : error instanceof Error && error.name !== "AbortError";
      if (!retryable || attempt === attempts) throw Object.assign(error instanceof Error ? error : new Error(String(error)), { attempts: attempt });
      const requested = (error instanceof LiteratureHttpError ? error.retryAfterMs : undefined) ?? base * (2 ** (attempt - 1));
      await sleep(Math.min(requested, cap));
    }
  }
  throw last;
}

type CacheFile = { version: 1; expiresAt: string; response: LiteratureSearchResponse };
const CACHE_KEY = "xiling:app.literature-workbench/search-cache/v1";

/** localStorage 版文件缓存（旧 FileLiteratureCache 的渲染器形态，语义一致） */
export class LocalLiteratureCache {
  private readAll(): Record<string, CacheFile> {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) ?? "{}") as Record<string, CacheFile>; } catch { return {}; }
  }
  private writeAll(all: Record<string, CacheFile>): void {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(all)); } catch { /* 容量满时放弃缓存 */ }
  }
  key(query: string, limit: number): string { return shaLikeHash(`${query.trim().toLowerCase()}\n${limit}`); }
  read(key: string): CacheFile | undefined { return this.readAll()[key]; }
  write(key: string, file: CacheFile): void {
    const all = this.readAll();
    all[key] = file;
    this.writeAll(all);
  }
}

export class LiteratureSearchService {
  private readonly inflight = new Map<string, Promise<LiteratureSearchResponse>>();
  constructor(
    private readonly primary: LiteratureProvider,
    private readonly fallback: LiteratureProvider,
    private readonly cache: LocalLiteratureCache,
    private readonly options: { ttlMs?: number; now?: () => Date; retry?: RetryPolicy } = {},
  ) {}
  async search(query: string, limit = 20, signal?: AbortSignal): Promise<LiteratureSearchResponse> {
    const normalized = query.trim(); if (normalized.length < 2 || normalized.length > 200) throw new Error("literature query must contain 2-200 characters");
    const boundedLimit = Math.min(Math.max(Math.trunc(limit), 5), 40); const now = this.options.now?.() ?? new Date(); const key = this.cache.key(normalized, boundedLimit); const cached = await this.cache.read(key);
    if (cached && Date.parse(cached.expiresAt) > now.getTime()) return { ...cached.response, cache: "hit" };
    const running = this.inflight.get(key); if (running) return running;
    const pending = this.fetchAndCache(normalized, boundedLimit, key, now, cached, signal); this.inflight.set(key, pending);
    try { return await pending; } finally { this.inflight.delete(key); }
  }

  private async fetchAndCache(normalized: string, boundedLimit: number, key: string, now: Date, cached: CacheFile | undefined, signal?: AbortSignal): Promise<LiteratureSearchResponse> {
    try {
      let provider: LiteratureProvider = this.primary; let degradedFrom: "semantic-scholar" | undefined; let result: { value: PaperRecord[]; attempts: number }; let totalAttempts = 0;
      try { result = await withLiteratureRetry(() => this.primary.search(normalized, boundedLimit, signal), this.options.retry); totalAttempts = result.attempts; }
      catch (primaryError) {
        provider = this.fallback; degradedFrom = "semantic-scholar"; totalAttempts = integer(record(primaryError).attempts) || 1;
        try { result = await withLiteratureRetry(() => this.fallback.search(normalized, boundedLimit, signal), this.options.retry); totalAttempts += result.attempts; }
        catch (fallbackError) { Object.assign(fallbackError instanceof Error ? fallbackError : new Error(String(fallbackError)), { primaryError }); throw fallbackError; }
      }
      const fetchedAt = now.toISOString(); const sourceHash = shaLikeHash(JSON.stringify(result.value));
      const response: LiteratureSearchResponse = { query: normalized, papers: result.value, provider: provider.id, fetchedAt, cache: "miss", sourceHash, ...(degradedFrom ? { degradedFrom } : {}), attempts: totalAttempts };
      await this.cache.write(key, { version: 1, expiresAt: new Date(now.getTime() + (this.options.ttlMs ?? 24 * 60 * 60 * 1_000)).toISOString(), response }); return response;
    } catch (error) {
      if (cached) return { ...cached.response, cache: "stale" };
      throw error;
    }
  }
}

// ---------- 构图引擎（@xiling/literature/index.ts 原样移植） ----------

const pairId = (kind: LiteratureGraphEdge["kind"], left: string, right: string) => `${kind}:${[left, right].sort().join(":")}`;

export function buildLiteratureGraph(papers: PaperRecord[], seedIds: string[], options: { limit?: number; fetchedAt?: string } = {}): LiteratureGraph {
  const limit = Math.min(Math.max(options.limit ?? 40, 1), 100);
  const unique = new Map(papers.map((paper) => [paper.id, paper]));
  const seeds = new Set(seedIds.filter((id) => unique.has(id)));
  if (seeds.size === 0) throw new Error("at least one valid seed paper is required");

  const relevance = (paper: PaperRecord) => {
    if (seeds.has(paper.id)) return 1;
    const citedBySeed = [...seeds].filter((seed) => unique.get(seed)?.references.includes(paper.id)).length;
    const citesSeed = paper.references.filter((reference) => seeds.has(reference)).length;
    const seedReferences = new Set([...seeds].flatMap((seed) => unique.get(seed)?.references ?? []));
    const shared = paper.references.filter((reference) => seedReferences.has(reference)).length;
    return citedBySeed * 0.45 + citesSeed * 0.35 + Math.min(shared * 0.1, 0.2);
  };
  const chosen = [...unique.values()]
    .map((paper) => ({ paper, relevance: relevance(paper) }))
    .sort((left, right) => Number(seeds.has(right.paper.id)) - Number(seeds.has(left.paper.id)) || right.relevance - left.relevance || right.paper.citationCount - left.paper.citationCount)
    .slice(0, limit);
  const chosenIds = new Set(chosen.map(({ paper }) => paper.id));
  const nodes: LiteratureGraphNode[] = chosen.map(({ paper, relevance: score }) => ({ ...paper, seed: seeds.has(paper.id), relevance: Number(score.toFixed(3)) }));
  const edges: LiteratureGraphEdge[] = [];

  for (const paper of nodes) {
    for (const reference of paper.references) {
      if (reference !== paper.id && chosenIds.has(reference)) edges.push({ id: `citation:${paper.id}:${reference}`, source: paper.id, target: reference, kind: "citation", score: 1 });
    }
  }
  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
      const left = nodes[leftIndex];
      const right = nodes[rightIndex];
      if (!left || !right) continue;
      const sharedReferences = left.references.filter((reference) => right.references.includes(reference)).length;
      const union = new Set([...left.references, ...right.references]).size;
      if (sharedReferences > 0 && union > 0) edges.push({ id: pairId("bibliographic-coupling", left.id, right.id), source: left.id, target: right.id, kind: "bibliographic-coupling", score: Number((sharedReferences / union).toFixed(3)) });
      const coCitation = nodes.filter((paper) => paper.references.includes(left.id) && paper.references.includes(right.id)).length;
      if (coCitation > 0) edges.push({ id: pairId("co-citation", left.id, right.id), source: left.id, target: right.id, kind: "co-citation", score: coCitation });
      if ((left.seed || right.seed) && !left.references.includes(right.id) && !right.references.includes(left.id) && (left.relevance > 0 || right.relevance > 0)) {
        edges.push({ id: pairId("recommendation", left.id, right.id), source: left.id, target: right.id, kind: "recommendation", score: Math.max(left.relevance, right.relevance) });
      }
    }
  }
  return {
    seedIds: [...seeds],
    nodes,
    edges,
    algorithm: "seed-neighborhood + citation + co-citation + Jaccard bibliographic coupling; deterministic v1",
    provider: papers.every((paper) => paper.source === "fixture") ? "fixture" : papers.some((paper) => paper.source === "semantic-scholar") ? "semantic-scholar" : "openalex",
    fetchedAt: options.fetchedAt ?? new Date().toISOString(),
  };
}

export function createOceanHeatwaveFixture(): { papers: PaperRecord[]; seedIds: string[] } {
  const paper = (id: string, title: string, year: number, citationCount: number, references: string[], authors: string[]): PaperRecord => ({ id, title, year, citationCount, references, authors, source: "fixture", url: `https://example.invalid/papers/${id}`, abstract: `${title}。该固定测试论文用于验证文献发现、阅读标注与科研证据提升闭环。` });
  return {
    seedIds: ["seed-mhw"],
    papers: [
      paper("seed-mhw", "Upper-ocean stratification and marine heatwave persistence", 2023, 82, ["mld", "mechanism", "argo-method"], ["Lin", "Chen"]),
      paper("mld", "Mixed-layer depth controls on extreme ocean warming", 2020, 214, ["classic-heat", "argo-method"], ["Holbrook"]),
      paper("mechanism", "Ocean stratification amplifies surface heat extremes", 2021, 176, ["classic-heat", "flux"], ["Li", "Oliver"]),
      paper("argo-method", "A global Argo climatology of mixed-layer properties", 2019, 305, ["argo-qc", "mld-algo"], ["de Boyer Montégut"]),
      paper("regional", "Northwest Pacific marine heatwaves in 2023", 2024, 34, ["seed-mhw", "mechanism", "flux"], ["Wang"]),
      paper("flux", "Air-sea flux feedbacks during persistent marine heatwaves", 2018, 190, ["classic-heat"], ["Benthuysen"]),
      paper("mld-algo", "Temperature threshold estimates of ocean mixed layers", 2004, 811, ["argo-qc"], ["de Boyer Montégut"]),
      paper("argo-qc", "Argo quality control and delayed-mode practices", 2017, 98, [], ["Wong"]),
      paper("classic-heat", "A global assessment of marine heatwaves", 2016, 1720, [], ["Hobday"]),
    ],
  };
}

/** 检索失败时的离线兜底：旧路由 503 前端会保留旧图；离线首启则用 fixture 构图 */
export function offlineFallbackGraph(): LiteratureSearchResponse & { graph: LiteratureGraph } {
  const fixture = createOceanHeatwaveFixture();
  const graph = buildLiteratureGraph(fixture.papers, fixture.seedIds, { fetchedAt: new Date().toISOString() });
  return {
    query: "fixture", papers: fixture.papers, provider: "semantic-scholar", fetchedAt: graph.fetchedAt,
    cache: "stale", sourceHash: "offline", attempts: 0, graph,
  };
}

/** 共享服务实例（组件直接使用） */
export const literatureService = new LiteratureSearchService(
  new SemanticScholarProvider(),
  new OpenAlexProvider(),
  new LocalLiteratureCache(),
);
