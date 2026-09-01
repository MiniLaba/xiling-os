import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";

export const LOCAL_ACCESS_TOKEN_HEADER = "x-xiling-token";

declare module "fastify" {
  interface FastifyInstance { localAccessToken: string }
}

/** Only loopback hostnames are accepted; this also defeats DNS-rebinding origins. */
export function isLocalHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  const hostname = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0]!;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

/**
 * One stable token per installation so local scripts can read it from disk;
 * browsers obtain it through GET /api/auth/token, which is unreadable from
 * cross-origin pages (CORS allowlist) and from rebound hosts (host check).
 */
export function loadOrCreateLocalAccessToken(runtimeRoot: string): string {
  const path = resolve(runtimeRoot, "access-token");
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (/^[a-f0-9]{64}$/.test(existing)) return existing;
  } catch { /* first run */ }
  const token = randomBytes(32).toString("hex");
  mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  return token;
}

/**
 * CSRF / drive-by-localhost defense: cross-site "simple requests" cannot set
 * custom headers, and cross-origin reads of /api/auth/token are blocked by the
 * localhost-only CORS allowlist plus the host header check above.
 */
export function registerLocalAccessControl(app: FastifyInstance, token: string): void {
  app.addHook("onRequest", async (request, reply) => {
    if (!isLocalHostHeader(request.headers.host)) { void reply.code(403).send({ error: "Forbidden host header", code: "forbidden_host" }); return reply; }
    if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return;
    if (request.headers[LOCAL_ACCESS_TOKEN_HEADER] === token) return;
    void reply.code(403).send({ error: "Missing or invalid local access token", code: "unauthorized" });
    return reply;
  });
  app.get("/api/auth/token", async () => ({ token }));
  app.decorate("localAccessToken", token);
}
