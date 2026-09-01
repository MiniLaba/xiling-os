import { DefaultResourceLoader, SessionManager, SettingsManager, createAgentSession, createEventBus } from "@earendil-works/pi-coding-agent";
import { createMcpAdapter, MCP_STATUS_EVENT } from "pi-mcp-adapter";
import { createInterface } from "node:readline";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

let session;
let extensionsEnabled = true;
let initError;
const activeCalls = new Map();
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

async function initialize(root, config) {
  const cwd = resolve(root, "workspace");
  const agentDir = resolve(root, "agent");
  await Promise.all([mkdir(cwd, { recursive: true, mode: 0o700 }), mkdir(agentDir, { recursive: true, mode: 0o700 })]);
  const eventBus = createEventBus();
  eventBus.on(MCP_STATUS_EVENT, (snapshot) => send({ event: "status", snapshot }));
  const factory = createMcpAdapter({ config: {
    mcpServers: Object.fromEntries(config.servers.map((server) => [server.name, server.definition])),
    settings: { hostConfigDiscovery: "off", scriptMode: false, directTools: false, disableProxyTool: false, freezeDirectTools: true, outputGuard: { maxBytes: 50 * 1024, maxLines: 2_000, detailsMaxBytes: 16 * 1024 }, mcpFooterStatus: "off", notifyOnStartupConnect: false },
  } });
  const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, eventBus, settingsManager: settings,
    extensionFactories: [{ name: "pi-mcp-adapter", factory, hidden: true }],
    extensionsOverride: (base) => extensionsEnabled ? base : { ...base, extensions: [] },
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await resourceLoader.reload();
  ({ session } = await createAgentSession({ cwd, agentDir, settingsManager: settings, resourceLoader, sessionManager: SessionManager.inMemory(cwd), noTools: "builtin" }));
  await session.bindExtensions({ mode: "rpc" });
}

async function close() {
  if (!session) return;
  extensionsEnabled = false;
  try { await session.reload(); }
  finally { session.dispose(); session = undefined; }
}

const lines = createInterface({ input: process.stdin });
let queue = Promise.resolve();
async function handle(line) {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  try {
    if (message.op === "init") {
      try { await initialize(message.root, message.config); }
      catch (error) { initError = error instanceof Error ? error.message : String(error); throw error; }
      return;
    }
    if (message.op === "ready") {
      if (initError) throw new Error(`MCP host init failed: ${initError}`);
      if (!session) throw new Error("MCP host session is not initialized");
      send({ id: message.id, ok: true, result: { content: [{ type: "text", text: "ready" }], details: { ready: true } } }); return;
    }
    if (message.op === "call") {
      const tool = session?.state.tools.find((candidate) => candidate.name === "mcp");
      if (!tool) throw new Error("pi-mcp-adapter did not register the MCP gateway tool");
      const controller = new AbortController();
      activeCalls.set(message.id, controller);
      try {
        const result = await tool.execute(message.callId, message.parameters, controller.signal, undefined);
        send({ id: message.id, ok: true, result });
      } finally { activeCalls.delete(message.id); }
      return;
    }
    if (message.op === "cancel") { activeCalls.get(message.requestId)?.abort("MCP request cancelled"); return; }
    if (message.op === "close") { await close(); process.exit(0); }
  } catch (error) {
    if (message.id) send({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
    else send({ event: "fatal", error: error instanceof Error ? error.message : String(error) });
  }
}
lines.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.op === "call" || message.op === "cancel") void handle(line);
  else queue = queue.then(() => handle(line));
});

process.on("SIGTERM", async () => { await close(); process.exit(0); });
