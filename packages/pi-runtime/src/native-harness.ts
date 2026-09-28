import { AgentHarness, BACKGROUND_CONTEXT, JsonlSessionRepo, type AgentHarnessTool, type StreamFn } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createModels, type ImageContent, type Model, type Provider, type Usage } from "@earendil-works/pi-ai";
import type { AgentStreamEvent } from "@xiling/contracts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeTool } from "./index.js";

const context = BACKGROUND_CONTEXT;
let sessionsRoot: Promise<string> | undefined;

async function root(): Promise<string> {
  sessionsRoot ??= mkdtemp(join(tmpdir(), "xiling-pi-sessions-"));
  return sessionsRoot;
}

function assistantText(message: { content?: Array<{ type?: string; text?: string }> } | undefined): string {
  return message?.content?.filter((item) => item.type === "text").map((item) => item.text ?? "").join("") ?? "";
}

async function committedAssistantText(findEntries: (query: { order: "newestFirst"; type: "message"; limit: number }) => Promise<unknown[]>): Promise<{ text: string; error?: string }> {
  const entries = await findEntries({ order: "newestFirst", type: "message", limit: 4 });
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || !("message" in entry)) continue;
    const message = entry.message;
    if (!message || typeof message !== "object" || !("role" in message) || message.role !== "assistant" || !("content" in message) || !Array.isArray(message.content)) continue;
    const text = message.content.filter((item): item is { type?: string; text?: string } => Boolean(item) && typeof item === "object").filter((item) => item.type === "text").map((item) => item.text ?? "").join("");
    const stopReason = "stopReason" in message ? message.stopReason : undefined;
    const errorMessage = "errorMessage" in message && typeof message.errorMessage === "string" ? message.errorMessage : "";
    if (stopReason === "error" || stopReason === "aborted") return { text, error: errorMessage || (stopReason === "aborted" ? "模型调用已取消" : "模型调用失败") };
    return { text };
  }
  return { text: "" };
}

export async function promptNativeHarness(input: {
  sessionId: string;
  systemPrompt: string;
  model: Model<any>;
  streamFn: StreamFn;
  tools: RuntimeTool<any, any>[];
  text: string;
  images: ImageContent[];
  reasoning?: "off" | "low" | "medium" | "high";
  onUsage?: (usage: Usage) => void | Promise<void>;
  emit(event: AgentStreamEvent): Promise<void>;
  bindAbort(abort: () => void): void;
}): Promise<void> {
  const directory = await root();
  const env = new NodeExecutionEnv({ cwd: directory });
  const repo = new JsonlSessionRepo({ fileSystem: env, sessionsRoot: join(directory, "sessions") });
  const listed = await repo.list({ cwd: directory }, context);
  const existing = listed.find((item) => item.id === input.sessionId);
  const session = existing
    ? await repo.open(existing, context)
    : await repo.create({ id: input.sessionId, cwd: directory }, context);
  const models = createModels();
  const streamSimple = models.streamSimple.bind(models);
  models.setProvider({
    id: input.model.provider,
    name: input.model.name,
    auth: {},
    getModels: () => [input.model],
    stream: (model, aiContext, options) => input.streamFn(model, aiContext as never, (options ?? {}) as never),
    streamSimple: (model, aiContext, options) => input.streamFn(model, aiContext as never, (options ?? {}) as never),
  } as Provider);
  models.streamSimple = ((model, aiContext, options) => input.streamFn(model, aiContext as never, options ?? {})) as typeof streamSimple;
  const tools = input.tools.map((tool): AgentHarnessTool<undefined> => ({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters as AgentHarnessTool<undefined>["parameters"],
    execute: async (toolCallId, params, onUpdate) => {
      try {
        const result = await tool.execute(toolCallId, params, undefined, async (update) => { onUpdate({ ...update, details: update.details ?? {} }); });
        await input.emit({ type: "tool.finished", toolName: tool.name, callId: toolCallId, details: result.details });
        return { ...result, details: result.details ?? {} };
      } catch (error) {
        await input.emit({ type: "tool.failed", toolName: tool.name, callId: toolCallId, message: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    },
  }));
  const { harness } = await AgentHarness.create({
    session,
    models,
    model: input.model,
    systemPrompt: input.systemPrompt,
    tools,
    ...(input.reasoning ? { thinkingLevel: input.reasoning } : {}),
  }, context);
  const lane = await harness.lane("main", context);
  // The lane freezes the first turn's tool names. A later turn that activates
  // fewer tools otherwise fails before the model runs.
  await harness.setTools(tools, context);
  await lane.setModel({ provider: input.model.provider, modelId: input.model.id }, context);
  await lane.setActiveTools(tools.map((tool) => tool.name), context);
  if (input.reasoning) await lane.setThinkingLevel(input.reasoning, context);
  const watch = await lane.watch(context);
  let streamed = "";
  const seenTools = new Set<string>();
  watch.start(() => {
    const operation = watch.snapshot.operation;
    const text = assistantText(operation?.streamingMessage);
    if (text.length > streamed.length && text.startsWith(streamed)) {
      const delta = text.slice(streamed.length);
      streamed = text;
      void input.emit({ type: "message.delta", delta });
    }
    for (const tool of operation?.runningTools ?? []) {
      if (seenTools.has(tool.toolCallId)) continue;
      seenTools.add(tool.toolCallId);
      void input.emit({ type: "tool.started", toolName: tool.toolName, callId: tool.toolCallId, ...(tool.args === undefined ? {} : { arguments: tool.args }) });
    }
  });
  input.bindAbort(() => { void lane.abort(context); });
  await input.emit({ type: "session.started", sessionId: input.sessionId });
  try {
    const result = await lane.prompt(input.text, input.images.length ? input.images : undefined, context);
    const usage = watch.snapshot.operation?.streamingMessage?.usage;
    if (usage && input.onUsage) await input.onUsage(usage);
    if (!result.ok) {
      await input.emit({ type: "session.error", sessionId: input.sessionId, message: result.error.message });
      return;
    }
    if ("status" in result.value && result.value.status !== "completed" && result.value.status !== "suspended") {
      await input.emit({ type: "session.error", sessionId: input.sessionId, message: result.value.error?.message || "模型调用失败" });
      return;
    }
    const committed = await committedAssistantText((query) => lane.findEntries(query, context));
    const finalText = committed.text || assistantText(watch.snapshot.operation?.streamingMessage) || streamed;
    if (committed.error && !finalText.trim()) {
      await input.emit({ type: "session.error", sessionId: input.sessionId, message: committed.error });
      return;
    }
    if (!finalText.trim()) {
      await input.emit({ type: "session.error", sessionId: input.sessionId, message: "模型未返回文本内容；请检查模型 ID 与输出模态" });
      return;
    }
    if (finalText.length > streamed.length) await input.emit({ type: "message.delta", delta: finalText.slice(streamed.length) });
    await input.emit({ type: "session.finished", sessionId: input.sessionId, stopReason: "stop" });
  } finally {
    watch.unsubscribe();
    input.bindAbort(() => undefined);
    await harness.close(context);
  }
}
