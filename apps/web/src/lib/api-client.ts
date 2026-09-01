import type { ApiErrorBody } from "@xiling/api-contracts";

export class ApiError extends Error {
  constructor(readonly status: number, readonly body: unknown, message: string) { super(message); }
}

let cachedToken: string | undefined;
try { cachedToken = localStorage.getItem("xiling-access-token") ?? undefined; } catch { /* storage unavailable */ }

/**
 * Mutations must carry the local access token issued by the server. It is only
 * readable same-origin (GET /api/auth/token), so pages from other origins can
 * neither read it nor forge the header.
 */
export async function ensureLocalAccessToken(forceRefresh = false): Promise<string> {
  if (cachedToken && !forceRefresh) return cachedToken;
  const response = await fetch("/api/auth/token");
  if (!response.ok) throw new Error("无法获取本地访问令牌");
  const body = await response.json() as { token: string };
  cachedToken = body.token;
  try { localStorage.setItem("xiling-access-token", body.token); } catch { /* storage unavailable */ }
  return body.token;
}

function withAuthHeader(method: string, headers?: Record<string, string>): Record<string, string> {
  if ((method === "GET" || method === "HEAD") || !cachedToken) return headers ?? {};
  return { ...(headers ?? {}), "x-xiling-token": cachedToken };
}

let fetchInstalled = false;

/**
 * API 客户端层的全局令牌适配（ADR 0042 §5）：锁定视图（文献/项目/Wiki）不得改写，
 * 因此在 fetch 入口统一为同源非 GET 请求补齐本地访问令牌，并在令牌过期（403）时
 * 刷新重试一次。只改请求头，不改变任何响应语义。
 */
export function installLocalTokenFetch(): void {
  if (fetchInstalled || typeof window.fetch !== "function") return;
  fetchInstalled = true;
  const originalFetch = window.fetch.bind(window);
  const readMethod = (input: RequestInfo | URL, init?: RequestInit): string => {
    if (init?.method) return String(init.method).toUpperCase();
    if (typeof input !== "string" && !(input instanceof URL)) return input.method.toUpperCase();
    return "GET";
  };
  const isSameOrigin = (input: RequestInfo | URL): boolean => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return url.startsWith("/") || new URL(url, window.location.href).origin === window.location.origin;
  };
  const hasToken = (input: RequestInfo | URL, init?: RequestInit): boolean => {
    if (init?.headers && new Headers(init.headers).has("x-xiling-token")) return true;
    return typeof input !== "string" && !(input instanceof URL) && input.headers.has("x-xiling-token");
  };
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const method = readMethod(input, init);
    if (method === "GET" || method === "HEAD" || !isSameOrigin(input) || hasToken(input, init)) return originalFetch(input, init);
    const attempt = (retried: boolean): Promise<Response> => {
      const nextInit: RequestInit = { ...init, headers: withAuthHeader(method, init?.headers as Record<string, string>) };
      (nextInit as RequestInit & { __xilingTokenRetry?: boolean }).__xilingTokenRetry = retried;
      return originalFetch(input, nextInit).then(async (response) => {
        if (response.status === 403 && !retried) {
          await ensureLocalAccessToken(true).catch(() => undefined);
          return attempt(true);
        }
        return response;
      });
    };
    return attempt(false);
  };
}

export async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const method = String(init?.method ?? "GET").toUpperCase();
  // 令牌头对任意 init 统一合并：调用方自带 headers 时也不能漏带（防止 403 回归）。
  const headers = withAuthHeader(method, { ...(init?.headers as Record<string, string>) });
  let response = await fetch(url, { ...init, headers });
  if (response.status === 403 && method !== "GET" && method !== "HEAD") {
    // A stale token (server restarted with a new one) is refreshed once and retried.
    await ensureLocalAccessToken(true).catch(() => undefined);
    response = await fetch(url, { ...init, headers: withAuthHeader(method, init?.headers as Record<string, string>) });
  }
  const body = await response.json().catch(() => undefined) as T | ApiErrorBody | undefined;
  if (!response.ok) {
    const detail = body && typeof body === "object" && "error" in body ? JSON.stringify((body as ApiErrorBody).error) : response.statusText;
    throw new ApiError(response.status, body, `HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  return body as T;
}

export const jsonInit = (method: "POST" | "PUT" | "PATCH" | "DELETE", body?: unknown, signal?: AbortSignal): RequestInit => ({
  method,
  // content-type 仅在确有 body 时携带：Fastify 会把空 JSON 体判为 400。
  headers: withAuthHeader(method, body === undefined ? {} : { "content-type": "application/json" }),
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  ...(signal ? { signal } : {}),
});
