// OS Kernel Host：把 AI Native OS 内核挂进 Electron 核心进程（utilityProcess）。
// 事件以 JSON Lines 追加持久化；重启时重放恢复投影（指南 §44：Durable state != runtime process）。
// 首次启动引导长期存在的 Main Agent Identity；后续启动从事件流恢复。

import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { OSKernel, recoverFromEvents } from "@xiling/os-kernel";
import type { AgentPluginManifest, ModelAddress, NativeInputModality, NativeOutputModality, OSEvent } from "@xiling/os-domain";
import { OsPersistence } from "./os-persistence.js";
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
  /** 科研 Harness 的真实状态：请求的路线、实际生效的运行时、以及降级原因。 */
  researchHarness: ResearchHarnessStatus;
  shutdown(): Promise<void>;
}

export interface ResearchHarnessStatus {
  /** 产品唯一执行者：Pi 科研运行时。 */
  executor: string;
  /** Pi 是否已接入宿主工具桥（能兑现带工具的任务契约）。 */
  hostTools: boolean;
  /** 适配器是否真的注册成功。false = 任务会以 runtime_not_found 明确失败。 */
  runtimeRegistered: boolean;
  reason?: string;
}

export async function startOsKernel(dataDirectory: string, options: OsKernelHostOptions = {}): Promise<OsKernelHost> {
  await mkdir(dataDirectory, { recursive: true });
  const eventsFile = path.join(dataDirectory, "os-events.jsonl");
  const databaseFile = path.join(dataDirectory, "os-state.sqlite");
  const persistence = new OsPersistence(databaseFile, eventsFile);
  const persisted: OSEvent[] = persistence.loadEvents();
  // 科研执行：macOS seatbelt 沙箱。装不上就如实报"不可执行"（端口自身会报告原因），
  // 绝不回退到宿主裸跑 —— 见 AGENTS.md 与 docs/adr/0059。
  const { createScienceExecutionPort } = await import("./core/science-execution.js");
  const scienceExecution = createScienceExecutionPort({
    runRoot: path.join(dataDirectory, "science-runs"),
  });
  const kernel = new OSKernel({
    eventHooks: { append: (event) => persistence.appendEvent(event) },
    artifactContentStore: persistence,
    scienceExecution,
  });
  const voice = new VoiceService(dataDirectory, options.readModelKey ?? (() => undefined));
  await voice.initialize();
  kernel.runtimes.register(new NativeVoiceRuntime(kernel, voice));

  // 科研 Harness（INTEGRATION.md）：Pi 是产品唯一执行者。DSH 不再注册、不再考虑。
  // 目标路线与执行者是同一件事，因此没有"降级到另一个引擎"这条路径：
  // Pi 装配失败就明确报错，不用别的引擎顶替，也不静默换成文本轮次。
  let researchRuntimeName: string | undefined;
  let hostTools = false;
  let harnessReason: string | undefined;
  {
    const { createPiResearchRuntime } = await import("./core/pi-research-runtime.js");
    const piBoot = await createPiResearchRuntime({
      readModelKey: options.readModelKey ?? (() => undefined),
      inputModalities: parsePiInputModalities(process.env.XILING_PI_INPUT_MODALITIES),
    });
    if (piBoot.runtime) {
      kernel.runtimes.register(piBoot.runtime);
      researchRuntimeName = piBoot.runtime.name;
      hostTools = piBoot.runtime.supportsHostTools === true;
      if (!hostTools) harnessReason = "Pi 会话未提供宿主工具能力：带工具的任务会被拒绝而不是被剥离工具";
    } else {
      harnessReason = piBoot.reason ?? "Pi 运行时装配失败";
    }
  }
  kernel.scheduler.setRunner({
    run: async (taskId, ctx) => { await kernel.runner.executeTask(taskId, ctx); },
  });

  const configuredModel = configuredModelAddress();

  // 重放历史事件（保留 eventId/seq/occurredAt，且绝不再次写回 JSONL）
  kernel.events.hydrate(persisted);
  kernel.plugins.restoreInstalledCatalog();
  if (configuredModel !== undefined && kernel.modelCatalog.get(configuredModel) === undefined) {
    kernel.modelCatalog.register({
      address: configuredModel,
      nativeInputs: parseInputModalities(process.env.XILING_MODEL_INPUT_MODALITIES),
      nativeOutputs: parseOutputModalities(process.env.XILING_MODEL_OUTPUT_MODALITIES),
      contextWindowTokens: positiveInteger(process.env.XILING_MODEL_CONTEXT_WINDOW) ?? 32_000,
      supportsToolUse: process.env.XILING_MODEL_TOOL_USE !== "0",
      reasoning: process.env.XILING_MODEL_REASONING === "1",
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
      runtimeName: researchRuntimeName ?? "pi-research",
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
  // 已存在的 Main 指向本次生效的科研运行时。仍有未完成任务时拒绝切换：不把运行中的任务
  // 换到另一个引擎继续，也不假装切换成功。
  if (mainAgentId !== undefined && researchRuntimeName !== undefined && existingMain !== undefined && existingMain.runtimeName !== researchRuntimeName) {
    try {
      kernel.agents.setRuntime(mainAgentId, researchRuntimeName, { actor: "system" });
    } catch (error) {
      harnessReason ??= `Main 仍绑定 ${existingMain.runtimeName}：${error instanceof Error ? error.message : String(error)}`;
    }
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
    researchHarness: {
      executor: researchRuntimeName ?? "pi-research",
      hostTools,
      runtimeRegistered: researchRuntimeName !== undefined,
      ...(harnessReason === undefined ? {} : { reason: harnessReason }),
    },
    shutdown: async () => { persistence.close(); },
  };
}

function configuredModelAddress(): ModelAddress | undefined {
  const providerId = process.env.XILING_MODEL_PROVIDER?.trim();
  const modelId = process.env.XILING_MODEL_ID?.trim();
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

/** Pi 的输入模态声明：默认仅 text；未显式声明时不得声称能送图像。 */
function parsePiInputModalities(raw: string | undefined): Array<"text" | "image"> {
  const parsed = raw?.split(",").map((item) => item.trim()).filter((item): item is "text" | "image" => item === "text" || item === "image") ?? [];
  return [...new Set<"text" | "image">(["text", ...parsed])];
}
