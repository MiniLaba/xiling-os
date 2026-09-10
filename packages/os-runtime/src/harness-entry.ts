/** Owned child process: official Cordis/DSH loop, no shell/filesystem tools. */
import { Context } from "@deepseek-ai/cordis";
import * as spine from "@deepseek-ai/dsh-agent-spine-demo";
import * as llm from "@deepseek-ai/dsh-llm-pi-ai";
import * as server from "@deepseek-ai/dsh-sdk-jsonrpc-server";
import { JsonlSessionPersistence } from "@deepseek-ai/dsh-session-persistence-jsonl";
import { mkdir } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { serveResumableSession } from "./resumable-sdk-server.js";
import { defineTool } from "@deepseek-ai/dsh-tools";
import TokenMeter from "@deepseek-ai/dsh-token-meter";
import { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";

const route = JSON.parse(process.env.XILING_HARNESS_ROUTE ?? "null") as {
  provider: string; model: string; keyVariable: string;
  profile?: { baseURL?: string; api?: string }; contextWindow?: number;
  sessionId?: string; persistenceRoot?: string;
  bridge?: { url: string; token: string }; tools?: Array<{ name: string; description: string }>;
} | null;
if (!route || !route.provider || !route.model || !/^[A-Z_]+_API_KEY$/.test(route.keyVariable)) throw new Error("Missing bundled Harness route");
const context = new Context();
const close = async () => { await context.fiber.dispose(); };
process.stdin.once("end", () => { void close().finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void close().finally(() => process.exit(0)); });
try {
  await context.plugin(spine, {
    workspaceContext: false, toolBash: false, toolJobs: false, goals: false,
    skills: { enabled: false }, includeRuntimeContext: false, includeHarnessIdentity: false,
  });
  await context.plugin(llm, { providers: { [route.provider]: { ...route.profile, apiKeyEnv: route.keyVariable,
    models: [{ id: route.model, ...(route.contextWindow ? { contextWindow: route.contextWindow } : {}) }], retryPolicy: { mode: "normal", maxRetries: 1 },
  } } });
  await context.plugin(TokenMeter);
  await context.plugin(BasicCompactionEngine); // official pressure policy, balanced tool history, durable checkpoints
  if (route.bridge) {
    const bridge = route.bridge;
    const url = new URL(bridge.url);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/invoke") throw new Error("Invalid tool bridge");
    for (const tool of route.tools ?? []) {
      context.tools.register(defineTool({
        name: tool.name, description: tool.description,
        parameters: { input: { type: "string", required: true, description: "JSON object matching the operation described above" } },
        output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
        async execute(args, exec) {
          const response = await fetch(bridge.url, { method: "POST", headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
            body: JSON.stringify({ name: tool.name, input: JSON.parse(args.input), callId: exec.callId }), signal: exec.signal });
          const body = await response.json() as { result?: unknown; error?: string };
          if (!response.ok) throw new Error(body.error ?? "OS tool denied");
          return JSON.stringify(body.result);
        },
      }));
    }
  }
  if (route.sessionId && route.persistenceRoot) {
    if (!isAbsolute(route.persistenceRoot)) throw new Error("Persistence root must be absolute");
    await mkdir(route.persistenceRoot, { recursive: true, mode: 0o700 });
    await context.plugin(JsonlSessionPersistence, { root: route.persistenceRoot, compression: "none" });
    serveResumableSession(context, { sessionId: route.sessionId, provider: route.provider, model: route.model });
  } else {
    // Explicit no-history diagnostic handshake path, never used by the desktop task factory.
    await context.plugin(server);
  }
} catch {
  // Boot diagnostics must not echo credentials or provider payloads to stdout/stderr.
  process.stderr.write("XiLing Harness composition failed to initialize\n");
  await close();
  process.exitCode = 1;
}
