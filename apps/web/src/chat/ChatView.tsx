import { useCallback, useEffect, useMemo, useRef, useState, type FC } from "react";
import type { AgentInputAttachment, ChatMessageRecord, ContextAssemblyTrace, ResearchProject, ModelCatalogEntry, ModelProviderId, ModelRuntimeStatus, ProjectItem, WikiPageDetail } from "@xiling/contracts";
import { FREE_EXPLORATION_PROJECT_ID } from "@xiling/contracts";
import type { ProjectResearchWorkflow } from "@xiling/domain-ocean";
import { useConversations } from "../workspace/ConversationContext.js";
import { ResearchWorkflowCard } from "./ResearchWorkflowCard.js";
import { runResearchTurn } from "../lib/research-session-client.js";
import { formatAttachmentSize, nativeImageUpload, NATIVE_IMAGE_ACCEPT, readNativeImages, type PendingNativeImage } from "../lib/native-image-input.js";
import { ModelCapsule, type CapsuleRoute } from "../components/ModelCapsule.js";
import { apiJson, jsonInit } from "../lib/api-client.js";
import { useToast } from "../components/ui/toast.js";
import { ArtifactViewer } from "../components/ArtifactViewer.js";
import { ScientificMarkdown } from "../components/ScientificMarkdown.js";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePartPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  useMessagePartText,
  type ThreadMessageLike,
} from "@assistant-ui/react";

type UiMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  status?: "running" | "complete" | "cancelled";
  sourceEntryId?: string;
  runId?: string;
  attachments?: Array<AgentInputAttachment & { url: string }>;
};
const welcomeMessage = (project: ResearchProject): UiMessage => ({ id: `welcome-${project.id}`, role: "assistant", text: project.id === FREE_EXPLORATION_PROJECT_ID ? "已进入「自由探索」模式。你可以从任何科学领域提出研究问题，开展文献与证据检索、数据和方法规划、计算分析或复现审查。需要学科专用连接器、校验规则或执行环境时，请创建或切换到启用相应领域模块的项目；涉及写入、下载或计算的操作仍需你确认。" : `已进入项目“${project.name}”。当前研究问题：${project.researchQuestion}`, status: "complete" });
type ToolActivity = { callId: string; name: string; status: "running" | "complete" | "failed" };

const CHOICE_FENCE_COMPLETE = /```xiling-choices\s*\n([\s\S]*?)```/g;
const CHOICE_FENCE_PARTIAL = /```xiling-choices[\s\S]*$/;
const stripChoiceFence = (text: string) => text.replace(CHOICE_FENCE_COMPLETE, "").replace(CHOICE_FENCE_PARTIAL, "").trimEnd();

const convertMessage = (message: UiMessage): ThreadMessageLike => ({
  id: message.id,
  role: message.role,
  content: [{ type: "text", text: message.role === "assistant" ? stripChoiceFence(message.text) : message.text }, ...(message.attachments ?? []).map((attachment) => ({ type: "image" as const, image: attachment.url, filename: attachment.name }))],
  ...(message.role === "assistant"
    ? {
        status:
          message.status === "running"
            ? ({ type: "running" } as const)
            : message.status === "cancelled"
              ? ({ type: "incomplete", reason: "cancelled" } as const)
              : ({ type: "complete", reason: "stop" } as const),
      }
    : {}),
});

const TextPart: FC = () => <ScientificMarkdown text={useMessagePartText().text} />;
const ImagePart: FC = () => <MessagePartPrimitive.Image className="chat-message-image" />;
const UserMessage: FC = () => (
  <MessagePrimitive.Root className="aui-message user">
    <small>你</small><MessagePrimitive.Parts components={{ Text: TextPart, Image: ImagePart }} />
  </MessagePrimitive.Root>
);
const AssistantMessage: FC = () => (
  <MessagePrimitive.Root className="aui-message assistant">
    <small>汐灵</small><MessagePrimitive.Parts components={{ Text: TextPart }} />
  </MessagePrimitive.Root>
);

function extractText(content: readonly { type: string; text?: string }[]): string {
  return content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
}

export function ChatView({ project }: { project: ResearchProject }) {
  const { sessions, activeSessionId, ensureSession, refreshSessions } = useConversations();
  const visibleSessionRef = useRef(activeSessionId);
  visibleSessionRef.current = activeSessionId;
  const runAbortRef = useRef<AbortController | null>(null);
  // 当前运行所属会话：会话恢复 effect 据此避免用耐久记录覆盖进行中的乐观流式消息
  const runSessionIdRef = useRef<string | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const [messages, setMessages] = useState<UiMessage[]>(() => [welcomeMessage(project)]);
  const [running, setRunning] = useState(false);
  const [tools, setTools] = useState<ToolActivity[]>([]);
  const [workflows, setWorkflows] = useState<ProjectResearchWorkflow[]>([]);
  const [saveStatus, setSaveStatus] = useState("");
  const [pendingSaveTarget, setPendingSaveTarget] = useState<"task" | "wiki">();
  const [modelRuntime, setModelRuntime] = useState<ModelRuntimeStatus>();
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogEntry[]>([]);
  const [configuredModelProviders, setConfiguredModelProviders] = useState<ModelProviderId[]>([]);
  const [pendingImages, setPendingImages] = useState<PendingNativeImage[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [contextTrace, setContextTrace] = useState<ContextAssemblyTrace>();
  const [artifactWidth, setArtifactWidth] = useState(560);
  const [artifactOpen, setArtifactOpen] = useState(true);
  const [artifactExpanded, setArtifactExpanded] = useState(false);
  const [workbenchWidth, setWorkbenchWidth] = useState(0);
  const manualArtifactOpenRef = useRef(false);
  const seenArtifactCountRef = useRef(0);
  const workbenchRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false;
    const inFlightRunForSession = () => runSessionIdRef.current === activeSessionId && runAbortRef.current !== null;
    // 新会话由 submitPrompt 的 ensureSession 创建时，本 effect 会与乐观插入竞态；
    // 该会话存在进行中的运行时，跳过恢复性覆盖，由运行结束后的耐久重取接管。
    const isRunSession = runSessionIdRef.current !== null && runSessionIdRef.current === activeSessionId;
    if (!isRunSession) {
      runAbortRef.current = null;
      setRunning(false);
    }
    if (activeSessionId) {
      setMessages([welcomeMessage(project)]);
      void fetch(`/api/v1/chat-sessions/${encodeURIComponent(activeSessionId)}/messages`).then(async (response) => {
        if (!response.ok) throw new Error(`会话消息加载失败：${response.status}`);
        const records = await response.json() as ChatMessageRecord[];
        const restored: UiMessage[] = [welcomeMessage(project), ...records.map((record) => ({ id: record.id, role: record.role, text: record.text, status: record.status, sourceEntryId: record.id, ...(record.attachments?.length ? { attachments: record.attachments.map((attachment) => ({ ...attachment, url: `/api/agent-center/attachments/${encodeURIComponent(attachment.id)}?projectId=${encodeURIComponent(project.id)}` })) } : {}) }))];
        if (!cancelled && visibleSessionRef.current === activeSessionId && !inFlightRunForSession()) setMessages(restored);
      }).catch(() => { if (!cancelled && !inFlightRunForSession()) setMessages([welcomeMessage(project), { id: `restore-error-${activeSessionId}`, role: "assistant", text: "这段对话暂时无法恢复，请稍后重试。", status: "cancelled" }]); });
    } else {
      setMessages([welcomeMessage(project)]);
    }
    setTools([]); setContextTrace(undefined); setSaveStatus(""); setPendingImages([]); setAttachmentError(""); setArtifactExpanded(false); manualArtifactOpenRef.current = false; seenArtifactCountRef.current = 0;
    return () => { cancelled = true; };
  }, [project.id, activeSessionId]);
  useEffect(() => {
    if (!activeSessionId) { setWorkflows([]); return; }
    void fetch(`/api/v1/research-workflows?projectId=${encodeURIComponent(project.id)}&sessionId=${encodeURIComponent(activeSessionId)}`).then((response) => response.ok ? response.json() : []).then((items) => setWorkflows(items as ProjectResearchWorkflow[]));
  }, [project.id, activeSessionId]);
  const [providerTitles, setProviderTitles] = useState<Record<string, string>>({});
  useEffect(() => {
    void fetch("/api/settings/models").then((response) => response.json()).then((body: { runtime: ModelRuntimeStatus; catalog: ModelCatalogEntry[]; configuredProviderIds: ModelProviderId[] }) => { setModelRuntime(body.runtime); setModelCatalog(body.catalog); setConfiguredModelProviders(body.configuredProviderIds); });
    void fetch("/api/settings/providers").then((response) => response.json()).then((providers: Array<{ id: string; title: string }>) => setProviderTitles(Object.fromEntries(providers.map((provider) => [provider.id, provider.title]))));
  }, []);
  useEffect(() => {
    const clampWidth = () => {
      const width = workbenchRef.current?.getBoundingClientRect().width;
      if (width) { setWorkbenchWidth(width); setArtifactWidth((current) => Math.max(360, Math.min(current, Math.max(360, width - 520)))); }
    };
    clampWidth();
    const observer = new ResizeObserver(clampWidth); if (workbenchRef.current) observer.observe(workbenchRef.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { const saved = Number(localStorage.getItem(`xiling:artifact-width:${project.id}`)); if (Number.isFinite(saved) && saved >= 360) setArtifactWidth(saved); }, [project.id]);
  const artifactCount = useMemo(() => workflows.reduce((count, workflow) => count + (workflow.run?.artifactUris?.length ?? 0), 0), [workflows]);
  useEffect(() => {
    if (artifactCount > seenArtifactCountRef.current) setArtifactOpen(true);
    seenArtifactCountRef.current = artifactCount;
  }, [artifactCount]);
  const lastCompleteAssistantText = useMemo(() => [...messages].reverse().find((message) => message.role === "assistant" && message.status === "complete")?.text ?? "", [messages]);
  const choiceOptions = useMemo(() => {
    if (running) return [];
    const match = /```xiling-choices\s*\n([\s\S]*?)```/.exec(lastCompleteAssistantText);
    if (!match) return [];
    try {
      const parsed = JSON.parse(match[1]!) as unknown;
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).slice(0, 4) : [];
    } catch { return []; }
  }, [running, lastCompleteAssistantText]);

  const submitPrompt = useCallback(async (prompt: string, images: PendingNativeImage[]) => {
    {
      const userId = crypto.randomUUID();
      const assistantId = crypto.randomUUID();
      const session = await ensureSession(prompt);
      runSessionIdRef.current = session.id;
      visibleSessionRef.current = session.id;
      setMessages((current) => [
        ...current,
        { id: userId, role: "user", text: prompt, ...(images.length ? { attachments: images.map((image) => ({ id: image.localId, name: image.name, modality: "image", mimeType: image.mimeType, size: image.size, sha256: "pending", url: image.previewUrl })) } : {}) },
        { id: assistantId, role: "assistant", text: "", status: "running" },
      ]);
      setRunning(true);
      setAttachmentError("");
      const controller = new AbortController();
      runAbortRef.current = controller;
      let streamedText = "";
      const updateVisibleMessages = (updater: (current: UiMessage[]) => UiMessage[]) => {
        if (visibleSessionRef.current === session.id) setMessages(updater);
      };

      try {
        for await (const event of runResearchTurn({ projectId: project.id, sessionId: session.id, prompt, ...(images.length ? { attachments: images.map(nativeImageUpload) } : {}), signal: controller.signal })) {
            if (visibleSessionRef.current !== session.id) continue;
            if (event.type === "run.accepted") {
              setPendingImages([]);
              updateVisibleMessages((current) => current.map((item) => item.id === userId ? { ...item, sourceEntryId: event.userEntryId, runId: event.runId, ...(event.attachments?.length ? { attachments: event.attachments.map((attachment) => ({ ...attachment, url: `/api/agent-center/attachments/${encodeURIComponent(attachment.id)}?projectId=${encodeURIComponent(project.id)}` })) } : {}) } : item.id === assistantId ? { ...item, runId: event.runId } : item));
            }
            if (event.type === "entry.persisted" && event.kind === "assistant") updateVisibleMessages((current) => current.map((item) => item.id === assistantId ? { ...item, sourceEntryId: event.entryId, runId: event.runId } : item));
            if (event.type === "context.ready") setContextTrace(event.trace);
            if (event.type === "message.delta" && event.delta) {
              streamedText += event.delta;
              updateVisibleMessages((current) => current.map((item) => item.id === assistantId ? { ...item, text: item.text + event.delta } : item));
            }
            if (event.type === "tool.started") setTools((current) => [...current.filter((item) => item.callId !== event.callId), { callId: event.callId, name: event.toolName, status: "running" }]);
            if (event.type === "tool.finished") {
              setTools((current) => current.map((item) => item.callId === event.callId ? { ...item, status: "complete" } : item));
            }
            if (event.type === "workflow.projected") {
              const response = await fetch(`/api/v1/research-workflows?projectId=${encodeURIComponent(project.id)}&sessionId=${encodeURIComponent(session.id)}`);
              if (response.ok) setWorkflows(await response.json() as ProjectResearchWorkflow[]);
            }
            if (event.type === "tool.failed") setTools((current) => current.map((item) => item.callId === event.callId ? { ...item, status: "failed" } : item));
            if (event.type === "session.error") throw new Error(event.message || "模型调用失败");
        }
        if (!streamedText.trim()) throw new Error("模型没有返回文本，请检查模型 ID 或使用“测试连接”诊断。 ");
        updateVisibleMessages((current) => current.map((item) => item.id === assistantId ? { ...item, status: "complete" } : item));
      } catch (error) {
        const cancelled = error instanceof DOMException && error.name === "AbortError";
        const reason = error instanceof Error ? error.message : "请求失败";
        updateVisibleMessages((current) => current.map((item) => item.id === assistantId ? { ...item, text: item.text || (cancelled ? "已取消" : `连接失败：${reason}`), status: "cancelled" } : item));
      } finally {
        if (runAbortRef.current === controller) runAbortRef.current = null;
        runSessionIdRef.current = null;
        if (visibleSessionRef.current === session.id) setRunning(false);
        await refreshSessions(session.id);
            if (visibleSessionRef.current === session.id) {
          try {
            const response = await fetch(`/api/v1/chat-sessions/${encodeURIComponent(session.id)}/messages`);
            if (response.ok) {
              const records = await response.json() as ChatMessageRecord[];
              setMessages([welcomeMessage(project), ...records.map((record) => ({ id: record.id, role: record.role, text: record.text, status: record.status, sourceEntryId: record.id, ...(record.attachments?.length ? { attachments: record.attachments.map((attachment) => ({ ...attachment, url: `/api/agent-center/attachments/${encodeURIComponent(attachment.id)}?projectId=${encodeURIComponent(project.id)}` })) } : {}) }))]);
            }
          } catch {
            // The streamed transcript remains visible; the next session load retries the durable read.
          }
        }
      }
    }
  }, [project, ensureSession, refreshSessions, modelRuntime]);
  const runtime = useExternalStoreRuntime({
    messages,
    isRunning: running,
    convertMessage,
    onNew: async (message) => { await submitPrompt(extractText(message.content), pendingImages); },
    onCancel: async () => runAbortRef.current?.abort(),
  });

  const nativeImageEnabled = Boolean(modelRuntime?.primary?.selectedModel?.inputModalities.includes("image"));
  const attachmentTitle = nativeImageEnabled ? "添加模型原生图像输入" : modelRuntime?.primary ? "当前主模型未声明原生图像输入" : "请先在发送按钮左侧选择模型";
  const addImages = async (files: FileList | null) => {
    if (!files?.length || !nativeImageEnabled) return;
    try { setPendingImages(await readNativeImages(files, pendingImages)); setAttachmentError(""); }
    catch (error) { setAttachmentError(error instanceof Error ? error.message : String(error)); }
  };

  const { push } = useToast();
  const commitPrimaryModel = async (route: CapsuleRoute | null) => {
    if (!route) return;
    const modalities = modelCatalog.find((model) => model.providerId === route.providerId && model.id === route.modelId)?.inputModalities ?? ["text"];
    try {
      const next = await apiJson<ModelRuntimeStatus>("/api/settings/models", jsonInit("PUT", { primary: { providerId: route.providerId, modelId: route.modelId, reasoning: route.reasoning, inputModalities: modalities }, roleRoutes: modelRuntime?.roleRoutes ?? {} }));
      setModelRuntime(next);
      push({ title: `主模型已切换为 ${next.primary?.selectedModel?.name ?? route.modelId}`, tone: "success" });
    } catch (error) { push({ title: "主模型保存失败", description: error instanceof Error ? error.message : String(error), tone: "danger" }); }
  };

  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant" && message.id !== `welcome-${project.id}` && message.status === "complete" && message.text.trim());
  const persistResponse = async (target: "task" | "wiki") => {
    if (!lastAssistant) return;
    setSaveStatus("正在保存…");
    const title = `Agent 研究记录 · ${new Date().toLocaleString("zh-CN", { hour12: false })}`;
    try {
      if (target === "task") {
        const provenance = lastAssistant.runId ? `\n\n来源 Agent Run：${lastAssistant.runId}` : "";
        const response = await fetch("/api/v1/project-items", jsonInit("POST", { projectId: project.id, kind: "task", title, notes: `${lastAssistant.text.slice(0, 1_700)}${provenance}` }));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        await response.json() as ProjectItem;
      } else if (target === "wiki") {
        const provenance = lastAssistant.runId ? `\n\n---\n\n> 来源：Agent Run \`${lastAssistant.runId}\`。发布前请核对证据与结论。` : "";
        const response = await fetch("/api/v1/wiki/pages", jsonInit("POST", { projectId: project.id, title, markdown: `# ${title}\n\n${lastAssistant.text}${provenance}` }));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        await response.json() as WikiPageDetail;
      }
      setSaveStatus(target === "task" ? "已保存到项目任务" : "已创建 Wiki 页面");
      setPendingSaveTarget(undefined);
    } catch (cause) { setSaveStatus(`保存失败：${cause instanceof Error ? cause.message : String(cause)}`); }
  };

  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const workbench = workbenchRef.current;
    if (!workbench) return;
    const move = (pointer: PointerEvent) => {
      const bounds = workbench.getBoundingClientRect();
      const next = Math.max(360, Math.min(bounds.width - 520, bounds.right - pointer.clientX));
      setArtifactWidth(next); localStorage.setItem(`xiling:artifact-width:${project.id}`, String(next));
    };
    const stop = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", stop);
      document.body.classList.remove("resizing-split");
    };
    document.body.classList.add("resizing-split");
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", stop);
  };

  const artifactDocked = workbenchWidth >= 1_040 && !artifactExpanded;

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className={`chat-workbench ${artifactExpanded ? "artifact-expanded" : ""} ${artifactOpen && !artifactDocked && !artifactExpanded ? "artifact-overlay" : ""}`} ref={workbenchRef} style={{ gridTemplateColumns: artifactExpanded || !artifactOpen || !artifactDocked ? "minmax(0, 1fr)" : `minmax(520px, 1fr) 7px ${artifactWidth}px` }}>
        <ThreadPrimitive.Root className="chat-view">
          <div className="chat-heading"><div><h1>{activeSession?.title ?? "新对话"}</h1></div><div className="chat-heading-actions">{!artifactOpen ? <button onClick={() => { manualArtifactOpenRef.current = true; setArtifactOpen(true); }}>打开产物面板</button> : null}</div></div>
            <ThreadPrimitive.Viewport className="aui-thread">
              <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
              {!running && choiceOptions.length ? <div className="chat-choice-chips" role="group" aria-label="可选操作">{choiceOptions.map((label) => <button key={label} onClick={() => void submitPrompt(label, [])}>{label}</button>)}</div> : null}
              {running ? <div className="chat-running-indicator" role="status" aria-live="polite"><i /><span>{(() => { const active = [...tools].reverse().find((tool) => tool.status === "running"); return active ? `正在处理 · 调用 ${active.name}…` : tools.length ? `正在处理 · ${tools.filter((item) => item.status === "complete").length}/${tools.length} 个工具已完成…` : "正在思考…"; })()}</span></div> : null}
              {workflows.length ? <div className="chat-workflows">{workflows.map((workflow) => <ResearchWorkflowCard key={workflow.id} workflow={workflow} onChange={(updated) => setWorkflows((current) => current.map((item) => item.id === updated.id ? updated : item))} />)}</div> : null}
            </ThreadPrimitive.Viewport>

            {contextTrace?.degradations.length ? <div className="chat-context-notice">{contextTrace.degradations.map((item) => <span key={item}>{item}</span>)}</div> : null}
            {tools.length ? <div className="chat-tool-trace">{tools.map((tool) => <span className={tool.status} key={tool.callId}>{tool.status === "complete" ? "✓" : tool.status === "failed" ? "×" : "↻"} {tool.name}</span>)}</div> : null}
            {lastAssistant ? <div className="chat-save-actions"><button onClick={() => setPendingSaveTarget("task")}>保存为任务</button><button onClick={() => setPendingSaveTarget("wiki")}>写入 Wiki</button>{saveStatus ? <small>{saveStatus}</small> : null}</div> : null}
            <ComposerPrimitive.Root className="chat-composer">
            {pendingImages.length ? <div className="native-attachment-tray">{pendingImages.map((image) => <div key={image.localId}><img src={image.previewUrl} alt="" /><span><b>{image.name}</b><small>{formatAttachmentSize(image.size)} · 原生图像</small></span><button type="button" aria-label={`移除 ${image.name}`} onClick={() => setPendingImages((current) => current.filter((item) => item.localId !== image.localId))}>×</button></div>)}</div> : null}
            {attachmentError ? <div className="native-attachment-error">{attachmentError}</div> : null}
            <ComposerPrimitive.Input placeholder="询问数据、文献或当前科研图选择…" />
            <input ref={imageInputRef} className="native-file-input" type="file" accept={NATIVE_IMAGE_ACCEPT} multiple onChange={(event) => { void addImages(event.currentTarget.files); event.currentTarget.value = ""; }} />
            <div className="composer-tools"><button type="button" aria-label="添加图像" disabled={!nativeImageEnabled || running} title={attachmentTitle} onClick={() => imageInputRef.current?.click()}>＋</button><span>{nativeImageEnabled ? "原生图像可用" : "仅文字输入"}</span><div className="composer-model-slot"><ModelCapsule value={modelRuntime?.primary ? { providerId: modelRuntime.primary.providerId, modelId: modelRuntime.primary.modelId, reasoning: modelRuntime.primary.reasoning } : undefined} catalog={modelCatalog} configuredProviders={configuredModelProviders.map((id) => ({ id, title: providerTitles[id] ?? id }))} disabled={running} onCommit={(route) => void commitPrimaryModel(route)} /></div><div className="composer-actions"><ComposerPrimitive.Send aria-label="发送">↑</ComposerPrimitive.Send><ComposerPrimitive.Cancel aria-label="取消">■</ComposerPrimitive.Cancel></div></div>
            </ComposerPrimitive.Root>
        </ThreadPrimitive.Root>
        {artifactOpen && artifactDocked ? <div className="split-resizer" role="separator" aria-label="调整 Artifact 面板宽度" aria-orientation="vertical" onPointerDown={beginResize}><i /></div> : null}
        {artifactOpen ? <ArtifactViewer projectId={project.id} workflows={workflows} expanded={artifactExpanded} onToggleExpanded={() => setArtifactExpanded((value) => !value)} onClose={() => { setArtifactOpen(false); setArtifactExpanded(false); }} /> : null}
        {pendingSaveTarget && lastAssistant ? <div className="chat-publish-dialog" role="dialog" aria-modal="true" aria-label="确认沉淀 Agent 回答"><div><header><div><small>{pendingSaveTarget === "wiki" ? "WIKI DRAFT" : "PROJECT TASK DRAFT"}</small><h2>确认写入内容</h2></div><button aria-label="关闭" onClick={() => setPendingSaveTarget(undefined)}>×</button></header><p className="chat-publish-warning">模型回答不是证据。请先确认正文、当前科研图上下文和来源 Run，再创建正式记录。</p><div className="chat-publish-preview"><pre>{lastAssistant.text}</pre></div><dl><div><dt>目标</dt><dd>{pendingSaveTarget === "wiki" ? "新 Wiki 页面与不可变首版" : "项目任务"}</dd></div><div><dt>项目</dt><dd>{project.name}</dd></div><div><dt>Agent Run</dt><dd>{lastAssistant.runId ?? "无可用 Run ID"}</dd></div><div><dt>科研上下文</dt><dd>{activeSession?.canvasContext?.activeNodeId ?? "项目研究问题"}</dd></div></dl><footer><button onClick={() => setPendingSaveTarget(undefined)}>取消</button><button className="primary" onClick={() => void persistResponse(pendingSaveTarget)}>确认写入</button></footer></div></div> : null}
      </div>
    </AssistantRuntimeProvider>
  );
}
