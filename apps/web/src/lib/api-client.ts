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

export async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  let response = await fetch(url, init);
  const method = String(init?.method ?? "GET").toUpperCase();
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
  headers: withAuthHeader(method, { "content-type": "application/json" }),
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  ...(signal ? { signal } : {}),
});
