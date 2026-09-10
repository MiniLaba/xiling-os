// OS Kernel Host：把 AI Native OS 内核挂进 Electron 核心进程（utilityProcess）。
// 事件以 JSON Lines 追加持久化；重启时重放恢复投影（指南 §44：Durable state != runtime process）。
// 首次启动引导长期存在的 Main Agent Identity；后续启动从事件流恢复。

import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { DeepSeekHarnessSdkRuntimeAdapter, createDefaultHarnessFactory, parseDshArgs, bundledHarnessLaunch, harnessSessionId } from "@xiling/os-runtime";
import { OSKernel, recoverFromEvents } from "@xiling/os-kernel";
import type { AgentPluginManifest, ModelAddress, NativeInputModality, NativeOutputModality, OSEvent } from "@xiling/os-domain";
import { OsPersistence } from "./os-persistence.js";
import { harnessCredentials } from "./core/harness-credentials.js";
import { VoiceService } from "./core/voice-service.js";
import { NativeVoiceRuntime } from "./core/native-voice-runtime.js";

export interface OsKernelHostOptions {
  readModelKey?: (provider: string, field?: string) => string | undefined;
  /** 内置标准插件：注册进内核能力目录，并绑定到 Main Agent */
  plugins?: readonly AgentPluginManifest[] | undefined;
}

export interface OsKernelHost {
  voice: VoiceService;
  kernel: OSKernel;
  databaseFile: string;
  mainAgentId: string | undefined;
  recovery: { eventsReplayed: number; resumableTaskIds: string[] };
  shutdown(): Promise<void>;
}

export async function startOsKernel(dataDirectory: string, options: OsKernelHostOptions = {}): Promise<OsKernelHost> {
  await mkdir(dataDirectory, { recursive: true });
  const eventsFile = path.join(dataDirectory, "os-events.jsonl");
  const databaseFile = path.join(dataDirectory, "os-state.sqlite");
  const persistence = new OsPersistence(databaseFile, eventsFile);
  const persisted: OSEvent[] = persistence.loadEvents();
  const kernel = new OSKernel({
    eventHooks: { append: (event) => persistence.appendEvent(event) },
    artifactContentStore: persistence,
  });
  const voice = new VoiceService(dataDirectory, options.readModelKey ?? (() => undefined));
  await voice.initialize();
  kernel.runtimes.register(new NativeVoiceRuntime(kernel, voice));

  // 产品只注册真实运行时；确定性脚本适配器仅由测试独立注册。
  // 默认按需启动内置无执行器的官方 DSH 组合；XILING_DSH_ENABLED=0 禁用。
  // 外部运行程序仍可通过 XILING_DSH_BIN / JSON XILING_DSH_ARGS 显式覆盖。
  // 产品进程禁止注册模拟成功；旧 scripted 身份显式不可运行，不能静默切换引擎。
  let realRuntime: DeepSeekHarnessSdkRuntimeAdapter | undefined;
  const configuredModel = configuredModelAddress();
  if (process.env.XILING_DSH_ENABLED !== "0") {
    realRuntime = new DeepSeekHarnessSdkRuntimeAdapter({
      supportsHostTools: !process.env.XILING_DSH_BIN,
      ownsSessionHistory: !process.env.XILING_DSH_BIN,
      factory: (route, request, bridge) => {
        const credential = harnessCredentials(route?.address.providerId ?? process.env.XILING_DSH_PROVIDER,
          options.readModelKey ?? (() => undefined), process.env);
        const bundled = bundledHarnessLaunch();
        const provider = route?.address.providerId ?? process.env.XILING_DSH_PROVIDER;
        const model = route?.address.modelId ?? process.env.XILING_DSH_MODEL;
        const useBundled = !process.env.XILING_DSH_BIN;
        if (useBundled && !request) throw new Error("Missing runtime task identity");
        const sessionId = request ? harnessSessionId(request) : undefined;
        if (useBundled && provider === "deepseek-official") throw new Error("内置多提供商运行时请使用 deepseek 提供商名称");
        const harness = createDefaultHarnessFactory({
        dshBin: useBundled ? bundled.command : process.env.XILING_DSH_BIN,
        dshArgs: useBundled ? bundled.args : parseDshArgs(process.env.XILING_DSH_ARGS),
        provider: process.env.XILING_DSH_PROVIDER,
        model: process.env.XILING_DSH_MODEL,
        cwd: process.env.XILING_DSH_CWD,
        env: { ...credential.env, ...(useBundled ? {
          ELECTRON_RUN_AS_NODE: "1",
          XILING_HARNESS_ROUTE: JSON.stringify({ provider, model, keyVariable: credential.keyVariable,
            bridge, tools: request?.tools,
            profile: credential.profile, contextWindow: route?.capabilities.contextWindowTokens,
            sessionId, persistenceRoot: sessionId ? path.join(dataDirectory, "harness-sessions", createHash("sha256").update(sessionId).digest("hex")) : undefined }),
        } : {}) },
      })(route);
        harness.redactError = credential.redactError;
        return harness;
      },
      turnTimeoutMs: 15 * 60_000,
    });
    kernel.runtimes.register(realRuntime);
  }
  kernel.scheduler.setRunner({
    run: async (taskId, ctx) => { await kernel.runner.executeTask(taskId, ctx); },
  });

  // 重放历史事件（保留 eventId/seq/occurredAt，且绝不再次写回 JSONL）
  kernel.events.hydrate(persisted);
  kernel.plugins.restoreInstalledCatalog();
  if (configuredModel !== undefined && kernel.modelCatalog.get(configuredModel) === undefined) {
    kernel.modelCatalog.register({
      address: configuredModel,
      nativeInputs: parseInputModalities(process.env.XILING_DSH_INPUT_MODALITIES),
      nativeOutputs: parseOutputModalities(process.env.XILING_DSH_OUTPUT_MODALITIES),
      contextWindowTokens: positiveInteger(process.env.XILING_DSH_CONTEXT_WINDOW) ?? 32_000,
      supportsToolUse: process.env.XILING_DSH_TOOL_USE !== "0",
      reasoning: process.env.XILING_DSH_REASONING === "1",
      source: "user-declared",
    });
  }
  const recovery = recoverFromEvents(kernel, kernel.events.all());
  // An owned process cannot survive a core restart. Never leave phantom running tasks.
  for (const task of [...kernel.projection.tasks.values()]) {
    if (task.state === "running") await kernel.tasks.fail(task.id, "应用已重启，先前运行已中断；可在任务中心重试。已保存产物与会话历史保留。", { actor: "system" });
  }

  // 首次启动：引导 Main Agent（长期身份；停止运行也不消失）。
  // 允许动作 = 基础 OS 权限 + 内置插件请求的权限（插件绑定天花板校验需要）。
  const pluginPermissions = (options.plugins ?? []).flatMap((plugin) => plugin.permissions ?? []);
  const existingMain = [...kernel.projection.agents.values()].find((definition) => definition.isMainAgent);
  let mainAgentId = existingMain?.id;
  if (mainAgentId === undefined) {
    const main = await kernel.agents.create({
      name: "Main Agent",
      isMainAgent: true,
      runtimeName: "deepseek-harness-sdk",
      pluginBindings: [],
      allowedActions: ["task.create", "task.delegate", "memory.write", "ui.present", "agent.message", ...new Set(pluginPermissions)],
      systemInstructions: "你是用户与汐灵 OS 交互的主要入口。",
      modelPolicy: configuredModel === undefined ? {} : { preferred: configuredModel },
    });
    mainAgentId = main.id;
  } else if (configuredModel !== undefined && existingMain !== undefined && existingMain.modelPolicy.preferred === undefined && existingMain.modelPolicy.primary === undefined) {
    // 一次性兼容旧事件：旧 Main Agent 曾把模型固定在进程环境里，没有领域策略记录。
    kernel.agents.updateModelPolicy(existingMain.id, { ...existingMain.modelPolicy, preferred: configuredModel });
  }

  // 插件注册：能力目录（Agent 可发现"谁拥有 literature.search"）+ 绑定 Main Agent。
  // 旧档案里的 Main Agent 策略可能不含新插件权限 —— 绑定失败只记录，不阻断启动。
  for (const plugin of options.plugins ?? []) {
    kernel.plugins.register(plugin);
    if (mainAgentId !== undefined) {
      await kernel.plugins.bindToAgent(mainAgentId, plugin.id).catch((error: unknown) => {
        console.warn(`[os-kernel] plugin ${plugin.id} bind failed:`, error instanceof Error ? error.message : error);
      });
    }
  }

  return {
    voice,
    kernel,
    databaseFile,
    mainAgentId,
    recovery,
    shutdown: async () => {
      try { await realRuntime?.close(); } finally { persistence.close(); }
    },
  };
}

function configuredModelAddress(): ModelAddress | undefined {
  const providerId = process.env.XILING_DSH_PROVIDER?.trim();
  const modelId = process.env.XILING_DSH_MODEL?.trim();
  return providerId && modelId ? { providerId, modelId } : undefined;
}

function parseInputModalities(raw: string | undefined): NativeInputModality[] {
  const allowed = new Set<NativeInputModality>(["text", "image", "audio", "video"]);
  const parsed = raw?.split(",").map((item) => item.trim()).filter((item): item is NativeInputModality => allowed.has(item as NativeInputModality)) ?? [];
  return [...new Set<NativeInputModality>(["text", ...parsed])];
}

function parseOutputModalities(raw: string | undefined): NativeOutputModality[] {
  const allowed = new Set<NativeOutputModality>(["text", "image"]);
  const parsed = raw?.split(",").map((item) => item.trim()).filter((item): item is NativeOutputModality => allowed.has(item as NativeOutputModality)) ?? [];
  return [...new Set<NativeOutputModality>(["text", ...parsed])];
}

function positiveInteger(raw: string | undefined): number | undefined {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}
