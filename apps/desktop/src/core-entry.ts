import process from "node:process";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { BUILT_IN_APPS } from "./core/app-registry.js";
import { CapabilityGateway } from "./core/capability-gateway.js";
import type { CoreEvent, CoreMethod, CoreRequest, CoreResponse } from "./core/protocol.js";
import { SystemStore } from "./core/system-store.js";
import type { AppCapability, AppManifest, DesktopWindowState } from "./core/types.js";
import { WorkspaceFileService } from "./core/workspace-files.js";
import { BUILT_IN_PLUGINS, PLUGIN_APPS } from "./plugins/index.js";

const parentPort = process.parentPort;

if (!parentPort) {
  throw new Error("XiLing Core must run as an Electron utility process");
}

const databasePath = process.env.XILING_SYSTEM_DB_PATH;
if (!databasePath) throw new Error("XILING_SYSTEM_DB_PATH is required");

const store = new SystemStore(databasePath);
// 内置 App 行随当前声明迁移：声明之外的历史 system.* 行会从程序坞消失。
// 用户安装的 App 不受影响。
store.pruneUndeclaredSystemApps([...BUILT_IN_APPS, ...PLUGIN_APPS].map((manifest) => manifest.id));
for (const manifest of BUILT_IN_APPS) store.upsertApp(manifest);
const capabilityGateway = new CapabilityGateway(store);
// 插件 APP：标准插件清单派生的 AppManifest 注册进 store（apps.list → 程序坞）。
// 指南 §20 安装管线的 Permission Review 以清单声明为准：注册时对清单声明的
// 网络能力落 allow 决定（workspace/artifact 网关对内置应用本就默认放行）。
for (const app of PLUGIN_APPS) {
  store.upsertApp(app);
  if (app.capabilities.includes("network.access")) capabilityGateway.decide(app.id, "network.access", "allow");
}
let stopWorkspaceWatcher: (() => void) | undefined;
let watchedWorkspacePath: string | undefined;

// ---------- AI Native OS 内核（防御式挂载：失败不影响既有核心能力） ----------

interface OsRuntimeStatus {
  ok: boolean;
  mainAgentId?: string;
  agents: number;
  tasks: number;
  artifacts: number;
  eventsReplayed: number;
  plugins: number;
  error?: string;
}

const osStatus: OsRuntimeStatus = { ok: false, agents: 0, tasks: 0, artifacts: 0, eventsReplayed: 0, plugins: 0 };
let osKernelPromise: Promise<import("./os-kernel-host.js").OsKernelHost> | undefined;
let credentialsPromise: Promise<import("@xiling/credentials").CredentialStore> | undefined;
const voiceCalls = new Map<string, AbortController>();

function bootOsKernel(): Promise<import("./os-kernel-host.js").OsKernelHost> {
  osKernelPromise ??= (async () => {
    const { startOsKernel } = await import("./os-kernel-host.js");
    const dataDirectory = process.env.XILING_OS_DATA_DIR ?? path.join(path.dirname(databasePath ?? "."), "os-data");
    const credentials = await credentialsStore();
    return startOsKernel(dataDirectory, { plugins: BUILT_IN_PLUGINS,
      readModelKey: (provider, field = "apiKey") => credentials.get(provider as never, field),
    });
  })();
  return osKernelPromise;
}

function credentialsStore(): Promise<import("@xiling/credentials").CredentialStore> {
  credentialsPromise ??= (async () => {
    const { CredentialStore } = await import("@xiling/credentials");
    const credentials = new CredentialStore(path.join(path.dirname(databasePath ?? "."), "credentials"));
    await credentials.initialize();
    return credentials;
  })();
  return credentialsPromise;
}

void bootOsKernel()
  .then((host) => {
    osStatus.ok = true;
    if (host.mainAgentId !== undefined) osStatus.mainAgentId = host.mainAgentId;
    osStatus.agents = host.kernel.projection.agents.size;
    osStatus.tasks = host.kernel.projection.tasks.size;
    osStatus.artifacts = host.kernel.projection.artifacts.size;
    osStatus.eventsReplayed = host.recovery.eventsReplayed;
    osStatus.plugins = host.kernel.plugins.list().length;
    host.kernel.events.subscribe((event) => {
      parentPort.postMessage({
        type: "core-event",
        topic: "os.changed",
        payload: { seq: event.seq, eventType: event.type },
      } satisfies CoreEvent);
    });
  })
  .catch((error: unknown) => {
    osStatus.ok = false;
    osStatus.error = error instanceof Error ? error.message : String(error);
  });

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid request parameters");
  return value as Record<string, unknown>;
}

function stringField(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || !value) throw new Error(`Missing ${key}`);
  return value;
}

function caller(params: Record<string, unknown>, capability: AppCapability): AppManifest {
  const appId = stringField(params, "appId");
  return capabilityGateway.authorize(appId, capability);
}

function workspaceService(): WorkspaceFileService {
  const root = store.getWorkspaceRoot("primary");
  if (!root) throw new Error("No desktop folder has been selected");
  return new WorkspaceFileService(root.id, root.nativePath);
}

async function ensureWorkspaceWatcher(): Promise<void> {
  const root = store.getWorkspaceRoot("primary");
  if (!root || watchedWorkspacePath === root.nativePath) return;
  stopWorkspaceWatcher?.();
  const service = new WorkspaceFileService(root.id, root.nativePath);
  stopWorkspaceWatcher = await service.watch(() => {
    parentPort.postMessage({
      type: "core-event",
      topic: "workspace.changed",
      payload: { rootId: root.id },
    } satisfies CoreEvent);
  });
  watchedWorkspacePath = root.nativePath;
}

let research: import("./core/research-service.js").ResearchApplicationService | undefined;
let researchBoot: Promise<void> | undefined;

/** 唯一科研服务实例：渲染器与宿主其它入口（语音/伴侣/对话）共用，权威在核心进程。 */
async function ensureResearch(): Promise<import("./core/research-service.js").ResearchApplicationService> {
  if (!research) {
    researchBoot ??= (async () => {
      const { ResearchApplicationService } = await import("./core/research-service.js");
      const root = path.join(path.dirname(databasePath!), "research", "workspace");
      research = new ResearchApplicationService(root);
    })();
    await researchBoot;
  }
  return research!;
}

/**
 * 入口提交的项目出处：必须与该窗口已绑定的项目一致，且项目真实存在。
 * 不传项目就按普通工作提交，行为不变。
 */
async function resolveSubmitProject(params: Record<string, unknown>): Promise<string | undefined> {
  const requested = params.projectId;
  if (requested === undefined) return undefined;
  if (typeof requested !== "string" || requested.trim() === "") throw new Error("无效的项目出处");
  const windowId = typeof params.windowId === "string" && params.windowId.trim() !== "" ? params.windowId : "system.chat";
  return (await ensureResearch()).scopedProject(windowId, requested);
}

async function dispatch(method: CoreMethod, rawParams: unknown): Promise<unknown> {
  const params = record(rawParams ?? {});
  if (method === "research.knowledge") {
    // 唯一科研入口：项目/事项/Wiki/证据/图谱投影都经由同一个服务，作用域由核心进程决定。
    return (await ensureResearch()).handle(params);
  }
  if (method === "system.ping") return { schemaVersion: store.getSchemaVersion() };
  if (method === "os.voice") {
    const host = await bootOsKernel(); const voice = host.voice;
    const action = stringField(params, "action");
    if (action === "status") return { status: voice.status() };
    if (action === "save") return { status: await voice.save(params.settings) };
    if (action === "test") { const kind = stringField(params, "kind"); if (kind !== "native" && kind !== "stt" && kind !== "tts") throw new Error("无效语音类型"); return { status: await voice.test(kind) }; }
    if (action === "cancel") { voiceCalls.get(stringField(params, "requestId"))?.abort(); return {}; }
    if (action === "transcribe" || action === "speak") {
      const requestId = stringField(params, "requestId");
      if (requestId.length > 80 || voiceCalls.has(requestId) || voiceCalls.size >= 2) throw new Error("语音请求正在处理，请稍后重试");
      const controller = new AbortController(); voiceCalls.set(requestId, controller);
      try {
        voice.require(action === "transcribe" ? "stt" : "tts");
        return action === "transcribe" ? { text: await voice.transcribe(stringField(params, "audio"), controller.signal) } : { audio: await voice.speak(stringField(params, "text"), controller.signal) };
      } finally { voiceCalls.delete(requestId); }
    }
    if (action === "audio") { const artifact = host.kernel.artifacts.get(stringField(params, "id")); if (artifact.mimeType !== "audio/wav") throw new Error("不是语音产物"); return { audio: host.kernel.artifacts.contentOf(artifact.artifactId) }; }
    if (action !== "submit") throw new Error("未知语音操作");
    voice.require("native");
    const { audioBytes } = await import("./core/voice-service.js");
    const audio = stringField(params, "audio"); audioBytes(audio);
    const agentId = host.mainAgentId as never;
    if (!agentId) throw new Error("Main 不可用");
    const session = typeof params.sessionId === "string" ? host.kernel.sessions.get(params.sessionId as never) : host.kernel.sessions.open({ agentId, title: "语音会话", ctx: { actor: "user" } });
    if (session.agentId !== agentId || session.state !== "active") throw new Error("语音会话不属于 Main 或已关闭");
    const route = voice.settings.native;
    host.kernel.modelCatalog.register({ address: { providerId: route.provider, modelId: route.model }, nativeInputs: ["text", "audio"], nativeOutputs: ["text", "audio"], contextWindowTokens: 32000, supportsToolUse: true, source: "native-probe", verifiedAt: new Date().toISOString() });
    const artifact = await host.kernel.artifacts.create({ name: "用户录音.wav", type: "generic", mimeType: "audio/wav", content: audio, creatorAgentId: agentId, metadata: { source: "explicit-microphone", encoding: "base64" }, ctx: { actor: "user" } });
    const task = await host.kernel.tasks.create({ goal: "原生语音请求（内容见本次录音）", sessionId: session.id, ownerAgentId: agentId, assignedAgentId: agentId, inputArtifacts: [{ artifactId: artifact.artifactId, version: artifact.version }], constraints: { runtimeBinding: { name: "native-audio", providerId: route.provider, modelId: route.model } }, modelRequirements: { nativeInputs: ["audio"], nativeOutputs: ["audio"] }, ctx: { actor: "user" } });
    void host.kernel.scheduler.tick({ actor: "system" }).catch(() => console.warn("Voice task scheduling failed"));
    return { taskId: task.id, sessionId: session.id };
  }
  if (method === "os.status") {
    const host = await bootOsKernel().catch(() => undefined);
    if (!host) return osStatus;
    return {
      ok: true,
      mainAgentId: host.mainAgentId,
      agents: host.kernel.projection.agents.size,
      tasks: host.kernel.projection.tasks.size,
      artifacts: host.kernel.projection.artifacts.size,
      eventsReplayed: host.recovery.eventsReplayed,
      plugins: host.kernel.plugins.list().length,
      // 唯一执行者的真实状态：注册成功、工具桥是否接入、失败原因。
      researchHarness: host.researchHarness,
      scienceAdapters: host.kernel.science.adapters(),
    };
  }
  if (method === "os.snapshot") {
    const host = await bootOsKernel();
    const main = host.mainAgentId === undefined ? undefined : host.kernel.projection.agents.get(host.mainAgentId as never);
    const tasks = [...host.kernel.projection.tasks.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((task) => {
      const receipt = [...host.kernel.projection.contextReceipts.values()].reverse().find((item) => item.taskId === task.id);
      const assignedAgent = task.assignedAgentId === undefined ? undefined : host.kernel.projection.agents.get(task.assignedAgentId);
      const delegation = [...host.kernel.projection.inbox.values()].find((item) => item.taskId === task.id);
      return {
        ...task,
        assignedAgentName: assignedAgent?.name,
        canCancelRunning: assignedAgent !== undefined && host.kernel.runtimes.get(task.constraints.runtimeBinding?.name ?? assignedAgent.runtimeName)?.supportsCancellation === true,
        delegationState: delegation?.state,
        activatedPluginIds: receipt?.activatedPluginIds ?? [],
        contextTokens: receipt?.totalTokens,
        model: receipt?.model === undefined ? undefined : {
          providerId: receipt.model.providerId,
          modelId: receipt.model.modelId,
          capabilitySource: receipt.modelCapabilitySource,
        },
        priority: task.constraints.priority ?? 0,
      };
    });
    return {
      mainAgentId: host.mainAgentId,
      runtimeName: main?.runtimeName,
      sessions: [...host.kernel.projection.sessions.values()].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt)),
      preferredModel: main?.modelPolicy.preferred,
      tasks,
      messages: [...host.kernel.projection.messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      approvals: [...host.kernel.projection.approvals.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      surfaces: host.kernel.ui.openSurfaces(),
      artifacts: [...host.kernel.projection.artifacts.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    };
  }
  if (method === "os.goal.submit") {
    // Main remains an independent entry; App sessions use the same Task/Runtime services below.
    const host = await bootOsKernel();
    if (host.mainAgentId === undefined) throw new Error("Main Agent is unavailable");
    const goal = stringField(params, "goal").trim();
    const artifactIds = params.artifactIds ?? [];
    if (!Array.isArray(artifactIds) || artifactIds.length > 20 || artifactIds.some((id) => typeof id !== "string")) throw new Error("无效产物选择");
    const inputArtifacts = artifactIds.map((id) => { const artifact = host.kernel.artifacts.get(id); return { artifactId: artifact.artifactId, version: artifact.version }; });
    const session = typeof params.sessionId === "string" ? host.kernel.sessions.get(params.sessionId as never) : host.kernel.sessions.open({
      agentId: host.mainAgentId as never,
      title: goal.length > 64 ? `${goal.slice(0, 61)}…` : goal,
      ctx: { actor: "user" },
    });
    if (session.agentId !== host.mainAgentId || session.state !== "active") throw new Error("会话不属于 Main 或已关闭");
    // 科研出处（语音/伴侣/对话）：走同一个逐窗口作用域注册表，渲染器不能自己声明一个项目。
    const submitProjectId = await resolveSubmitProject(params);
    const task = await host.kernel.tasks.create({
      goal,
      sessionId: session.id,
      inputArtifacts,
      ownerAgentId: host.mainAgentId as never,
      assignedAgentId: host.mainAgentId as never,
      ...(submitProjectId === undefined ? {} : { constraints: { projectId: submitProjectId } }),
      ctx: { actor: "user" },
    });
    void host.kernel.scheduler.tick({ actor: "system" }).catch(() => console.warn("Main task scheduling failed; inspect task status"));
    return { task: host.kernel.tasks.get(task.id) };
  }
  // ---- 科研计算主路径：计划 → 审批（绑定计划哈希）→ 沙箱执行 → 产物登记 ----
  // 项目出处与语音/伴侣同一条规则：由核心进程按窗口作用域校验，渲染器不能自己声明项目。
  if (method === "os.science.plan") {
    const host = await bootOsKernel();
    if (host.mainAgentId === undefined) throw new Error("Main Agent is unavailable");
    if (params.plan === null || typeof params.plan !== "object" || Array.isArray(params.plan)) throw new Error("无效的执行计划");
    const plan = params.plan as Record<string, unknown>;
    const planProjectId = typeof plan.projectId === "string" ? plan.projectId : "";
    if (planProjectId === "") throw new Error("执行计划必须声明所属项目");
    const scopedProjectId = await resolveSubmitProject({ ...params, projectId: planProjectId });
    if (scopedProjectId !== planProjectId) throw new Error("执行计划的项目与窗口绑定不一致");
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
    return host.kernel.science.plan({
      goal: stringField(params, "goal").trim(),
      plan: plan as never,
      ownerAgentId: host.mainAgentId as never,
      projectId: planProjectId,
      ...(sessionId === undefined ? {} : { sessionId: sessionId as never }),
      ctx: { actor: "user" },
    });
  }
  if (method === "os.science.approval.request") {
    const host = await bootOsKernel();
    return host.kernel.science.requestApproval(
      stringField(params, "taskId") as never,
      stringField(params, "reason"),
      { actor: "user" },
    );
  }
  if (method === "os.science.execute") {
    const host = await bootOsKernel();
    const taskId = stringField(params, "taskId");
    const summary = await host.kernel.science.execute(taskId as never, { actor: "user" });
    // 成功的执行把产物登记进科研图谱投影：闭环的最后一段链（安全计算 → 产物 → 科研关系）。
    // 入队而非直接写图：图里出现的产物一定来自已登记的事实。
    if (summary.status === "succeeded" && summary.artifacts.length > 0) {
      const { artifactUri } = await import("@xiling/os-domain");
      const service = await ensureResearch();
      const plan = host.kernel.tasks.get(taskId as never).constraints.science?.plan as { recipe?: { id: string; version: string } } | undefined;
      service.projectScienceArtifacts({
        projectId: summary.projectId,
        executionId: summary.executionId,
        adapterId: summary.adapterId,
        planHash: summary.planHash,
        recipe: plan?.recipe ?? { id: "unknown", version: "0" },
        artifacts: summary.artifacts.map((ref) => {
          const artifact = host.kernel.artifacts.get(ref.artifactId);
          return {
            name: artifact.name,
            uri: artifactUri(artifact.artifactId, artifact.version),
            sha256: artifact.storageRef.replace(/^blob:\/\//, ""),
            kind: artifact.type,
            mimeType: artifact.mimeType,
          };
        }),
      });
    }
    return summary;
  }
  if (method === "os.apps.manage") {
    const host = await bootOsKernel();
    const action = stringField(params, "action");
    const ctx = { actor: "user" as const };
    if (action === "list") return { apps: host.kernel.apps.list().filter((app) => app.state !== "removed") };
    if (action === "install") {
      const payload = params as { manifest?: unknown; approvedActions?: unknown };
      if (!Array.isArray(payload.approvedActions) || !payload.approvedActions.every((item) => typeof item === "string")) throw new Error("请审查应用权限");
      return { app: host.kernel.apps.install(payload.manifest as import("@xiling/os-domain").AppPackage, payload.approvedActions, ctx) };
    }
    const id = stringField(params, "id");
    if (action === "view") {
      return host.kernel.apps.view(id, stringField(params, "sessionId") as never, ctx);
    }
    if (action === "enable" || action === "disable") return { app: host.kernel.apps.setEnabled(id, action === "enable", ctx) };
    if (action === "remove") return { app: host.kernel.apps.remove(id, ctx) };
    if (action === "open") {
      const requestedSession = (params as { sessionId?: unknown }).sessionId;
      if (requestedSession !== undefined && typeof requestedSession !== "string") throw new Error("Invalid session id");
      const opened = host.kernel.apps.open(id, ctx, requestedSession as never);
      return { ...opened, sessions: host.kernel.sessions.listByAgent(opened.app.agentId).filter((session) => session.state === "active").map((session) => ({ id: session.id, title: session.title, startedAt: session.startedAt })) };
    }
    if (action === "submit") {
      const ids = params.artifactIds ?? [];
      if (!Array.isArray(ids) || ids.length > 20 || ids.some((id) => typeof id !== "string")) throw new Error("无效产物选择");
      const task = await host.kernel.apps.submit(id, stringField(params, "sessionId") as never, stringField(params, "goal"), ctx, ids);
      // Return the durable task promptly so UI remains usable while work is queued.
      void host.kernel.scheduler.tick({ actor: "system" }).catch((error: unknown) => console.warn("App task scheduling failed", error instanceof Error ? error.message : String(error)));
      return { task };
    }
    throw new Error("Unsupported App operation");
  }
  if (method === "os.task.cancel") {
    const host = await bootOsKernel();
    const taskId = stringField(params, "taskId") as never;
    const task = host.kernel.tasks.get(taskId);
    await host.kernel.tasks.cancel(taskId, "用户从任务中心取消", { actor: "user" });
    const cancelled = host.kernel.tasks.get(taskId);
    return { task: { ...cancelled, priority: cancelled.constraints.priority ?? 0 } };
  }
  if (method === "os.task.retry") {
    const host = await bootOsKernel();
    const task = await host.kernel.tasks.retry(stringField(params, "taskId") as never, { actor: "user" });
    await host.kernel.scheduler.tick({ actor: "system" });
    const retried = host.kernel.tasks.get(task.id);
    return { task: { ...retried, priority: retried.constraints.priority ?? 0 } };
  }
  if (method === "os.task.priority.set") {
    const host = await bootOsKernel();
    const priority = Number(params.priority);
    const task = host.kernel.tasks.updatePriority(stringField(params, "taskId") as never, priority, { actor: "user" });
    return { task: { ...task, priority: task.constraints.priority ?? 0 } };
  }
  if (method === "os.artifact.saveAnswer") {
    const host = await bootOsKernel();
    const artifact = await host.kernel.artifacts.saveAnswer(stringField(params, "messageId"), { actor: "user" });
    return { artifactId: artifact.artifactId };
  }
  if (method === "os.memory.manage") {
    const host = await bootOsKernel();
    const agentId = stringField(params, "agentId") as never;
    host.kernel.agents.get(agentId);
    if (params.action === "write") {
      const content = stringField(params, "content");
      if (!content.trim() || content.length > 6000) throw new Error("记忆内容须为 1–6000 字符");
      await host.kernel.memories.write({ agentId, type: "semantic", content, dedupeKey: content.trim(), provenance: { origin: "user", note: "用户在记忆管理器中明确保存" } }, { actor: "user" });
    } else if (params.action === "delete") {
      const id = stringField(params, "id");
      if (host.kernel.memories.get(id).agentId !== agentId) throw new Error("记忆不属于所选 Agent");
      await host.kernel.memories.delete(id, "用户删除", { actor: "user" });
    } else if (params.action !== "list") throw new Error("Unsupported memory operation");
    return { records: host.kernel.memories.listForReview(agentId) };
  }
  if (method === "os.runtime.enable") {
    const host = await bootOsKernel();
    // 产品唯一执行者是 Pi；这里只把它显式绑定给 Main，不接受任意运行时名。
    return { runtimeName: host.kernel.agents.enableNativeMain(host.researchHarness.executor, { actor: "user" }).runtimeName };
  }
  if (method === "os.artifact.import") {
    const host = await bootOsKernel();
    if (!host.mainAgentId) throw new Error("Main unavailable");
    const content = stringField(params, "content");
    const name = stringField(params, "name");
    if (content.length > 200_000 || name.length > 255) throw new Error("文本产物过大");
    const artifact = await host.kernel.artifacts.create({ name, content, mimeType: "text/plain", type: "generic", creatorAgentId: host.mainAgentId as never, metadata: { creationMode: "user-import", displayName: name }, ctx: { actor: "user" } });
    return { artifactId: artifact.artifactId };
  }
  if (method === "os.artifact.get") {
    const host = await bootOsKernel();
    const artifact = host.kernel.artifacts.get(stringField(params, "artifactId"));
    const content = host.kernel.artifacts.contentOf(artifact.artifactId);
    const limit = 200_000;
    return { artifact: {
      ...artifact,
      content: content.slice(0, limit),
      truncated: content.length > limit,
      lineage: host.kernel.artifacts.lineageOf(artifact.artifactId).map((item) => ({ artifactId: item.artifactId, version: item.version, name: item.name, type: item.type })),
    } };
  }
  if (method === "os.approval.decide") {
    const host = await bootOsKernel();
    const approvalId = stringField(params, "approvalId");
    const decision = stringField(params, "decision");
    if (decision !== "approved" && decision !== "rejected") throw new Error("decision must be approved or rejected");
    const approval = await host.kernel.approvals.decide(approvalId, decision, "desktop-user", { actor: "user" });
    for (const surface of host.kernel.ui.openSurfaces().filter((item) => item.taskId === approval.taskId && item.kind === "approval")) {
      await host.kernel.ui.close(surface.id, "approval-decided", { actor: "system" });
    }
    if (decision === "approved") await host.kernel.scheduler.tick({ actor: "system" });
    return { approvalId: approval.approvalId, state: approval.state, taskId: approval.taskId };
  }
  if (method === "os.ui.action") {
    const host = await bootOsKernel();
    const surfaceId = stringField(params, "surfaceId");
    const actionId = stringField(params, "actionId");
    const input = "input" in params ? params.input : undefined;
    const result = await host.kernel.ui.executeAction(surfaceId, actionId, input, { actor: "user" });
    return { surfaceId, actionId, command: result.command, accepted: true, result: result.result };
  }
  if (method === "os.models.list") {
    const host = await bootOsKernel();
    return {
      models: host.kernel.modelCatalog.list().map(modelView),
      agents: host.kernel.agents.list().map((agent) => ({
        agentId: agent.id, name: agent.name, main: agent.isMainAgent,
        ...(agent.modelPolicy.preferred === undefined ? {} : { preferred: agent.modelPolicy.preferred }),
      })),
    };
  }
  if (method === "os.models.register") {
    const host = await bootOsKernel();
    const providerId = stringField(params, "providerId").trim();
    const modelId = stringField(params, "modelId").trim();
    const displayName = typeof params.displayName === "string" && params.displayName.trim() !== "" ? params.displayName.trim() : undefined;
    const nativeInputs = modalityArray(params.nativeInputs, ["text", "image", "audio", "video"] as const, "nativeInputs");
    const nativeOutputs = modalityArray(params.nativeOutputs, ["text", "image"] as const, "nativeOutputs");
    const contextWindowTokens = Number(params.contextWindowTokens);
    if (!Number.isInteger(contextWindowTokens) || contextWindowTokens <= 0) throw new Error("上下文窗口必须是正整数");
    const knownProviderIds = new Set(["openai", "anthropic", "google", "openrouter", "deepseek", "xai", "mistral", "moonshotai", "zai", "groq"]);
    const known = knownProviderIds.has(providerId)
      ? (await import("@xiling/pi-runtime")).findKnownModelCatalogEntry(providerId as never, modelId)
      : undefined;
    const declaration = host.kernel.modelCatalog.register({
      address: { providerId, modelId },
      ...(displayName === undefined && known === undefined ? {} : { displayName: displayName ?? known?.name }),
      nativeInputs: known?.inputModalities ?? nativeInputs,
      nativeOutputs: known?.outputModalities?.filter((item): item is "text" | "image" => item === "text" || item === "image") ?? nativeOutputs,
      contextWindowTokens: known?.contextWindow ?? contextWindowTokens,
      ...(known?.maxOutputTokens === undefined ? {} : { maxOutputTokens: known.maxOutputTokens }),
      supportsToolUse: params.supportsToolUse === true,
      reasoning: known?.reasoning ?? params.reasoning === true,
      source: known === undefined ? "user-declared" : "provider-catalog",
      ...(known === undefined ? {} : { verifiedAt: new Date().toISOString() }),
    }, { actor: "user" });
    return { model: modelView(declaration) };
  }
  if (method === "os.agent.model.set") {
    const host = await bootOsKernel();
    const agentId = stringField(params, "agentId");
    const address = { providerId: stringField(params, "providerId"), modelId: stringField(params, "modelId") };
    if (host.kernel.modelCatalog.get(address) === undefined) throw new Error("所选模型尚未登记");
    const current = host.kernel.agents.get(agentId as never);
    const agent = host.kernel.agents.updateModelPolicy(current.id, { ...current.modelPolicy, preferred: address }, { actor: "user" });
    return { agent: { agentId: agent.id, name: agent.name, main: agent.isMainAgent, preferred: address } };
  }
  if (method === "os.credentials.list") {
    const credentials = await credentialsStore();
    return { providers: credentials.listStatus().filter((item) => item.category === "model").map(credentialView) };
  }
  if (method === "os.credentials.set") {
    const credentials = await credentialsStore();
    const providerId = stringField(params, "providerId");
    const rawValues = record(params.values);
    const values = Object.fromEntries(Object.entries(rawValues).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    return { provider: credentialView(await credentials.set(providerId as never, values)) };
  }
  if (method === "os.credentials.clear") {
    const credentials = await credentialsStore();
    return { provider: credentialView(await credentials.clear(stringField(params, "providerId") as never)) };
  }
  if (method === "os.credentials.test") {
    const credentials = await credentialsStore();
    const providerId = stringField(params, "providerId");
    const modelId = stringField(params, "modelId");
    if (!credentials.status(providerId as never).configured) throw new Error("请先保存完整连接信息");
    return testModelConnection(credentials, providerId, modelId);
  }
  if (method === "network.authorize") {
    // 插件 APP 需要声明 network.access 能力，网关校验通过才允许主进程代为出网
    caller(params, "network.access");
    return { authorized: true };
  }
  if (method === "apps.list") return store.listApps();
  if (method === "workspace.get") {
    const root = store.getWorkspaceRoot("primary");
    return root ? { id: root.id, label: root.label } : null;
  }
  if (method === "workspace.set") {
    const nativePath = stringField(params, "nativePath");
    const root = store.setWorkspaceRoot({
      id: "primary",
      label: stringField(params, "label"),
      nativePath,
    });
    await new WorkspaceFileService(root.id, root.nativePath).ensureRoot();
    watchedWorkspacePath = undefined;
    await ensureWorkspaceWatcher();
    return { id: root.id, label: root.label };
  }
  if (method === "workspace.list") {
    caller(params, "workspace.read");
    await ensureWorkspaceWatcher();
    const relativeDirectory = typeof params.relativeDirectory === "string" ? params.relativeDirectory : "";
    return workspaceService().list(relativeDirectory);
  }
  if (method === "workspace.page") {
    caller(params, "workspace.read");
    await ensureWorkspaceWatcher();
    const relativeDirectory = typeof params.relativeDirectory === "string" ? params.relativeDirectory : "";
    const offset = typeof params.offset === "number" ? params.offset : 0;
    const limit = typeof params.limit === "number" ? params.limit : 120;
    return workspaceService().page(relativeDirectory, offset, limit);
  }
  if (method === "workspace.search") {
    caller(params, "workspace.read");
    const limit = typeof params.limit === "number" ? params.limit : 100;
    return workspaceService().search(stringField(params, "query"), limit);
  }
  if (method === "workspace.mkdir") {
    caller(params, "workspace.write");
    const relativeDirectory = typeof params.relativeDirectory === "string" ? params.relativeDirectory : "";
    return workspaceService().createDirectory(relativeDirectory, stringField(params, "name"));
  }
  if (method === "workspace.rename") {
    caller(params, "workspace.write");
    return workspaceService().rename(stringField(params, "uri"), stringField(params, "name"));
  }
  if (method === "workspace.move") {
    caller(params, "workspace.write");
    const targetDirectoryUri = typeof params.targetDirectoryUri === "string" ? params.targetDirectoryUri : undefined;
    return workspaceService().move(stringField(params, "uri"), targetDirectoryUri);
  }
  if (method === "workspace.preview") {
    caller(params, "workspace.read");
    return workspaceService().preview(stringField(params, "uri"));
  }
  if (method === "workspace.import") {
    caller(params, "workspace.write");
    const sourcePaths = params.sourcePaths;
    if (!Array.isArray(sourcePaths) || sourcePaths.some((item) => typeof item !== "string")) {
      throw new Error("sourcePaths must be a string array");
    }
    const targetDirectoryUri = typeof params.targetDirectoryUri === "string" ? params.targetDirectoryUri : undefined;
    return workspaceService().importPaths(sourcePaths as string[], targetDirectoryUri);
  }
  if (method === "workspace.resolve") {
    caller(params, "workspace.read");
    return { nativePath: await workspaceService().nativePathForUri(stringField(params, "uri")) };
  }
  if (method === "workspace.resolveWrite") {
    caller(params, "workspace.write");
    const service = workspaceService();
    const nativePath = await service.nativePathForUri(stringField(params, "uri"));
    if (nativePath === service.rootPath) throw new Error("The workspace root cannot be moved to trash");
    return { nativePath };
  }
  if (method === "windows.list") return store.listWindows();
  if (method === "windows.save") {
    store.saveWindow(params.state as unknown as DesktopWindowState);
    return { saved: true };
  }
  if (method === "preferences.get") return store.getDesktopPreferences();
  if (method === "preferences.set") {
    const dockScale = Number(params.dockScale);
    if (!Number.isFinite(dockScale)) throw new Error("dockScale must be a finite number");
    return store.setDockScale(dockScale);
  }
  const exhaustive: never = method;
  throw new Error(`Unsupported method: ${String(exhaustive)}`);
}

function modalityArray<T extends string>(raw: unknown, allowed: readonly T[], field: string): T[] {
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string" || !allowed.includes(item as T))) throw new Error(`${field} 包含无效模态`);
  return [...new Set(raw as T[])];
}

function modelView(model: import("@xiling/os-domain").ModelCapabilityDeclaration) {
  return {
    providerId: model.address.providerId, modelId: model.address.modelId,
    ...(model.displayName === undefined ? {} : { displayName: model.displayName }),
    nativeInputs: [...model.nativeInputs], nativeOutputs: [...model.nativeOutputs],
    contextWindowTokens: model.contextWindowTokens,
    supportsToolUse: model.supportsToolUse === true, reasoning: model.reasoning === true, source: model.source,
    ...(model.verifiedAt === undefined ? {} : { verifiedAt: model.verifiedAt }),
  };
}

function credentialView(provider: {
  id: string; title: string; description: string; configured: boolean; source: "environment" | "local" | "none";
  configuredFields: string[]; fields: Array<{ id: string; label: string; secret: boolean; placeholder: string }>;
}) {
  return {
    id: provider.id, title: provider.title, description: provider.description,
    configured: provider.configured, source: provider.source, configuredFields: [...provider.configuredFields],
    fields: provider.fields.map((field) => ({ id: field.id, label: field.label, secret: field.secret, placeholder: field.placeholder })),
  };
}

async function testModelConnection(credentials: import("@xiling/credentials").CredentialStore, providerId: string, modelId: string) {
  const supported = ["openai", "anthropic", "google", "openrouter", "deepseek", "xai", "mistral", "moonshotai", "zai", "groq", "custom"];
  if (!supported.includes(providerId)) throw new Error("该提供商暂不支持连通测试");
  const { PiRuntimeAdapter, createLiveRoute } = await import("@xiling/pi-runtime");
  const apiKey = credentials.get(providerId as never, "apiKey") ?? (providerId === "custom" ? "xiling-local" : undefined);
  if (!apiKey) throw new Error("缺少 API Key");
  let custom: { baseUrl: string; apiStyle: "openai-completions" | "openai-responses"; displayName?: string } | undefined;
  if (providerId === "custom") {
    const baseUrl = credentials.get("custom", "baseUrl");
    const apiStyle = credentials.get("custom", "apiStyle");
    if (!baseUrl || (apiStyle !== "openai-completions" && apiStyle !== "openai-responses")) throw new Error("自定义连接缺少有效 Base URL 或 API 风格");
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Base URL 必须使用 http 或 https");
    const displayName = credentials.get("custom", "displayName");
    custom = { baseUrl: parsed.toString().replace(/\/$/, ""), apiStyle, ...(displayName ? { displayName } : {}) };
  }
  const started = Date.now(); let text = ""; let failure = "";
  const route = createLiveRoute(providerId as never, modelId, apiKey, custom);
  const runtime = new PiRuntimeAdapter({ sessionId: `desktop-connection-${randomUUID()}`, systemPrompt: "Reply with exactly OK.", route, reasoning: "off" });
  const unsubscribe = runtime.subscribe((event) => {
    if (event.type === "message.delta") text += event.delta;
    if (event.type === "session.error") failure = event.message;
  });
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      runtime.prompt("Reply with exactly OK."),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => { runtime.abort(); reject(new Error("连接测试超过 20 秒")); }, 20_000); }),
    ]);
  } catch (error) { failure = error instanceof Error ? error.message : String(error); }
  finally { if (timeout !== undefined) clearTimeout(timeout); unsubscribe(); }
  return {
    ok: text.trim() !== "" && failure === "", providerId, modelId, latencyMs: Date.now() - started,
    message: failure === "" ? `连接成功，模型返回：${text.trim().slice(0, 80)}` : humanizeConnectionFailure(failure.replaceAll(apiKey, "[已隐藏]")),
    testedAt: new Date().toISOString(),
  };
}

function humanizeConnectionFailure(message: string): string {
  const lower = message.toLowerCase();
  if (/\b401\b|unauthorized|invalid api key/.test(lower)) return "认证失败：API Key 无效、已过期或没有访问权限。";
  if (/\b403\b|not available in your region/.test(lower)) return "服务拒绝访问：请检查区域限制或账户权限。";
  if (/\b404\b|model not found|unknown model/.test(lower)) return "服务可达，但模型名称不存在或当前账户不可用。";
  if (/\b429\b|rate limit|quota/.test(lower)) return "服务可达，但当前配额不足或请求过于频繁。";
  return message.slice(0, 500);
}

parentPort.postMessage({
  type: "core-ready",
  protocolVersion: 1,
  startedAt: new Date().toISOString(),
});

parentPort.on("message", (event) => {
  const message = event.data as CoreRequest | { type?: string } | undefined;
  if (message?.type === "shutdown") {
    stopWorkspaceWatcher?.();
    store.close();
    void (osKernelPromise ? osKernelPromise.then((host) => host.shutdown()).catch(() => undefined) : Promise.resolve())
      .then(async () => {
        await research?.closeAll();
        parentPort.postMessage({ type: "core-stopped" });
        process.exit(0);
      });
    return;
  }
  if (message?.type !== "core-request") return;
  const request = message as CoreRequest;
  void dispatch(request.method, request.params)
    .then((result) => {
      parentPort.postMessage({ type: "core-response", id: request.id, ok: true, result } satisfies CoreResponse);
    })
    .catch((error: unknown) => {
      parentPort.postMessage({
        type: "core-response",
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : "Unknown Core error",
      } satisfies CoreResponse);
    });
});
