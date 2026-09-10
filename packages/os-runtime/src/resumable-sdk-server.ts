import type { Context } from "@deepseek-ai/cordis";
import type { AgentHandle } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { JsonRpcLineTransport } from "@deepseek-ai/dsh-sdk-protocol";
import { HarnessSdkJsonRpcServer } from "@deepseek-ai/dsh-sdk-jsonrpc-server";

/** Adds owned-session resume using public APIs; official server still owns event mapping. */
export function serveResumableSession(ctx: Context, route: { sessionId: string; provider: string; model: string }) {
  const transport = new JsonRpcLineTransport(process.stdin, process.stdout);
  const server = new HarnessSdkJsonRpcServer(ctx, transport);
  let initialized = false;
  let maxTokens: number | undefined;
  let stopping = false;
  let handle: Promise<AgentHandle> | undefined;
  const getHandle = () => handle ??= (async () => {
    const id = SessionId(route.sessionId);
    const exists = (await ctx.sessionPersistence.list()).some((meta) => meta.id === id);
    const agentOptions = { provider: route.provider, model: route.model, ...(maxTokens === undefined ? {} : { maxTokens }) };
    // Corrupt or unsupported history must reject, never fall back to a fresh session.
    return exists ? ctx.agents.resume({ resumeSessionId: id, agentOptions }) :
      ctx.agents.create({ sessionId: id, agentOptions });
  })();
  const dispose = async () => {
    if (handle) await (await handle.catch(() => undefined))?.dispose();
    await server.shutdown();
  };
  transport.onRequest(async (method, params) => {
    if (stopping) throw new Error("Harness is shutting down");
    if (method === "initialize") {
      if (initialized) throw new Error("Harness already initialized");
      if (params.provider !== route.provider || params.model !== route.model) throw new Error("Model route mismatch");
      if (params.maxTokens !== undefined) {
        if (typeof params.maxTokens !== "number" || !Number.isSafeInteger(params.maxTokens) || params.maxTokens <= 0) throw new Error("Invalid maxTokens");
        maxTokens = params.maxTokens;
      }
      const result = await server.handleRequest(method, params);
      initialized = true;
      return result;
    }
    if (method === "session/prompt") {
      if (!initialized || params.sessionId !== route.sessionId) throw new Error("Session ownership mismatch");
      const blocks = params.contentBlocks;
      if (!Array.isArray(blocks) || !blocks.length || blocks.some((block) => !block || block.type !== "text" || typeof block.text !== "string")) throw new Error("Only native text input is enabled");
      const agent = await getHandle();
      if (stopping) throw new Error("Harness is shutting down");
      const message = createUserMessage({ content: blocks.map((block) => ({ type: "text" as const, text: block.text as string })), source: { kind: "user" } });
      agent.agent.followup(message);
      return { messageId: message.id };
    }
    if (method === "shutdown") {
      stopping = true;
      await dispose();
      setImmediate(() => { void (async () => {
        await transport.flush();
        await ctx.root.fiber.dispose();
        process.exit(0);
      })().catch(() => process.exit(1)); });
      return {};
    }
    throw new Error("Unsupported SDK request");
  });
  ctx.effect(() => {
    transport.start();
    return async () => { stopping = true; try { await dispose(); } finally { transport.close(); } };
  }, "xiling.resumable-sdk");
}
