// Pi 科研运行时装配：把 @xiling/pi-runtime 的 PiRuntimeAdapter 装进
// @xiling/os-runtime 的 PiResearchRuntimeAdapter（Runtime Boundary 后面的适配器）。
//
// 边界：本文件是桌面宿主唯一允许直接构造 Pi 的地方；内核只看 AgentRuntime 端口。
// 真实声明：没有任何凭据时不构造"看起来能跑"的会话，而是给出明确失败的离线错误路由；
// 未声明的输入模态不会出现在适配器能力里。

import type { PiResearchRuntimeAdapter, PiStreamEventLike, PiTurnSessionFactory } from "@xiling/os-runtime";

export interface PiResearchRuntimeBoot {
  /** 装配成功时的运行时；Pi 包不可用时为 undefined。 */
  runtime?: PiResearchRuntimeAdapter;
  available: boolean;
  reason?: string;
}

export interface PiResearchRuntimeOptions {
  /** 只读凭据回调（与 DSH 路径共用同一凭据来源，不复制一份密钥）。 */
  readModelKey: (provider: string, field?: string) => string | undefined;
  /** Pi 输入模态声明；默认仅 text，避免声称能送图像。 */
  inputModalities?: ReadonlyArray<"text" | "image">;
}

export async function createPiResearchRuntime(options: PiResearchRuntimeOptions): Promise<PiResearchRuntimeBoot> {
  let pi: typeof import("@xiling/pi-runtime");
  try {
    pi = await import("@xiling/pi-runtime");
  } catch (error) {
    return { available: false, reason: `@xiling/pi-runtime 不可用：${describe(error)}` };
  }

  const { PiResearchRuntimeAdapter: Adapter } = await import("@xiling/os-runtime");

  const sessionFactory: PiTurnSessionFactory = ({ request, sessionId }) => {
    const session = new pi.PiRuntimeAdapter({
      sessionId,
      systemPrompt: "你是汐灵科研 OS 的科研 Agent。只对可追溯来源的内容作结论，并区分事实、推断与限制。",
      route: piRouteFor(pi, request.modelRoute.address, request.modelRoute.capabilities.nativeInputs, options.readModelKey),
      reasoning: "off",
      contextPolicy: "deduplicate-adjacent",
    });
    return {
      subscribe: (listener) => session.subscribe((event) => {
        const narrowed = narrowPiEvent(event);
        if (narrowed !== undefined) void listener(narrowed);
      }),
      prompt: async (text, images) => { await session.prompt(text, images as never); },
      abort: () => { session.abort(); },
    };
  };

  return {
    available: true,
    runtime: new Adapter({
      sessionFactory,
      // 工具桥尚未接入 Pi 工具循环：保持 false，任务带工具时明确失败。
      supportsHostTools: false,
      ownsSessionHistory: false,
      nativeInputModalities: options.inputModalities ?? ["text"],
      compatibilityBaseline: pi.PI_COMPATIBILITY_BASELINE,
      turnTimeoutMs: 15 * 60_000,
    }),
  };
}

/**
 * 已配置凭据 → 真实模型路由；未配置 → 明确报错的离线路由。
 * 两种情况都不使用 fixture 内容冒充科研结果。
 */
function piRouteFor(
  pi: typeof import("@xiling/pi-runtime"),
  address: { providerId: string; modelId: string },
  declaredInputs: readonly string[],
  readModelKey: PiResearchRuntimeOptions["readModelKey"],
): import("@xiling/pi-runtime").RuntimeModelRoute {
  const apiKey = readModelKey(address.providerId);
  if (!apiKey) return pi.createOfflineErrorRoute(`未配置 ${address.providerId} 的模型凭据；Pi 科研运行时不会用离线示例冒充成功`);
  const inputs = declaredInputs.filter((item): item is "text" | "image" => item === "text" || item === "image");
  try {
    return pi.createLiveRoute(address.providerId as never, address.modelId, apiKey, undefined, inputs.length > 0 ? inputs : ["text"]);
  } catch (error) {
    return pi.createOfflineErrorRoute(`模型路由不可用：${describe(error)}`);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Pi 的流事件比 OS 需要的子集更宽（还有 run.accepted / entry.persisted 等轨迹事件）。
 * 这里只放行适配器真正消费的领域事件，其余留在 Pi 会话里 —— OS 不复制第二套轨迹。
 */
const PI_CONSUMED_EVENT_TYPES = new Set<string>([
  "session.started", "message.delta", "tool.started", "tool.finished", "tool.failed", "session.finished", "session.error",
]);

function narrowPiEvent(event: { type: string }): PiStreamEventLike | undefined {
  return PI_CONSUMED_EVENT_TYPES.has(event.type) ? (event as PiStreamEventLike) : undefined;
}
