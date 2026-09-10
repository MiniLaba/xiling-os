import { StrictMode, Suspense, lazy, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SaveAnswer } from "./apps/save-answer.js";
import { ArtifactInputs, ArtifactResult } from "./apps/artifact-inputs.js";
import { selectSession, selectedSession } from "./apps/session-selection.js";
import { VoiceControls, VoiceSettings } from "./apps/voice.js";
import { fitWindowToViewport, mergeRestoredWindows, nextWindowToFocus } from "../src/windowing/window-model.js";
const LiteratureWorkbenchApp = lazy(async () => ({ default: (await import("./apps/literature.js")).LiteratureWorkbenchApp }));
const TaskCenterApp = lazy(async () => ({ default: (await import("./apps/task-center.js")).TaskCenterApp }));
const AgentApps = lazy(async () => ({ default: (await import("./apps/agent-apps.js")).AgentApps }));
const AgentSessionWindow = lazy(async () => ({ default: (await import("./apps/agent-session.js")).AgentSessionWindow }));
const MemoryManager = lazy(async () => ({ default: (await import("./apps/memory-manager.js")).MemoryManager }));

type WindowStatus = "open" | "minimized" | "maximized";

interface PersistedWindowState {
  id: string;
  appId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  state: WindowStatus;
  payload: Record<string, unknown>;
  updatedAt: string;
}

interface WorkspaceRoot {
  id: string;
  label: string;
}

interface WorkspaceEntry {
  uri: string;
  name: string;
  kind: "file" | "directory";
  size: number | null;
  modifiedAt: string;
}

interface WorkspacePreview {
  uri: string;
  name: string;
  kind: "text" | "image" | "unsupported";
  size: number;
  modifiedAt: string;
  text?: string;
  dataUrl?: string;
  truncated: boolean;
}

interface WorkspacePage {
  entries: WorkspaceEntry[];
  nextOffset: number;
  hasMore: boolean;
}

export interface OsSnapshot {
  mainAgentId?: string;
  runtimeName?: string;
  sessions: Array<{ id: string; agentId: string; title?: string; state: string; taskIds: string[]; startedAt: string; lastActiveAt: string; endedAt?: string }>;
  tasks: Array<{ id: string; sessionId?: string; goal: string; state: string; canCancelRunning?: boolean; statusReason?: string; parentTaskId?: string; retryOfTaskId?: string; assignedAgentId?: string; assignedAgentName?: string; delegationState?: string; outputArtifacts: Array<{ artifactId: string; version: number }>; createdAt: string; completedAt?: string; priority?: number; activatedPluginIds?: string[]; contextTokens?: number; model?: { providerId: string; modelId: string; capabilitySource: string } }>;
  preferredModel?: { providerId: string; modelId: string };
  messages: Array<{ id: string; taskId: string; role: string; text: string; createdAt: string }>;
  approvals: Array<{ approvalId: string; taskId: string; action: string; resource: string; reason?: string; state: string; createdAt: string }>;
  surfaces: Array<{ id: string; taskId?: string; kind: string; componentVersion: number; title?: string; data: unknown; actions: Array<{ id: string; label: string; command: string; inputSchema?: unknown }> }>;
  artifacts: Array<{ artifactId: string; taskId?: string; name: string; type: string; mimeType: string; version: number; storageRef: string }>;
}

interface OsModelView {
  providerId: string; modelId: string; displayName?: string;
  nativeInputs: Array<"text" | "image" | "audio" | "video">;
  nativeOutputs: Array<"text" | "image">;
  contextWindowTokens: number; supportsToolUse: boolean; reasoning: boolean; source: string;
}

interface OsAgentModelView {
  agentId: string; name: string; main: boolean; preferred?: { providerId: string; modelId: string };
}

interface CredentialProviderView {
  id: string; title: string; description: string; configured: boolean; source: "environment" | "local" | "none";
  configuredFields: string[]; fields: Array<{ id: string; label: string; secret: boolean; placeholder: string }>;
}

interface ModelConnectionTestView {
  ok: boolean; providerId: string; modelId: string; latencyMs: number; message: string; testedAt: string;
}

interface DesktopBridge {
  researchKnowledge(payload: Record<string, unknown>): Promise<import("../src/core/research-types.js").ResearchKnowledgeResult>;
  enableNativeMain(): Promise<{ runtimeName: string }>;
  manageMemories(payload: Record<string, unknown>): Promise<{ records: Array<{ id: string; agentId: string; content: unknown; createdAt: string; provenance: unknown }> }>;
  manageAgentApps(payload: Record<string, unknown>): Promise<unknown>;
  getOsSnapshot(): Promise<OsSnapshot>;
  submitGoal(goal: string, sessionId?: string, artifactIds?: string[]): Promise<{ task: OsSnapshot["tasks"][number] }>;
  tasks: {
    cancel(taskId: string): Promise<{ task: OsSnapshot["tasks"][number] }>;
    retry(taskId: string): Promise<{ task: OsSnapshot["tasks"][number] }>;
    setPriority(taskId: string, priority: number): Promise<{ task: OsSnapshot["tasks"][number] }>;
    onChanged(listener: (event: { seq: number; eventType: string }) => void): () => void;
  };
  artifacts: {
    importText(): Promise<{ artifactId?: string }>;
    exportText(id: string): Promise<{ exported: boolean }>;
    saveAnswer(messageId: string): Promise<{ artifactId: string }>;
    get(artifactId: string): Promise<{ artifact: { artifactId: string; taskId?: string; name: string; type: string; mimeType: string; version: number; storageRef: string; createdAt: string; content: string; truncated: boolean; lineage: Array<{ artifactId: string; version: number; name: string; type: string }> } }>;
  };
  decideApproval(approvalId: string, decision: "approved" | "rejected"): Promise<{ approvalId: string; state: string; taskId: string }>;
  submitUiAction(surfaceId: string, actionId: string, input: unknown): Promise<{ surfaceId: string; actionId: string; command: string; accepted: true; result?: unknown }>;
  models: {
    list(): Promise<{ models: OsModelView[]; agents: OsAgentModelView[] }>;
    register(model: Omit<OsModelView, "source">): Promise<{ model: OsModelView }>;
    assign(agentId: string, providerId: string, modelId: string): Promise<{ agent: OsAgentModelView }>;
  };
  credentials: {
    list(): Promise<{ providers: CredentialProviderView[] }>;
    set(providerId: string, values: Record<string, string>): Promise<{ provider: CredentialProviderView }>;
    clear(providerId: string): Promise<{ provider: CredentialProviderView }>;
    test(providerId: string, modelId: string): Promise<ModelConnectionTestView>;
  };
  voice(payload: Record<string, unknown>): Promise<import("../src/core/voice-types.js").VoiceResult>;
  workspace: {
    get(): Promise<WorkspaceRoot | null>;
    select(): Promise<WorkspaceRoot | null>;
    list(relativeDirectory?: string): Promise<WorkspaceEntry[]>;
    page(relativeDirectory?: string, offset?: number): Promise<WorkspacePage>;
    search(query: string): Promise<WorkspaceEntry[]>;
    createDirectory(relativeDirectory: string, name: string): Promise<WorkspaceEntry>;
    rename(uri: string, name: string): Promise<WorkspaceEntry>;
    move(uri: string, targetDirectoryUri: string | null): Promise<WorkspaceEntry>;
    preview(uri: string): Promise<WorkspacePreview>;
    trash(uri: string): Promise<{ trashed: true }>;
    open(uri: string): Promise<void>;
    importDroppedFiles(files: File[], targetDirectoryUri?: string | null): Promise<WorkspaceEntry[]>;
    onChanged(listener: (event: { rootId: string }) => void): () => void;
  };
  windowState: {
    list(): Promise<PersistedWindowState[]>;
    save(state: PersistedWindowState): Promise<{ saved: true }>;
  };
  appearance: {
    get(): Promise<{ dockScale: number }>;
    setDockScale(dockScale: number): Promise<{ dockScale: number }>;
    onDockScaleChanged(listener: (dockScale: number) => void): () => void;
  };
}

declare global {
  interface Window {
    xilingDesktop?: DesktopBridge;
  }
}

const APP_DEFINITIONS = {
  agent: { appId: "system.agent", title: "个人应用", eyebrow: "独立会话" },
  workspace: { appId: "system.workspace", title: "工作空间", eyebrow: "文件与环境" },
  chat: { appId: "system.chat", title: "对话", eyebrow: "智能体" },
  tasks: { appId: "system.tasks", title: "任务中心", eyebrow: "调度与恢复" },
  literature: { appId: "system.literature", title: "文献工作台", eyebrow: "发现与阅读" },
  settings: { appId: "system.settings", title: "设置", eyebrow: "系统" },
} as const;

const DOCK_SCALE_STORAGE_KEY = "xiling:dock-scale";
const MIN_WINDOW_WIDTH = 460;
const MIN_WINDOW_HEIGHT = 300;

type AppKey = keyof typeof APP_DEFINITIONS;

interface ManagedWindow extends PersistedWindowState {
  appKey: AppKey;
}

const pendingApps: AppKey[] = [];
let reactRoot: Root | undefined;

function defaultWindow(appKey: AppKey, index: number): ManagedWindow {
  const definition = APP_DEFINITIONS[appKey];
  const workspace = appKey === "workspace";
  const literature = appKey === "literature";
  const settings = appKey === "settings";
  return {
    id: `managed-${appKey}`,
    appId: definition.appId,
    appKey,
    x: 72 + index * 34,
    y: 54 + index * 26,
    width: workspace ? 980 : literature ? 1160 : settings ? 820 : appKey === "chat" ? 860 : 660,
    height: workspace ? 610 : literature ? 620 : settings ? 640 : appKey === "chat" ? 680 : 440,
    zIndex: 50 + index,
    state: "open",
    payload: {},
    updatedAt: new Date().toISOString(),
  };
}

function fitWindow(model: ManagedWindow): ManagedWindow {
  return fitWindowToViewport(
    model,
    { width: window.innerWidth, height: window.innerHeight, topInset: 32, bottomInset: 76 },
    { width: MIN_WINDOW_WIDTH, height: MIN_WINDOW_HEIGHT },
  );
}

async function saveWindow(state: ManagedWindow): Promise<void> {
  const { appKey: _appKey, ...persisted } = state;
  await window.xilingDesktop?.windowState.save({ ...persisted, updatedAt: new Date().toISOString() });
}

function formatBytes(bytes: number | null): string {
  if (bytes == null) return "文件夹";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function publishWorkspaceEntries(entries: WorkspaceEntry[]): void {
  window.dispatchEvent(new CustomEvent("xiling:workspace-entries", { detail: entries }));
}

function workspaceRelativePath(uri: string | null): string {
  if (!uri) return "";
  return new URL(uri).pathname.split("/").filter(Boolean).map(decodeURIComponent).join("/");
}

function parentWorkspaceUri(uri: string | null): string | null {
  if (!uri) return null;
  const parsed = new URL(uri);
  const parts = parsed.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  parts.pop();
  if (!parts.length) return null;
  return `workspace://${parsed.hostname}/${parts.map(encodeURIComponent).join("/")}`;
}

function WorkspaceApp() {
  const [root, setRoot] = useState<WorkspaceRoot | null>(null);
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [dragOver, setDragOver] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedUri, setSelectedUri] = useState<string>();
  const [editor, setEditor] = useState<{ kind: "mkdir" | "rename"; value: string }>();
  const [currentDirectoryUri, setCurrentDirectoryUri] = useState<string | null>(null);
  const [cutUri, setCutUri] = useState<string>();
  const [preview, setPreview] = useState<WorkspacePreview>();
  const [previewLoading, setPreviewLoading] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  const refresh = async () => {
    setLoading(true);
    setError(undefined);
    try {
      const selected = await window.xilingDesktop?.workspace.get() ?? null;
      setRoot(selected);
      const page = selected ? await window.xilingDesktop?.workspace.page(workspaceRelativePath(currentDirectoryUri), 0) : undefined;
      const nextEntries = page?.entries ?? [];
      setEntries(nextEntries);
      setNextOffset(page?.nextOffset ?? 0);
      setHasMore(page?.hasMore ?? false);
      setSelectedUri(undefined);
      setPreview(undefined);
      if (!currentDirectoryUri) publishWorkspaceEntries(nextEntries);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法读取桌面文件夹");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (!root) return;
    return window.xilingDesktop?.workspace.onChanged(() => void refresh());
  }, [root?.id, currentDirectoryUri]);

  useEffect(() => {
    if (!root) return;
    void refresh();
  }, [currentDirectoryUri]);

  useEffect(() => {
    const selected = entries.find((entry) => entry.uri === selectedUri);
    if (!selected || selected.kind !== "file") {
      setPreview(undefined);
      return;
    }
    let active = true;
    setPreviewLoading(true);
    void window.xilingDesktop?.workspace.preview(selected.uri)
      .then((value) => { if (active) setPreview(value); })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "无法预览文件"); })
      .finally(() => { if (active) setPreviewLoading(false); });
    return () => { active = false; };
  }, [selectedUri]);

  const chooseRoot = async () => {
    const selected = await window.xilingDesktop?.workspace.select();
    if (!selected) return;
    setRoot(selected);
    setCurrentDirectoryUri(null);
    await refresh();
  };

  const importFiles = async (files: File[]) => {
    if (!files.length) return;
    setError(undefined);
    try {
      await window.xilingDesktop?.workspace.importDroppedFiles(files, currentDirectoryUri);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "文件导入失败");
    }
  };

  const search = async () => {
    if (!query.trim()) return refresh();
    setLoading(true);
    setError(undefined);
    try {
      setEntries(await window.xilingDesktop?.workspace.search(query) ?? []);
      setHasMore(false);
      setSelectedUri(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "搜索失败");
    } finally {
      setLoading(false);
    }
  };

  const applyEditor = async () => {
    if (!editor?.value.trim()) return;
    setError(undefined);
    try {
      if (editor.kind === "mkdir") await window.xilingDesktop?.workspace.createDirectory(workspaceRelativePath(currentDirectoryUri), editor.value);
      else if (selectedUri) await window.xilingDesktop?.workspace.rename(selectedUri, editor.value);
      setEditor(undefined);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "文件操作失败");
    }
  };

  const trashSelected = async () => {
    if (!selectedUri) return;
    const selected = entries.find((entry) => entry.uri === selectedUri);
    if (!window.confirm(`将“${selected?.name ?? "所选项目"}”移到系统废纸篓？`)) return;
    setError(undefined);
    try {
      await window.xilingDesktop?.workspace.trash(selectedUri);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法移到系统废纸篓");
    }
  };

  const pasteCutItem = async () => {
    if (!cutUri) return;
    setError(undefined);
    try {
      await window.xilingDesktop?.workspace.move(cutUri, currentDirectoryUri);
      setCutUri(undefined);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法移动项目");
    }
  };

  const loadMore = async () => {
    if (!hasMore || loading) return;
    setLoading(true);
    setError(undefined);
    try {
      const page = await window.xilingDesktop?.workspace.page(workspaceRelativePath(currentDirectoryUri), nextOffset);
      if (!page) return;
      setEntries((current) => [...current, ...page.entries.filter((entry) => !current.some((item) => item.uri === entry.uri))]);
      setNextOffset(page.nextOffset);
      setHasMore(page.hasMore);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法继续加载目录");
    } finally {
      setLoading(false);
    }
  };

  const pathParts = currentDirectoryUri
    ? new URL(currentDirectoryUri).pathname.split("/").filter(Boolean).map(decodeURIComponent)
    : [];

  return (
    <div className="workspace-app">
      <div className="workspace-app-hero">
        <div>
          <p className="eyebrow">工作空间</p>
          <h2>继续你的研究</h2>
          <p>从真实文件出发，让后续证据、计算与产物留在同一个可追溯空间。</p>
        </div>
        <div className="workspace-app-actions">
          <button type="button" onClick={chooseRoot}>选择桌面文件夹</button>
          <button className="primary-action" type="button">＋ 新建研究</button>
        </div>
      </div>

      <div className="workspace-app-grid">
        <section className="panel workspace-files-panel">
          <header className="panel-heading">
            <div><p className="eyebrow">真实文件夹</p><h3>{pathParts.at(-1) ?? root?.label ?? "尚未选择桌面目录"}</h3></div>
            <button type="button" onClick={() => void refresh()}>刷新</button>
          </header>
          <nav className="workspace-breadcrumbs" aria-label="文件夹路径">
            <button type="button" onClick={() => setCurrentDirectoryUri(null)}>{root?.label ?? "桌面"}</button>
            {pathParts.map((part, index) => {
              const parsed = currentDirectoryUri ? new URL(currentDirectoryUri) : null;
              const uri = parsed ? `workspace://${parsed.hostname}/${pathParts.slice(0, index + 1).map(encodeURIComponent).join("/")}` : null;
              return <span key={uri}><i aria-hidden="true">›</i><button type="button" onClick={() => setCurrentDirectoryUri(uri)}>{part}</button></span>;
            })}
          </nav>
          <div className="workspace-file-toolbar">
            <form onSubmit={(event) => { event.preventDefault(); void search(); }}>
              <input aria-label="搜索桌面文件" type="search" value={query} onChange={(event) => { setQuery(event.target.value); if (!event.target.value) void refresh(); }} placeholder="搜索文件与文件夹" />
            </form>
            <button type="button" disabled={!currentDirectoryUri} onClick={() => setCurrentDirectoryUri(parentWorkspaceUri(currentDirectoryUri))}>返回上级</button>
            <button type="button" onClick={() => setEditor({ kind: "mkdir", value: "" })}>新建文件夹</button>
            <button type="button" disabled={!selectedUri} onClick={() => {
              const selected = entries.find((entry) => entry.uri === selectedUri);
              if (selected) setEditor({ kind: "rename", value: selected.name });
            }}>重命名</button>
            <button type="button" disabled={!selectedUri} onClick={() => setCutUri(selectedUri)}>剪切</button>
            <button type="button" disabled={!cutUri} onClick={() => void pasteCutItem()}>粘贴到此处</button>
            <button type="button" disabled={!selectedUri} onClick={() => void trashSelected()}>移到废纸篓</button>
          </div>
          {editor ? (
            <form className="workspace-inline-editor" onSubmit={(event) => { event.preventDefault(); void applyEditor(); }}>
              <label>{editor.kind === "mkdir" ? "文件夹名称" : "新名称"}<input autoFocus value={editor.value} onChange={(event) => setEditor({ ...editor, value: event.target.value })} /></label>
              <button className="primary-action" type="submit">确认</button>
              <button type="button" onClick={() => setEditor(undefined)}>取消</button>
            </form>
          ) : null}
          <div
            className="workspace-react-dropzone"
            data-drag-over={dragOver ? "true" : "false"}
            onDragEnter={(event) => { event.preventDefault(); setDragOver(true); }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={() => setDragOver(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragOver(false);
              void importFiles([...event.dataTransfer.files]);
            }}
          >
            {loading ? <p className="workspace-status">正在读取…</p> : null}
            {!loading && !root ? <p className="workspace-status">选择电脑上的文件夹，或把文件拖到这里。</p> : null}
            {!loading && root && entries.length === 0 ? <p className="workspace-status">文件夹是空的，可以直接拖入文件。</p> : null}
            {error ? <p className="workspace-error" role="alert">{error}</p> : null}
            <ul className="workspace-react-list" aria-live="polite">
              {entries.map((entry) => (
                <li key={entry.uri} data-selected={selectedUri === entry.uri ? "true" : "false"} data-cut={cutUri === entry.uri ? "true" : "false"} onClick={() => setSelectedUri(entry.uri)} onDoubleClick={() => {
                  if (entry.kind === "directory") { setQuery(""); setCurrentDirectoryUri(entry.uri); }
                  else void window.xilingDesktop?.workspace.open(entry.uri);
                }}>
                  <span aria-hidden="true">{entry.kind === "directory" ? "▰" : "▤"}</span>
                  <span title={entry.name}>{entry.name}</span>
                  <small>{formatBytes(entry.size)}</small>
                </li>
              ))}
            </ul>
            {hasMore ? <button className="workspace-load-more" type="button" onClick={() => void loadMore()}>加载更多</button> : null}
          </div>
        </section>

        <section className="panel workspace-preview-panel">
          <header className="panel-heading"><div><p className="eyebrow">快速查看</p><h3>{preview?.name ?? "文件预览"}</h3></div></header>
          {previewLoading ? <p className="workspace-status">正在准备预览…</p> : null}
          {!previewLoading && preview?.kind === "image" && preview.dataUrl ? <div className="workspace-preview-image"><img src={preview.dataUrl} alt={preview.name} /></div> : null}
          {!previewLoading && preview?.kind === "text" ? <div className="workspace-preview-text">{preview.truncated ? <p>仅显示前 256 KB</p> : null}<pre>{preview.text}</pre></div> : null}
          {!previewLoading && preview?.kind === "unsupported" ? <p className="workspace-status">此格式暂不在应用内预览，双击可用系统应用打开。</p> : null}
          {!previewLoading && !preview ? <p className="workspace-status">选择文件后在这里查看内容；文件夹双击进入。</p> : null}
        </section>

        <section className="panel workspace-artifacts-panel">
          <header className="panel-heading"><div><p className="eyebrow">最近产物</p><h3>研究成果</h3></div></header>
          <p className="workspace-status">保存的图表、数据、代码和报告将在这里保留来源与计算溯源。</p>
        </section>
      </div>
    </div>
  );
}

function DockScaleSettings() {
  const [dockScale, setDockScale] = useState(() => {
    try {
      const stored = Number(localStorage.getItem(DOCK_SCALE_STORAGE_KEY));
      return Number.isFinite(stored) && stored >= 0.75 && stored <= 1.25 ? stored : 1;
    } catch {
      return 1;
    }
  });

  useEffect(() => {
    let active = true;
    void window.xilingDesktop?.appearance.get().then((preferences) => {
      if (active) setDockScale(preferences.dockScale);
    });
    const unsubscribe = window.xilingDesktop?.appearance.onDockScaleChanged(setDockScale);
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);

  const update = (value: number) => {
    setDockScale(value);
    window.dispatchEvent(new CustomEvent("xiling:dock-scale-change", { detail: value }));
    try { localStorage.setItem(DOCK_SCALE_STORAGE_KEY, String(value)); } catch { /* optional */ }
    void window.xilingDesktop?.appearance.setDockScale(value).catch(() => undefined);
  };

  return (
    <section className="dock-scale-settings">
      <header><div><h3>程序坞大小</h3><p>等比例调整图标、间距与指示灯。</p></div><output aria-live="polite">{Math.round(dockScale * 100)}%</output></header>
      <label className="dock-scale-control"><span aria-hidden="true">◆</span><input aria-label="程序坞大小" type="range" min="0.75" max="1.25" step="0.05" value={dockScale} onChange={(event) => update(Number(event.target.value))} /><span aria-hidden="true">◆</span></label>
      <div className="dock-scale-actions"><button type="button" onClick={() => update(1)}>恢复默认大小</button></div>
    </section>
  );
}

function CredentialSettings() {
  const [providers, setProviders] = useState<CredentialProviderView[]>([]);
  const [selectedId, setSelectedId] = useState("openai");
  const [values, setValues] = useState<Record<string, string>>({});
  const [testModel, setTestModel] = useState("");
  const [testResult, setTestResult] = useState<ModelConnectionTestView>();
  const [busy, setBusy] = useState<"save" | "test" | "clear">();
  const [error, setError] = useState<string>();
  const selected = providers.find((provider) => provider.id === selectedId);

  const refresh = async () => setProviders((await window.xilingDesktop!.credentials.list()).providers);
  useEffect(() => { void refresh().catch((reason) => setError(reason instanceof Error ? reason.message : "无法读取连接")); }, []);
  useEffect(() => { setValues({}); setTestResult(undefined); }, [selectedId]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || busy) return;
    const entered = Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim() !== ""));
    if (Object.keys(entered).length === 0) return;
    setBusy("save"); setError(undefined);
    try { await window.xilingDesktop!.credentials.set(selected.id, entered); setValues({}); await refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败"); }
    finally { setBusy(undefined); }
  };
  const clear = async () => {
    if (!selected || busy) return;
    setBusy("clear"); setError(undefined);
    try { await window.xilingDesktop!.credentials.clear(selected.id); setValues({}); setTestResult(undefined); await refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "清除失败"); }
    finally { setBusy(undefined); }
  };
  const test = async () => {
    if (!selected || !testModel.trim() || busy) return;
    setBusy("test"); setError(undefined); setTestResult(undefined);
    try { setTestResult(await window.xilingDesktop!.credentials.test(selected.id, testModel.trim())); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "连接测试失败"); }
    finally { setBusy(undefined); }
  };

  return (
    <section className="credential-settings">
      <header><div><h3>模型连接</h3><p>密钥加密保存在本机，不会显示、回传到界面或写入运行收据。</p></div><span>{providers.filter((provider) => provider.configured).length} 个已连接</span></header>
      <div className="credential-layout">
        <nav aria-label="模型提供商">{providers.map((provider) => <button type="button" key={provider.id} data-active={provider.id === selectedId} onClick={() => setSelectedId(provider.id)}><span>{provider.title}</span><small>{provider.configured ? "已配置" : "未配置"}</small></button>)}</nav>
        <form onSubmit={save}>
          {selected ? <><div className="credential-title"><div><strong>{selected.title}</strong><p>{selected.description}</p></div><span data-ready={selected.configured}>{selected.source === "environment" ? "环境变量" : selected.configured ? "本机凭据" : "尚未连接"}</span></div>
          <div className="credential-fields">{selected.fields.map((field) => field.id === "apiStyle" ? <label key={field.id}>{field.label}<select value={values[field.id] ?? ""} onChange={(event) => setValues((current) => ({ ...current, [field.id]: event.target.value }))}><option value="">保持现有设置</option><option value="openai-responses">OpenAI Responses</option><option value="openai-completions">OpenAI Chat Completions</option></select></label> : <label key={field.id}>{field.label}{selected.configuredFields.includes(field.id) ? <small>已保存，留空保持不变</small> : null}<input type={field.secret ? "password" : "text"} autoComplete="off" value={values[field.id] ?? ""} placeholder={field.placeholder} onChange={(event) => setValues((current) => ({ ...current, [field.id]: event.target.value }))} /></label>)}</div>
          <div className="credential-actions"><button type="button" disabled={Boolean(busy) || !selected.configured || selected.source === "environment"} onClick={() => void clear()}>清除本机凭据</button><button className="primary-action" type="submit" disabled={Boolean(busy) || Object.values(values).every((value) => !value.trim())}>{busy === "save" ? "保存中…" : "保存连接"}</button></div>
          <div className="connection-test"><label>用于测试的模型名称<input value={testModel} onChange={(event) => setTestModel(event.target.value)} placeholder="输入该提供商实际可用的模型" /></label><button type="button" disabled={Boolean(busy) || !selected.configured || !testModel.trim()} onClick={() => void test()}>{busy === "test" ? "测试中…" : "测试连接"}</button></div>
          {testResult ? <p className="connection-result" data-ok={testResult.ok}>{testResult.message} · {testResult.latencyMs} ms</p> : null}</> : <p>正在读取连接…</p>}
          {error ? <p className="credential-error" role="alert">{error}</p> : null}
        </form>
      </div>
    </section>
  );
}

function ModelSettings() {
  const [catalog, setCatalog] = useState<OsModelView[]>([]);
  const [agents, setAgents] = useState<OsAgentModelView[]>([]);
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [windowTokens, setWindowTokens] = useState(32000);
  const [inputs, setInputs] = useState<Array<"text" | "image" | "audio" | "video">>(["text"]);
  const [imageOutput, setImageOutput] = useState(false);
  const [toolUse, setToolUse] = useState(true);
  const [reasoning, setReasoning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const refresh = async () => {
    const result = await window.xilingDesktop!.models.list();
    setCatalog(result.models); setAgents(result.agents);
  };
  useEffect(() => { void refresh().catch((reason) => setError(reason instanceof Error ? reason.message : "无法读取模型设置")); }, []);

  const toggleInput = (modality: "image" | "audio" | "video") => {
    setInputs((current) => current.includes(modality) ? current.filter((item) => item !== modality) : [...current, modality]);
  };

  const register = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!providerId.trim() || !modelId.trim() || busy) return;
    setBusy(true); setError(undefined);
    try {
      await window.xilingDesktop!.models.register({
        providerId: providerId.trim(), modelId: modelId.trim(), nativeInputs: inputs,
        nativeOutputs: imageOutput ? ["text", "image"] : ["text"], contextWindowTokens: windowTokens,
        supportsToolUse: toolUse, reasoning,
      });
      setModelId("");
      await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "模型登记失败"); }
    finally { setBusy(false); }
  };

  const assign = async (agentId: string, value: string) => {
    const model = catalog.find((item) => `${item.providerId}\u0000${item.modelId}` === value);
    if (!model) return;
    setBusy(true); setError(undefined);
    try { await window.xilingDesktop!.models.assign(agentId, model.providerId, model.modelId); await refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "模型分配失败"); }
    finally { setBusy(false); }
  };

  return (
    <section className="model-settings">
      <header><div><h3>模型与智能体</h3><p>模型名不受内置列表限制。精确命中运行时目录时自动采用目录能力；未知模型保留为用户声明。</p></div><span>{catalog.length} 个模型</span></header>
      <div className="agent-model-list">
        {agents.map((agent) => <label key={agent.agentId}><span><strong>{agent.name}</strong><small>{agent.main ? "主要智能体" : "动态子智能体"}</small></span><select disabled={busy || catalog.length === 0} value={agent.preferred ? `${agent.preferred.providerId}\u0000${agent.preferred.modelId}` : ""} onChange={(event) => void assign(agent.agentId, event.target.value)}><option value="">运行时默认</option>{catalog.map((model) => <option key={`${model.providerId}/${model.modelId}`} value={`${model.providerId}\u0000${model.modelId}`}>{model.displayName ?? model.modelId} · {model.providerId}</option>)}</select></label>)}
      </div>
      {catalog.length > 0 ? <div className="model-catalog-list" aria-label="已登记模型">
        {catalog.map((model) => {
          const verified = model.source === "provider-catalog" || model.source === "native-probe";
          const modalities = [...model.nativeInputs.map((item) => `输入·${{ text: "文字", image: "图像", audio: "音频", video: "视频" }[item]}`), ...model.nativeOutputs.map((item) => `输出·${item === "text" ? "文字" : "图像"}`)];
          return <article key={`${model.providerId}/${model.modelId}`}><div><strong>{model.displayName ?? model.modelId}</strong><small>{model.providerId} / {model.modelId}</small></div><p>{modalities.join("　")}</p><span data-verified={verified}>{verified ? "目录已验证" : "用户声明"}</span></article>;
        })}
      </div> : null}
      <form className="model-register" onSubmit={register}>
        <div className="model-fields"><label>提供商<input value={providerId} onChange={(event) => setProviderId(event.target.value)} placeholder="例如 openrouter" /></label><label>模型名称<input value={modelId} onChange={(event) => setModelId(event.target.value)} placeholder="可直接输入完整模型名" /></label><label>上下文窗口<input type="number" min="1024" step="1024" value={windowTokens} onChange={(event) => setWindowTokens(Number(event.target.value))} /></label></div>
        <fieldset><legend>原生输入</legend><label><input type="checkbox" checked disabled />文字</label>{(["image", "audio", "video"] as const).map((item) => <label key={item}><input type="checkbox" checked={inputs.includes(item)} onChange={() => toggleInput(item)} />{{ image: "图像", audio: "音频", video: "视频" }[item]}</label>)}</fieldset>
        <fieldset><legend>原生输出与能力</legend><label><input type="checkbox" checked disabled />文字</label><label><input type="checkbox" checked={imageOutput} onChange={(event) => setImageOutput(event.target.checked)} />图像</label><label><input type="checkbox" checked={toolUse} onChange={(event) => setToolUse(event.target.checked)} />工具调用</label><label><input type="checkbox" checked={reasoning} onChange={(event) => setReasoning(event.target.checked)} />推理</label></fieldset>
        <div className="model-register-actions">{error ? <p role="alert">{error}</p> : <span>用户声明的非文字模态不会直接获准执行；需由模型目录或原生探针验证。</span>}<button className="primary-action" disabled={busy || !providerId.trim() || !modelId.trim()} type="submit">{busy ? "保存中…" : "添加模型"}</button></div>
      </form>
    </section>
  );
}

function CompanionSettings() {
  const [enabled, setEnabled] = useState(() => localStorage.getItem("xiling:companion-enabled") === "true");
  const [scale, setScale] = useState(() => Number(localStorage.getItem("settings/live2d/scale") ?? 1));
  useEffect(() => { const changed = (event: Event) => setEnabled((event as CustomEvent).detail === true); window.addEventListener("xiling:companion-enabled", changed); return () => window.removeEventListener("xiling:companion-enabled", changed); }, []);
  const resize = (value: number) => { setScale(value); localStorage.setItem("settings/live2d/scale", String(value)); window.dispatchEvent(new Event("xiling:companion-settings")); };
  return <section className="credential-settings"><p className="eyebrow">桌面上的交互入口</p><h3>Hiyori · 桃濑日和</h3><p>采用 AIRI 默认的 Hiyori（Pro）Live2D 形象，保留原始模型、待机动作与视线跟随。和对话共享工作进度，不另外启动一个智能体。</p><label><input type="checkbox" checked={enabled} onChange={(event) => { setEnabled(event.target.checked); localStorage.setItem("xiling:companion-enabled", String(event.target.checked)); window.dispatchEvent(new CustomEvent("xiling:companion-enabled", { detail: event.target.checked })); }} />在桌面显示伴侣</label><label>角色缩放 · {Math.round(scale * 100)}%<input aria-label="角色缩放" type="range" min="0.01" max="3" step="0.01" value={scale} onChange={(event) => resize(Number(event.target.value))} /></label><button onClick={() => resize(1)}>恢复默认比例</button><p className="settings-footnote">未启用麦克风、摄像头和屏幕读取。关闭后释放角色渲染资源。</p><details><summary>形象来源与使用许可</summary><p>AIRI 默认模型，插画：Kani Biimu；模型：Live2D。模型及 Cubism Core 有独立许可证，并非 AIRI 的 MIT 许可。此处为原始形象的桌面适配，不是完整 AIRI 设置移植。</p></details></section>;
}
function RuntimeSettings() {
  const [runtime, setRuntime] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { void window.xilingDesktop?.getOsSnapshot().then((state) => setRuntime(state.runtimeName ?? "")).catch((error: unknown) => setError(String(error))); }, []);
  return <section className="credential-settings"><h3>真实运行引擎</h3><p>{runtime === "deepseek-harness-sdk" ? "内置 Harness 已启用，任务启动时才创建进程。" : `当前身份仍绑定 ${runtime || "未知"}。旧记录保留；切换后新运行使用真实模型，旧模拟历史不会伪装为真实轨迹。`}</p>{runtime !== "deepseek-harness-sdk" && <button disabled={busy} onClick={() => { setBusy(true); void window.xilingDesktop!.enableNativeMain().then((result) => { setRuntime(result.runtimeName); selectSession(undefined); }).catch((error: unknown) => setError(String(error))).finally(() => setBusy(false)); }}>启用真实运行引擎（保留旧记录）</button>}{error && <p role="alert">{error}</p>}</section>;
}
function SettingsApp() {
  const [theme, setTheme] = useState(() => localStorage.getItem("xiling-theme") || "lingjing");
  const [tab, setTab] = useState("models");
  const tabs = [{ id: "companion", name: "桌面伴侣", detail: "形象与显示" }, { id: "models", name: "模型与连接", detail: "密钥与默认模型" }, { id: "apps", name: "应用与记忆", detail: "能力与使用记录" }, { id: "desktop", name: "桌面外观", detail: "程序坞与尺寸" }];
  tabs.splice(1, 0, { id: "voice", name: "语音与对话", detail: "原生音频 · 识别与合成" });
  return <div className="settings-layout"><nav aria-label="设置分类"><h2>设置</h2>{tabs.map((item) => <button key={item.id} aria-current={tab === item.id ? "page" : undefined} onClick={() => setTab(item.id)}><strong>{item.name}</strong><small>{item.detail}</small></button>)}</nav><div className="settings-app"><header className="settings-heading"><p className="eyebrow">你的汐灵，依你而设</p><h2>{tabs.find((item) => item.id === tab)?.name}</h2></header>{tab === "voice" && <VoiceSettings />}{tab === "companion" && <CompanionSettings />}{tab === "models" && <><CredentialSettings /><ModelSettings /><details><summary>运行引擎</summary><RuntimeSettings /></details></>}{tab === "apps" && window.xilingDesktop && <Suspense fallback={<p>正在加载…</p>}><AgentApps command={window.xilingDesktop.manageAgentApps} /><MemoryManager /></Suspense>}{tab === "desktop" && <><label>系统主题 <select value={theme} onChange={event => { const value = event.target.value; setTheme(value); localStorage.setItem("xiling-theme", value); window.dispatchEvent(new Event("xiling:theme-change")); }}><option value="lingjing">灵境</option><option value="poxiao">破晓</option><option value="system">跟随系统</option></select></label><DockScaleSettings /></>}</div></div>;
}

const TASK_LABELS: Record<string, string> = {
  created: "已创建", queued: "排队中", running: "执行中", waiting_input: "等待输入",
  waiting_approval: "等待确认", waiting_dependency: "等待协作", completed: "已完成",
  failed: "失败", cancelled: "已取消",
};

const TRUSTED_SURFACE_KINDS = new Set(["approval", "table", "form", "comparison", "diff", "chart", "artifact", "task_board"]);

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function displayValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value)?.slice(0, 240) ?? "—";
}

export function TrustedSurface({ surface, busy, onAction }: {
  surface: OsSnapshot["surfaces"][number]; busy: boolean;
  onAction: (surfaceId: string, actionId: string, input: unknown) => Promise<void>;
}) {
  const [formValues, setFormValues] = useState<Record<string, string | boolean>>({});
  const data = recordValue(surface.data);
  if (surface.componentVersion !== 1 || !TRUSTED_SURFACE_KINDS.has(surface.kind) || !data) {
    return <aside className="trusted-surface surface-invalid" role="alert"><strong>界面无法显示</strong><p>组件版本或数据契约不受信任。</p></aside>;
  }
  let content: React.ReactNode;
  if (surface.kind === "table" && Array.isArray(data.columns) && Array.isArray(data.rows)) {
    const columns = data.columns.map((item) => typeof item === "string" ? { id: item, label: item } : recordValue(item)).filter((item): item is Record<string, unknown> => Boolean(item));
    content = <div className="surface-table-wrap"><table><thead><tr>{columns.map((column) => <th key={String(column.id)}>{String(column.label)}</th>)}</tr></thead><tbody>{data.rows.slice(0, 20).map((row, index) => { const values = recordValue(row) ?? {}; return <tr key={index}>{columns.map((column) => <td key={String(column.id)}>{displayValue(values[String(column.id)])}</td>)}</tr>; })}</tbody></table></div>;
  } else if (surface.kind === "form" && Array.isArray(data.fields)) {
    content = <div className="surface-form">{data.fields.map((raw) => { const field = recordValue(raw); if (!field) return null; const id = String(field.id); const type = String(field.type); const value = String(formValues[id] ?? ""); return <label key={id}>{String(field.label)}{type === "checkbox" ? <input type="checkbox" checked={formValues[id] === true} onChange={(event) => setFormValues((current) => ({ ...current, [id]: event.target.checked }))} /> : type === "select" && Array.isArray(field.options) ? <select value={value} onChange={(event) => setFormValues((current) => ({ ...current, [id]: event.target.value }))}><option value="">请选择</option>{field.options.map((option) => typeof option === "string" ? <option key={option} value={option}>{option}</option> : null)}</select> : type === "textarea" ? <textarea rows={3} value={value} onChange={(event) => setFormValues((current) => ({ ...current, [id]: event.target.value }))} /> : <input type={type === "number" ? "number" : "text"} value={value} onChange={(event) => setFormValues((current) => ({ ...current, [id]: event.target.value }))} />}</label>; })}</div>;
  } else if (surface.kind === "comparison" && Array.isArray(data.items)) {
    content = <div className="surface-comparison">{data.items.map((raw, index) => { const item = recordValue(raw) ?? {}; return <article key={index}><strong>{displayValue(item.label)}</strong><p>{displayValue(item.value ?? item.detail)}</p></article>; })}</div>;
  } else if (surface.kind === "diff") {
    content = <div className="surface-diff"><pre>{displayValue(data.before)}</pre><pre>{displayValue(data.after)}</pre></div>;
  } else if (surface.kind === "chart" && Array.isArray(data.series)) {
    const points = data.series.flatMap((raw) => { const item = recordValue(raw); return item && typeof item.value === "number" ? [{ label: displayValue(item.label), value: item.value }] : []; }).slice(0, 16);
    const min = Math.min(0, ...points.map((point) => point.value)), max = Math.max(1, ...points.map((point) => point.value));
    const y = (v: number) => 158 - (v - min) / (max - min) * 124;
    const x = (index: number) => 35 + (index + .5) * 490 / Math.max(1, points.length);
    content = <div className="surface-plot"><svg viewBox="0 0 560 200" role="img" aria-label={`${surface.title}，${data.type === "line" ? "折线图" : data.type === "scatter" ? "散点图" : "柱状图"}`}><line x1="28" x2="536" y1={y(0)} y2={y(0)} className="plot-axis" />{data.type === "line" && <polyline points={points.map((point, index) => `${x(index)},${y(point.value)}`).join(" ")} fill="none" className="plot-line" />}{points.map((point, index) => <g key={index}>{data.type === "bar" ? <rect x={x(index) - 10} y={Math.min(y(0), y(point.value))} width="20" height={Math.max(1, Math.abs(y(point.value) - y(0)))} rx="3" /> : <circle cx={x(index)} cy={y(point.value)} r="4" />}<text x={x(index)} y={y(point.value) - 9} textAnchor="middle">{point.value}</text><text x={x(index)} y="185" textAnchor="middle">{point.label.slice(0, 7)}</text></g>)}</svg></div>;
  } else if (surface.kind === "task_board" && Array.isArray(data.columns)) {
    content = <div className="surface-board">{data.columns.map((raw, index) => { const column = recordValue(raw) ?? {}; return <section key={index}><strong>{displayValue(column.title)}</strong>{Array.isArray(column.tasks) ? column.tasks.slice(0, 8).map((task, taskIndex) => <p key={taskIndex}>{displayValue(recordValue(task)?.title ?? task)}</p>) : null}</section>; })}</div>;
  } else {
    content = <dl className="surface-facts">{Object.entries(data).slice(0, 12).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{displayValue(value)}</dd></div>)}</dl>;
  }
  const actionInput = surface.kind === "form" && Array.isArray(data.fields) ? Object.fromEntries(data.fields.flatMap((raw) => { const field = recordValue(raw); if (!field) return []; const id = String(field.id); const current = formValues[id]; return [[id, field.type === "checkbox" ? current === true : field.type === "number" && current !== "" && current !== undefined ? Number(current) : current ?? ""]]; })) : {};
  return <aside className="trusted-surface" data-kind={surface.kind} role="region" aria-label={surface.title ?? "任务界面"}><header><span>{surface.kind === "form" ? "由你决定" : "为当前任务生成"}</span><strong>{surface.title ?? "任务界面"}</strong></header>{content}{surface.actions.length > 0 ? <footer>{surface.actions.map((action) => <button type="button" key={action.id} disabled={busy} onClick={() => void onAction(surface.id, action.id, actionInput)}>{action.label}</button>)}</footer> : null}</aside>;
}

function ChatApp() {
  const [artifactIds, setArtifactIds] = useState<string[]>([]);
  const [sessionId, setSessionId] = useState(selectedSession);
  const [snapshot, setSnapshot] = useState<OsSnapshot>();
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [showAllTasks, setShowAllTasks] = useState(false);

  const refresh = async () => {
    try { setSnapshot(await window.xilingDesktop!.getOsSnapshot()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "无法读取智能体状态"); }
  };

  useEffect(() => {
    void refresh();
    const changed = () => setSessionId(selectedSession());
    window.addEventListener("xiling:main-session-change", changed);
    const unsubscribe = window.xilingDesktop?.tasks.onChanged(() => { void refresh(); });
    return () => { unsubscribe?.(); window.removeEventListener("xiling:main-session-change", changed); };
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const nextGoal = goal.trim();
    if (!nextGoal || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await window.xilingDesktop!.submitGoal(nextGoal, sessionId, artifactIds);
      setArtifactIds([]);
      selectSession(result.task.sessionId);
      setGoal("");
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "目标执行失败");
    } finally { setBusy(false); }
  };

  const decide = async (approvalId: string, decision: "approved" | "rejected") => {
    setBusy(true);
    try { await window.xilingDesktop!.decideApproval(approvalId, decision); await refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "审批失败"); }
    finally { setBusy(false); }
  };

  const submitSurfaceAction = async (surfaceId: string, actionId: string, input: unknown) => {
    setBusy(true); setError(undefined);
    try { await window.xilingDesktop!.submitUiAction(surfaceId, actionId, input); await refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "界面动作未被接受"); }
    finally { setBusy(false); }
  };

  const sessions = snapshot?.sessions.filter((session) => session.agentId === snapshot.mainAgentId && session.state === "active") ?? [];
  const tasks = snapshot?.tasks.filter((task) => sessionId !== undefined && task.sessionId === sessionId) ?? [];
  const visibleTasks = showAllTasks ? tasks : tasks.slice(0, 8);
  const activeCount = tasks.filter((task) => ["created", "queued", "running"].includes(task.state)).length;
  const waitingCount = tasks.filter((task) => task.state.startsWith("waiting_")).length;
  const riskCount = tasks.filter((task) => task.state === "failed").length;
  const completedCount = tasks.filter((task) => task.state === "completed").length;
  return (
    <div className="agent-console">
      <header className="agent-console-header">
        <div><p className="eyebrow">主要入口</p><h2>告诉汐灵你想完成什么</h2></div>
        <span className="runtime-badge">{snapshot?.runtimeName === "deepseek-harness-sdk" ? "准备就绪" : "请先连接模型"}</span>
      </header>
      <label>当前会话 <select aria-label="Main 会话" value={sessionId ?? ""} onChange={(event) => selectSession(event.target.value || undefined)}>
        <option value="">新会话</option>{sessions.map((session) => <option key={session.id} value={session.id}>{session.title ?? "未命名会话"}</option>)}
      </select></label>
      {tasks.length > 0 ? <div className="task-overview" aria-label="任务概览"><span><b>{activeCount}</b>进行中</span><span><b>{waitingCount}</b>等待处理</span><span data-risk={riskCount > 0}><b>{riskCount}</b>需关注</span><span><b>{completedCount}</b>已完成</span></div> : null}
      <div className="agent-thread" aria-live="polite">
        {tasks.length === 0 ? <div className="agent-empty"><span className="welcome-orbit" aria-hidden="true">✳</span><strong>一个想法，就是开始。</strong><p>说出目标，让汐灵为你组织信息、生成界面，并把结果留在桌面。</p><div className="goal-suggestions">{["用表单询问我的旅行偏好，再生成两种行程对比", "把一周学习计划生成可视化任务看板", "用图表展示一份明确标注的示例月度预算"].map((text) => <button key={text} onClick={() => setGoal(text)}>{text}<span>↗</span></button>)}</div></div> : null}
        {visibleTasks.map((task) => {
          const messages = snapshot?.messages.filter((message) => message.taskId === task.id) ?? [];
          const latestMessage = messages.at(-1);
          const approval = snapshot?.approvals.find((item) => item.taskId === task.id && item.state === "pending");
          const surfaces = snapshot?.surfaces.filter((surface) => surface.taskId === task.id) ?? [];
          const waitingText = approval?.reason ?? (task.state.startsWith("waiting_") ? task.statusReason ?? TASK_LABELS[task.state] : "无");
          const riskText = task.state === "failed" ? task.statusReason ?? "任务执行失败" : approval ? "需要你的决定" : "未发现阻塞";
          const nextText = task.state === "completed" ? (task.outputArtifacts.length ? "查看或继续使用产物" : "可继续提出后续目标") : task.state === "failed" ? "调整目标或配置后重试" : approval ? "审阅并决定是否允许" : task.state.startsWith("waiting_") ? "解除等待条件" : "等待汐灵完成当前任务";
          return <article className="agent-turn" key={task.id}>
            <div className="goal-bubble"><span>你</span><p>{task.goal}</p></div>
            <div className="agent-response">
              <div className="agent-response-heading"><strong>汐灵</strong><span data-state={task.state}>{TASK_LABELS[task.state] ?? task.state}</span></div>
              <div className="answer-prose"><p>{latestMessage?.text ?? (task.state === "completed" ? "已完成" : task.state === "failed" ? "这次任务未能完成。" : task.state === "cancelled" ? "任务已取消。" : task.state.startsWith("waiting_") ? "等待你的下一步操作。" : "正在为你处理…")}</p></div>
              {(task.state.startsWith("waiting_") || task.state === "failed") && <p className="task-attention">{task.state === "failed" ? riskText : waitingText}</p>}
              <details className="task-next"><summary>下一步建议</summary><p>{nextText}</p></details>
              {messages.length === 0 && task.state === "completed" ? <p>任务未返回可展示文字，请查看运行详情或产物。</p> : null}
              {task.state === "completed" && latestMessage?.role === "assistant" && latestMessage.text.trim() ? <SaveAnswer messageId={latestMessage.id} /> : null}
              {task.outputArtifacts.map((ref) => <ArtifactResult key={ref.artifactId} id={ref.artifactId} />)}
              {surfaces.map((surface) => <TrustedSurface key={surface.id} surface={surface} busy={busy} onAction={submitSurfaceAction} />)}
              {approval ? <div className="approval-card"><p><strong>需要你的确认</strong><br />{approval.reason ?? `${approval.action} · ${approval.resource}`}</p><div><button type="button" disabled={busy} onClick={() => void decide(approval.approvalId, "rejected")}>拒绝</button><button className="primary-action" type="button" disabled={busy} onClick={() => void decide(approval.approvalId, "approved")}>允许一次</button></div></div> : null}
              <details className="task-debug"><summary>运行详情</summary>{task.parentTaskId ? <small className="task-collaboration">协作任务 · {task.assignedAgentName ?? "Worker Agent"}{task.delegationState ? ` · ${task.delegationState}` : ""}</small> : null}{task.model ? <small className="task-model">模型：{task.model.providerId} / {task.model.modelId} · {task.model.capabilitySource}</small> : null}{task.activatedPluginIds && task.activatedPluginIds.length > 0 ? <small className="task-capabilities">本轮按需启用：{task.activatedPluginIds.join("、")} · 上下文约 {task.contextTokens ?? 0} tokens</small> : null}{messages.length > 1 ? <div className="task-message-history">{messages.slice(0, -1).map((message) => <p key={message.id}>{message.text}</p>)}</div> : null}<code>{task.id}</code></details>
            </div>
          </article>;
        })}
        {tasks.length > 8 ? <button className="task-history-toggle" type="button" onClick={() => setShowAllTasks((value) => !value)}>{showAllTasks ? "收起较早任务" : `查看其余 ${tasks.length - 8} 个任务`}</button> : null}
      </div>
      {error ? <p className="agent-error" role="alert">{error}</p> : null}
      <VoiceControls onText={setGoal} response={snapshot?.messages.filter((message) => tasks.some((task) => task.id === message.taskId) && message.role === "assistant").at(-1)?.text ?? ""} />
      <form className="goal-composer" onSubmit={submit}>
        <ArtifactInputs value={artifactIds} onChange={setArtifactIds} />
        <textarea aria-label="研究或工作目标" rows={3} value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="描述一个目标，例如：整理桌面中的论文并生成阅读计划…" />
        <button className="primary-action" type="submit" disabled={busy || !goal.trim()}>{busy ? "执行中…" : "开始"}</button>
      </form>
    </div>
  );
}

function AppContent({ appKey, payload }: { appKey: AppKey; payload: Record<string, unknown> }) {
  if (appKey === "agent" && typeof payload.instanceId === "string" && typeof payload.sessionId === "string") return <Suspense fallback={<p>正在打开应用…</p>}><AgentSessionWindow key={`${payload.instanceId}:${payload.sessionId}`} instanceId={payload.instanceId} sessionId={payload.sessionId} /></Suspense>;
  if (appKey === "workspace") return <WorkspaceApp />;
  if (appKey === "chat") return <ChatApp />;
  if (appKey === "tasks") return <Suspense fallback={<p className="managed-window-ready">正在加载任务中心…</p>}><TaskCenterApp /></Suspense>;
  if (appKey === "literature") return <Suspense fallback={<p className="managed-window-ready">正在加载文献工作台…</p>}><LiteratureWorkbenchApp /></Suspense>;
  if (appKey === "settings") return <SettingsApp />;
  return null;
}

function InternalWindow({ model, onChange, onFocus }: {
  model: ManagedWindow;
  onChange: (next: ManagedWindow, persist?: boolean) => void;
  onFocus: () => void;
}) {
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const resize = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const definition = model.appKey === "agent" && typeof model.payload.title === "string" ? { ...APP_DEFINITIONS.agent, title: model.payload.title } : APP_DEFINITIONS[model.appKey];
  if (model.state === "minimized") return null;

  const startDrag = (event: React.PointerEvent<HTMLElement>) => {
    if ((event.target as Element).closest("button") || model.state === "maximized") return;
    drag.current = { dx: event.clientX - model.x, dy: event.clientY - model.y };
    event.currentTarget.setPointerCapture(event.pointerId);
    onFocus();
  };

  const moveDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (!drag.current) return;
    onChange(fitWindow({ ...model, x: event.clientX - drag.current.dx, y: event.clientY - drag.current.dy }));
  };

  const stopDrag = () => {
    if (!drag.current) return;
    drag.current = null;
    onChange(model, true);
  };

  const startResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (model.state === "maximized") return;
    event.stopPropagation();
    resize.current = { x: event.clientX, y: event.clientY, width: model.width, height: model.height };
    event.currentTarget.setPointerCapture(event.pointerId);
    onFocus();
  };

  const moveResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!resize.current) return;
    const width = resize.current.width + event.clientX - resize.current.x;
    const height = resize.current.height + event.clientY - resize.current.y;
    onChange(fitWindow({ ...model, width, height }));
  };

  const stopResize = () => {
    if (!resize.current) return;
    resize.current = null;
    onChange(model, true);
  };

  const style = model.state === "maximized"
    ? { inset: "34px 12px 72px", zIndex: model.zIndex }
    : { left: model.x, top: model.y, width: model.width, height: model.height, zIndex: model.zIndex };

  return (
    <section className="managed-window" data-app={model.appKey} style={style} onPointerDown={onFocus} role="dialog" aria-label={definition.title}>
      <header className="managed-window-titlebar" onDoubleClick={() => onChange({ ...model, state: model.state === "maximized" ? "open" : "maximized" }, true)} onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={stopDrag}>
        <div className="leopard-traffic">
          <button className="traffic-close" type="button" aria-label={`关闭${definition.title}`} onClick={() => onChange({ ...model, state: "minimized" }, true)} />
          <button className="traffic-min" type="button" aria-label={`最小化${definition.title}`} onClick={() => onChange({ ...model, state: "minimized" }, true)} />
          <button className="traffic-zoom" type="button" aria-label={`最大化${definition.title}`} onClick={() => onChange({ ...model, state: model.state === "maximized" ? "open" : "maximized" }, true)} />
        </div>
        <strong>{definition.title}</strong>
        <span aria-hidden="true" />
      </header>
      <div className="managed-window-content"><AppContent appKey={model.appKey} payload={model.payload} /></div>
      {model.state !== "maximized" ? <button className="managed-window-resizer" type="button" aria-label={`调整${definition.title}窗口大小`} onPointerDown={startResize} onPointerMove={moveResize} onPointerUp={stopResize} /> : null}
    </section>
  );
}

function WindowManager() {
  const [windows, setWindows] = useState<ManagedWindow[]>(() => pendingApps.map(defaultWindow));
  const [topZ, setTopZ] = useState(60);

  const focusById = (id: string) => {
    setTopZ((currentZ) => {
      const nextZ = currentZ + 1;
      setWindows((current) => current.map((item) => item.id === id ? { ...item, zIndex: nextZ } : item));
      return nextZ;
    });
  };

  useEffect(() => {
    let active = true;
    void window.xilingDesktop?.windowState.list().then((saved) => {
      if (!active) return;
      const restored = saved.flatMap((state): ManagedWindow[] => {
        if (state.appId.startsWith("agent-instance:") && typeof state.payload.instanceId === "string" && typeof state.payload.sessionId === "string") return [fitWindow({ ...state, appKey: "agent" })];
        const appKey = state.id.replace("managed-", "") as AppKey;
        return state.id.startsWith("managed-") && appKey in APP_DEFINITIONS ? [fitWindow({ ...state, appKey })] : [];
      });
      if (restored.length) {
        setWindows((current) => mergeRestoredWindows(current, restored));
        setTopZ(Math.max(60, ...restored.map((item) => item.zIndex)));
      }
    });

    const openListener = (event: Event) => {
      const appKey = (event as CustomEvent<AppKey>).detail;
      if (!(appKey in APP_DEFINITIONS)) return;
      setTopZ((currentZ) => {
        const nextZ = currentZ + 1;
        setWindows((current) => {
          const existing = current.find((item) => item.id === `managed-${appKey}`);
          if (existing) return current.map((item) => item.id === existing.id ? { ...item, state: "open", zIndex: nextZ } : item);
          return [...current, { ...defaultWindow(appKey, current.length), zIndex: nextZ }];
        });
        return nextZ;
      });
    };

    const resizeListener = () => setWindows((current) => current.map(fitWindow));
    const agentListener = (event: Event) => {
      const detail = (event as CustomEvent<{ instanceId?: unknown; sessionId?: unknown; title?: unknown }>).detail;
      if (!detail || typeof detail.instanceId !== "string" || typeof detail.sessionId !== "string" || typeof detail.title !== "string") return;
      const instanceId = detail.instanceId;
      const payload = { instanceId, sessionId: detail.sessionId, title: detail.title };
      setTopZ((currentZ) => {
        const zIndex = currentZ + 1;
        setWindows((current) => {
          const id = `managed-agent-${instanceId}`;
          const existing = current.find((item) => item.id === id);
          const next = fitWindow({ ...(existing ?? defaultWindow("agent", current.length)), id, appId: `agent-instance:${instanceId}`, payload, state: "open", zIndex });
          void saveWindow(next).catch((error: unknown) => console.warn("Unable to save app window", error));
          return existing ? current.map((item) => item.id === id ? next : item) : [...current, next];
        });
        return zIndex;
      });
    };
    window.addEventListener("xiling:open-agent-app", agentListener);
    window.addEventListener("xiling:open-managed-app", openListener);
    window.addEventListener("resize", resizeListener);
    return () => {
      active = false;
      window.removeEventListener("xiling:open-managed-app", openListener);
      window.removeEventListener("resize", resizeListener);
      window.removeEventListener("xiling:open-agent-app", agentListener);
    };
  }, []);

  useEffect(() => {
    const keyboardListener = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const open = windows.filter((item) => item.state !== "minimized").sort((a, b) => b.zIndex - a.zIndex);
      if (event.key === "`" && open.length > 1) {
        event.preventDefault();
        const next = nextWindowToFocus(windows);
        if (next) focusById(next.id);
      }
      if (event.key.toLowerCase() === "w" && open[0]) {
        event.preventDefault();
        const next = { ...open[0], state: "minimized" as const };
        setWindows((current) => current.map((item) => item.id === next.id ? next : item));
        void saveWindow(next);
      }
    };
    window.addEventListener("keydown", keyboardListener);
    return () => window.removeEventListener("keydown", keyboardListener);
  }, [windows]);

  const update = (next: ManagedWindow, persist = false) => {
    setWindows((current) => current.map((item) => item.id === next.id ? next : item));
    if (persist) void saveWindow(next);
  };

  return windows.map((model) => <InternalWindow key={model.id} model={model} onChange={update} onFocus={() => focusById(model.id)} />);
}

export function openManagedApp(appKey: string): void {
  if (!(appKey in APP_DEFINITIONS)) return;
  const typedKey = appKey as AppKey;
  if (!reactRoot) {
    pendingApps.push(typedKey);
    const host = document.createElement("div");
    host.id = "managed-window-root";
    document.querySelector("#leopard")?.append(host);
    reactRoot = createRoot(host);
    reactRoot.render(<StrictMode><WindowManager /></StrictMode>);
    return;
  }
  window.dispatchEvent(new CustomEvent("xiling:open-managed-app", { detail: typedKey }));
}
