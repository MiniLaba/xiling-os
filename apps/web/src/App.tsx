import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FREE_EXPLORATION_PROJECT_ID } from "@xiling/contracts";
import {
  AlertTriangle, BookOpen, ChevronDown, FolderKanban, LayoutGrid, MessageSquare, Network, Plus, Search, Settings, Trash2, X,
} from "lucide-react";
import { WorkspaceProvider, useWorkspace } from "./workspace/WorkspaceContext.js";
import { ConversationProvider, useConversations } from "./workspace/ConversationContext.js";
import { ToastProvider, useToast } from "./components/ui/toast.js";
import { Dialog } from "./components/ui/dialog.js";
import { HomeView } from "./home/HomeView.js";
import { useLocale } from "./lib/locale.js";

const ChatView = lazy(async () => ({ default: (await import("./chat/ChatView.js")).ChatView }));
const PaperGraphView = lazy(async () => ({ default: (await import("./papers/PaperGraphView.js")).PaperGraphView }));
const ProjectView = lazy(async () => ({ default: (await import("./project/ProjectView.js")).ProjectView }));
const WikiView = lazy(async () => ({ default: (await import("./wiki/WikiView.js")).WikiView }));
const SettingsView = lazy(async () => ({ default: (await import("./settings/SettingsView.js")).SettingsView }));
const ScientificCanvasView = lazy(async () => ({ default: (await import("./canvas/ScientificCanvasView.js")).ScientificCanvasView }));
const AttentionView = lazy(async () => ({ default: (await import("./attention/AttentionView.js")).AttentionView }));

type View = "home" | "chat" | "attention" | "canvas" | "project" | "wiki" | "papers" | "settings";

const labels: Record<View, string> = {
  home: "首页",
  chat: "对话",
  attention: "需要关注",
  canvas: "科研画布",
  project: "项目",
  wiki: "Wiki",
  papers: "文献工作台",
  settings: "设置",
};

const iconSize = 17;
const icons: Record<View, React.ReactNode> = {
  home: <MessageSquare size={iconSize} aria-hidden="true" />,
  chat: <MessageSquare size={iconSize} aria-hidden="true" />,
  attention: <AlertTriangle size={iconSize} aria-hidden="true" />,
  canvas: <LayoutGrid size={iconSize} aria-hidden="true" />,
  project: <FolderKanban size={iconSize} aria-hidden="true" />,
  wiki: <BookOpen size={iconSize} aria-hidden="true" />,
  papers: <Network size={iconSize} aria-hidden="true" />,
  settings: <Settings size={iconSize} aria-hidden="true" />,
};

const navigationItems: Exclude<View, "settings">[] = ["chat", "attention", "canvas", "wiki", "papers"];

export function App() {
  return (
    <ToastProvider>
      <WorkspaceProvider><ConversationProvider><WorkspaceApp /></ConversationProvider></WorkspaceProvider>
    </ToastProvider>
  );
}

function WorkspaceApp() {
  const { locale, setLocale, t } = useLocale();
  const localizedLabels = Object.fromEntries(Object.entries(labels).map(([key, value]) => [key, t(value)])) as Record<View, string>;
  const [dockPinned, setDockPinned] = useState(false);
  const [view, setView] = useState<View>("home");
  const [viewHistory, setViewHistory] = useState<View[]>([]);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [commandIndex, setCommandIndex] = useState(0);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; title: string } | undefined>();
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const commandListRef = useRef<HTMLDivElement>(null);
  const { projects, activeProject, activeProjectId, setActiveProjectId, refreshProjects, loading, error } = useWorkspace();
  const { sessions, activeSessionId, loading: sessionsLoading, selectSession, startNewConversation, deleteSession } = useConversations();
  const { push } = useToast();

  useEffect(() => {
    if (!projectMenuOpen) return;
    const close = (event: PointerEvent) => { if (!projectMenuRef.current?.contains(event.target as Node)) setProjectMenuOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [projectMenuOpen]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") { event.preventDefault(); setCommandOpen((open) => !open); setCommandIndex(0); } if (event.key === "Escape") setCommandOpen(false); };
    window.addEventListener("keydown", shortcut); return () => window.removeEventListener("keydown", shortcut);
  }, []);
  const navigateToView = useCallback((next: View) => {
    if (next === view) return;
    setViewHistory((history) => [...history.slice(-19), view]);
    setView(next);
  }, [view]);
  const goBack = () => {
    const previous = viewHistory[viewHistory.length - 1];
    if (previous === undefined) return;
    setViewHistory((history) => history.slice(0, -1));
    setView(previous);
  };

  const commandActions = useMemo(() => {
    const query = commandQuery.trim().toLocaleLowerCase();
    const viewActions = (Object.keys(labels) as View[])
      .filter((target) => target !== "project")
      .filter((target) => !query || t(labels[target]).toLocaleLowerCase().includes(query))
      .map((target) => ({ id: `view:${target}`, label: t(labels[target]), hint: t("打开视图"), run: () => { navigateToView(target); } }));
    const projectActions = [...projects]
      .sort((a, b) => (a.id === FREE_EXPLORATION_PROJECT_ID ? -1 : b.id === FREE_EXPLORATION_PROJECT_ID ? 1 : 0))
      .filter((project) => !query || `${project.name} ${project.researchQuestion}`.toLocaleLowerCase().includes(query))
      .map((project) => ({ id: `project:${project.id}`, label: project.name, hint: project.id === activeProjectId ? "当前项目" : "切换项目", run: () => { setActiveProjectId(project.id); } }));
    return [...viewActions, ...projectActions];
  }, [commandQuery, projects, activeProjectId, setActiveProjectId, navigateToView, locale]);

  const runCommandAction = (index: number) => {
    const action = commandActions[index];
    if (!action) return;
    action.run();
    setCommandOpen(false);
    setCommandQuery("");
    setCommandIndex(0);
  };

  const onCommandKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setCommandIndex((index) => commandActions.length ? (index + delta + commandActions.length) % commandActions.length : 0);
      const list = commandListRef.current;
      const active = list?.querySelector<HTMLElement>('[data-active="true"]');
      active?.scrollIntoView({ block: "nearest" });
    }
    if (event.key === "Enter") { event.preventDefault(); runCommandAction(commandIndex); }
  };

  const confirmDeleteSession = async () => {
    if (!pendingDelete) return;
    try {
      await deleteSession(pendingDelete.id);
      push({ title: `对话「${pendingDelete.title}」已删除`, tone: "success" });
    } catch (cause) {
      push({ title: "删除对话失败", description: cause instanceof Error ? cause.message : String(cause), tone: "danger" });
    }
    setPendingDelete(undefined);
  };

  // 启动首页：不依赖工作区数据，点击「进入工作区」后才进入现在的首页（对话）。
  if (view === "home") {
    return (
      <main className="home-shell">
        <HomeView onEnter={navigateToView} />
        <Dialog open={pendingDelete !== undefined} onClose={() => setPendingDelete(undefined)} title={t("删除对话")} width={420}
          footer={<>
            <button className="xl-btn" data-variant="ghost" onClick={() => setPendingDelete(undefined)}>{t("取消")}</button>
            <button className="xl-btn" data-variant="danger" onClick={confirmDeleteSession}>{t("删除")}</button>
          </>}>
          <p>确定删除对话「<b>{pendingDelete?.title}</b>」吗？对话中的推演记录将一并移除，删除后不可恢复。</p>
        </Dialog>
      </main>
    );
  }
  if (loading && !activeProject) return <main className="shell"><div className="view-loading">{t("正在恢复科研工作区…")}</div></main>;
  if (!activeProject) return <main className="shell"><div className="view-loading">{error ?? "没有可用科研项目"}</div></main>;

  return (
    <main className={`shell liquid-shell ${view === "settings" ? "settings-mode" : ""}`}>
      {view !== "settings" ? <aside className={`sidebar liquid-dock ${dockPinned || projectMenuOpen ? "dock-open" : ""}`} aria-label={t("工作区")}>
        <button className="dock-toggle" aria-expanded={dockPinned} aria-label={locale === "en" ? "Pin navigation" : "固定导航栏"} onClick={() => setDockPinned((value) => !value)}><LayoutGrid size={19} /><span>{locale === "en" ? "Workspace" : "工作空间"}</span></button>
        <div className="sidebar-brand">
          <div className="brand-mark"><img src="/brand/xiling-mark.png" alt="" /></div>
          <div className="brand-text"><b>{t("汐灵")}</b><small>SCIENCE OS</small></div>
        </div>
        <div className="project-switcher" ref={projectMenuRef}>
          <button className="project-switcher-trigger" aria-expanded={projectMenuOpen} onClick={() => setProjectMenuOpen((open) => !open)}>
            <span><small>{t("当前项目")}</small><b>{activeProject.name}{activeProject.id === FREE_EXPLORATION_PROJECT_ID ? <em className="project-badge-free">{t("开放问答")}</em> : null}</b><em>{activeProject.researchQuestion}</em></span><ChevronDown size={15} aria-hidden="true" />
          </button>
          {projectMenuOpen ? <div className="project-switcher-menu">
            <header><b>{t("科研项目")}</b><small>{projects.length} 个进行中</small></header>
            <div>{[...projects].sort((a, b) => (a.id === FREE_EXPLORATION_PROJECT_ID ? -1 : b.id === FREE_EXPLORATION_PROJECT_ID ? 1 : 0)).map((project) => <button className={project.id === activeProjectId ? "active" : ""} key={project.id} onClick={() => { setActiveProjectId(project.id); setProjectMenuOpen(false); }}><i>{project.id === activeProjectId ? "✓" : ""}</i><span><b>{project.name}{project.id === FREE_EXPLORATION_PROJECT_ID ? <em className="project-badge-free">{t("开放问答")}</em> : null}</b><small>{project.researchQuestion}</small></span></button>)}</div>
            <footer><button onClick={() => { navigateToView("project"); setProjectMenuOpen(false); }}><Plus size={14} aria-hidden="true" /> 新建或管理项目</button></footer>
          </div> : null}
        </div>
        <button className="new-conversation-btn" aria-label={t("新建对话")} title={t("新建对话")} onClick={() => { startNewConversation(); navigateToView("chat"); }}>
          <Plus size={16} aria-hidden="true" /><span>{t("新建对话")}</span>
        </button>
        <nav className="sidebar-nav">
          {navigationItems.map((item) => (
            <button aria-label={localizedLabels[item]} title={localizedLabels[item]} aria-current={view === item ? "page" : undefined} className={view === item ? "active" : ""} key={item} onClick={() => navigateToView(item)}>
              {icons[item]}
              <span>{localizedLabels[item]}</span>
            </button>
          ))}
        </nav>
        <div className="recent-work">
          <header><small>{t("对话历史")}</small>{sessions.length ? <span>{sessions.length}</span> : null}</header>
          {sessionsLoading ? <p className="session-loading">{t("正在恢复…")}</p> : sessions.length ? (
            <div className="session-list">
              {sessions.map((session) => (
                <div className={`session-item ${view === "chat" && session.id === activeSessionId ? "active" : ""}`} key={session.id}>
                  <button onClick={() => { selectSession(session.id); navigateToView("chat"); }}>
                    <i>●</i>
                    <span><b>{session.title}</b><small>{formatSessionTime(session.updatedAt)} · {session.messageCount} 条</small></span>
                  </button>
                  <button className="session-delete" aria-label={`删除对话「${session.title}」`} title={t("删除对话")} onClick={(event) => { event.stopPropagation(); setPendingDelete({ id: session.id, title: session.title }); }}><Trash2 size={13} aria-hidden="true" /></button>
                </div>
              ))}
            </div>
          ) : <p className="session-empty">{t("这个项目还没有对话")}</p>}
        </div>
        <div className="sidebar-footer">
          <button className="settings-entry" onClick={() => navigateToView("settings")} aria-label={t("设置")}>
            <Settings size={16} aria-hidden="true" /><span>{t("设置")}</span>
          </button>
        </div>
      </aside> : null}
      <section className={`workspace workspace-${view}`}>
        <header className="workspace-header">
          <div className="workspace-title">
            <button aria-label={t("返回上一视图")} title={t("返回上一视图")} disabled={!viewHistory.length} onClick={goBack}>‹</button>
            <strong>{localizedLabels[view]}</strong>
            <span>{activeProject.name}</span>
          </div>
          <button className="locale-switch" onClick={() => setLocale(locale === "en" ? "zh-CN" : "en")} aria-label={locale === "en" ? "Switch to Chinese" : "切换至英文"}>{locale === "en" ? "中文" : "EN"}</button>
          {view === "settings"
            ? null
            : <div className="workspace-actions">
                <button onClick={() => { setCommandOpen(true); setCommandIndex(0); }}><Search size={14} aria-hidden="true" /><kbd aria-hidden="true">Ctrl K</kbd> {t("搜索与跳转")}</button>
              </div>
          }
        </header>
        <div className="workspace-body">
          <Suspense fallback={<div className="view-loading">{t("按需加载当前视图…")}</div>}>
            {view === "chat" ? <ChatView project={activeProject} />
              : view === "attention" ? <AttentionView projectId={activeProjectId} onNavigate={navigateToView} />
              : view === "canvas" ? <ScientificCanvasView projectId={activeProjectId} onNavigate={navigateToView} />
              : view === "project" ? <ProjectView projectId={activeProjectId} projects={projects} onProjectChange={setActiveProjectId} onProjectsChange={refreshProjects} />
              : view === "wiki" ? <WikiView projectId={activeProjectId} onNavigate={navigateToView} />
              : view === "papers" ? <PaperGraphView projectId={activeProjectId} onNavigate={navigateToView} />
              : view === "settings" ? <SettingsView />
              : <Placeholder title={labels[view]} />}
          </Suspense>
        </div>
      </section>
      {commandOpen ? <div className="command-palette" role="dialog" aria-modal="true" aria-label="搜索与跳转" onKeyDown={onCommandKeyDown} onPointerDown={(event) => { if (event.target === event.currentTarget) setCommandOpen(false); }}>
        <div>
          <header>
            <input autoFocus placeholder="跳转页面、切换项目或新建对话…" value={commandQuery} onChange={(event) => { setCommandQuery(event.target.value); setCommandIndex(0); }} />
            <kbd>ESC</kbd>
          </header>
          <div ref={commandListRef} style={{ overflow: "auto", minHeight: 0 }}>
            <section>
              <small>{t("工作区")}</small>
              {commandActions.filter((action) => action.id.startsWith("view:")).map((action) => {
                const index = commandActions.indexOf(action);
                const target = action.id.slice(5) as View;
                return (
                  <button key={action.id} data-active={index === commandIndex} onClick={() => runCommandAction(index)} onPointerMove={() => setCommandIndex(index)}>
                    {icons[target]}
                    <span>{action.label}</span>
                    <em>{action.hint}</em>
                  </button>
                );
              })}
            </section>
            <section>
              <small>{t("科研项目")}</small>
              {commandActions.filter((action) => action.id.startsWith("project:")).map((action) => {
                const index = commandActions.indexOf(action);
                return (
                  <button key={action.id} data-active={index === commandIndex} onClick={() => runCommandAction(index)} onPointerMove={() => setCommandIndex(index)}>
                    <span>◎ {action.label}</span>
                    <em>{action.hint}</em>
                  </button>
                );
              })}
            </section>
          </div>
          <footer>
            <button onClick={() => { startNewConversation(); navigateToView("chat"); setCommandOpen(false); }}><Plus size={14} aria-hidden="true" /> 新建研究对话</button>
          </footer>
        </div>
      </div> : null}
      <Dialog open={pendingDelete !== undefined} onClose={() => setPendingDelete(undefined)} title={t("删除对话")} width={420}
        footer={<>
          <button className="xl-btn" data-variant="ghost" onClick={() => setPendingDelete(undefined)}>{t("取消")}</button>
          <button className="xl-btn" data-variant="danger" onClick={confirmDeleteSession}>{t("删除")}</button>
        </>}>
        <p>确定删除对话「<b>{pendingDelete?.title}</b>」吗？对话中的推演记录将一并移除，删除后不可恢复。</p>
      </Dialog>
    </main>
  );
}

function formatSessionTime(value: string): string {
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

function Placeholder({ title }: { title: string }) {
  return <div className="placeholder"><span>RESEARCH WORKSPACE</span><h1>{title}</h1><p>当前领域尚未贡献该工作台模块。</p></div>;
}
