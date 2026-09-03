import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fitWindowToViewport, mergeRestoredWindows, nextWindowToFocus } from "../src/windowing/window-model.js";

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

interface DesktopBridge {
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
  workspace: { appId: "system.workspace", title: "工作台", eyebrow: "科研工作空间" },
  chat: { appId: "system.chat", title: "对话", eyebrow: "智能体" },
  research: { appId: "system.research", title: "研究", eyebrow: "科研空间" },
  literature: { appId: "system.literature", title: "文献", eyebrow: "发现与阅读" },
  data: { appId: "system.data", title: "数据", eyebrow: "数据工作区" },
  settings: { appId: "system.settings", title: "设置", eyebrow: "系统" },
} as const;

const APP_COPY: Record<Exclude<keyof typeof APP_DEFINITIONS, "workspace" | "settings">, string> = {
  chat: "在这里与科研智能体协作；运行过程与对话保持同一任务上下文。",
  research: "研究问题、证据、计算与产物将通过可追溯关系组织。",
  literature: "搜索论文、阅读原文并把标注转为可引用证据。",
  data: "连接、检查和组织科研数据；计算运行时按任务加载。",
};

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
  return {
    id: `managed-${appKey}`,
    appId: definition.appId,
    appKey,
    x: 72 + index * 34,
    y: 54 + index * 26,
    width: workspace ? 980 : 660,
    height: workspace ? 610 : 440,
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
          <p className="eyebrow">科研工作空间</p>
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
      <header><div><h3>程序坞大小</h3><p>等比例调整图标、玻璃台面、间距、倒影与指示灯。</p></div><output aria-live="polite">{Math.round(dockScale * 100)}%</output></header>
      <label className="dock-scale-control"><span aria-hidden="true">◆</span><input aria-label="程序坞大小" type="range" min="0.75" max="1.25" step="0.05" value={dockScale} onChange={(event) => update(Number(event.target.value))} /><span aria-hidden="true">◆</span></label>
      <div className="dock-scale-actions"><button type="button" onClick={() => update(1)}>恢复默认大小</button></div>
    </section>
  );
}

function AppContent({ appKey }: { appKey: AppKey }) {
  if (appKey === "workspace") return <WorkspaceApp />;
  if (appKey === "settings") return <DockScaleSettings />;
  return (
    <div className="managed-app-placeholder">
      <p className="eyebrow">{APP_DEFINITIONS[appKey].eyebrow}</p>
      <h2>{APP_DEFINITIONS[appKey].title}</h2>
      <p>{APP_COPY[appKey]}</p>
      <div className="managed-window-ready">应用能力已注册 · 内容将在使用时加载</div>
    </div>
  );
}

function InternalWindow({ model, onChange, onFocus }: {
  model: ManagedWindow;
  onChange: (next: ManagedWindow, persist?: boolean) => void;
  onFocus: () => void;
}) {
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const resize = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const definition = APP_DEFINITIONS[model.appKey];
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
      <div className="managed-window-content"><AppContent appKey={model.appKey} /></div>
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
          const existing = current.find((item) => item.appKey === appKey);
          if (existing) return current.map((item) => item.id === existing.id ? { ...item, state: "open", zIndex: nextZ } : item);
          return [...current, { ...defaultWindow(appKey, current.length), zIndex: nextZ }];
        });
        return nextZ;
      });
    };

    const resizeListener = () => setWindows((current) => current.map(fitWindow));
    window.addEventListener("xiling:open-managed-app", openListener);
    window.addEventListener("resize", resizeListener);
    return () => {
      active = false;
      window.removeEventListener("xiling:open-managed-app", openListener);
      window.removeEventListener("resize", resizeListener);
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
