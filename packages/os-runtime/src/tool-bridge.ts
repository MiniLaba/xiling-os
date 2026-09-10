import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { RunRequest } from "./port.js";

/** Per-run loopback capability. No filesystem paths, arbitrary RPC, or public binding. */
export async function startToolBridge(request: RunRequest) {
  const token = randomBytes(32).toString("hex");
  let closed = false;
  let busy = false;
  const server = createServer(async (req, res) => {
    const authorization = Buffer.from(req.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (closed || req.method !== "POST" || req.url !== "/invoke" || req.headers.origin || authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) {
      res.writeHead(403).end(); return;
    }
    if (busy) { res.writeHead(409).end(); return; }
    busy = true;
    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 300_000) throw new Error("Tool input too large");
      }
      const value = JSON.parse(body) as { name?: unknown; input?: unknown; callId?: unknown };
      if (closed || typeof value.name !== "string" || typeof value.callId !== "string" || !value.callId || value.callId.length > 200 || !request.tools.some((tool) => tool.name === value.name) || !request.executeTool) throw new Error("Tool not authorized");
      const result = await request.executeTool(value.name, value.input, value.callId);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ result }));
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : "Tool failed" }));
    } finally { busy = false; }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Tool bridge unavailable");
  return { url: `http://127.0.0.1:${address.port}/invoke`, token,
    close: async () => { if (closed) return; closed = true; server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}
