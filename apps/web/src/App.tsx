import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { FREE_EXPLORATION_PROJECT_ID } from "@xiling/contracts";
import { WorkspaceProvider, useWorkspace } from "./workspace/WorkspaceContext.js";
import { ConversationProvider, useConversations } from "./workspace/ConversationContext.js";

const ChatView = lazy(async () => ({ default: (await import("./chat/ChatView.js")).ChatView }));
const OutputPanel = lazy(async () => ({ default: (await import("./chat/OutputPanel.js")).OutputPanel }));
const PaperGraphView = lazy(async () => ({ default: (await import("./papers/PaperGraphView.js")).PaperGraphView }));
const ProjectView = lazy(async () => ({ default: (await import("./project/ProjectView.js")).ProjectView }));
const WikiView = lazy(async () => ({ default: (await import("./wiki/WikiView.js")).WikiView }));
const SettingsView = lazy(async () => ({ default: (await import("./settings/SettingsView.js")).SettingsView }));
const ScientificCanvasView = lazy(async () => ({ default: (await import("./canvas/ScientificCanvasView.js")).ScientificCanvasView }));
const AttentionView = lazy(async () => ({ default: (await import("./attention/AttentionView.js")).AttentionView }));

type View = "chat" | "attention" | "canvas" | "project" | "wiki" | "papers" | "settings";

const labels: Record<View, string> = {
  chat: "对话",
  attention: "需要关注",
  canvas: "科研画布",
  project: "项目",
  wiki: "Wiki",
  papers: "文献图",
  settings: "设置",
};

const icons: Record<View, ReactNode> = {
  chat: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h7A2.5 2.5 0 0 1 16 5.5v4a2.5 2.5 0 0 1-2.5 2.5H9l-3.8 3v-3.3A2.5 2.5 0 0 1 4 9.5z" /></>,
  attention: <><path d="M10 2.8 17 16H3z"/><path d="M10 7v4m0 2.5v.2"/></>,
  canvas: <><circle cx="5" cy="5" r="2"/><circle cx="15" cy="6" r="2"/><circle cx="10" cy="15" r="2"/><path d="m7 5.2 6 .6M6.2 6.7l2.7 6.5m4.8-5.5-2.6 5.5"/></>,
  project: <><path d="M3 6.5h14v10H3zM3 6.5l3-3h4l2 3" /></>,
  wiki: <><path d="M4 3.5h9a3 3 0 0 1 3 3v10H7a3 3 0 0 1-3-3zM7 6.5h6M7 10h6" /></>,
  papers: <><circle cx="6" cy="6" r="2.5" /><circle cx="14.5" cy="5" r="2.5" /><circle cx="11" cy="14.5" r="2.5" /><path d="m8.4 5.7 3.6-.4M7.2 8.2l2.7 4.1m3.1-5  -1.1 4.8" /></>,
  settings: <><circle cx="10" cy="10" r="2.5" /><path d="M10 2.5v2m0 11v2m7.5-7.5h-2m-11 0h-2m12.8-5.3-1.4 1.4M6.1 13.9l-1.4 1.4m10.6 0-1.4-1.4M6.1 6.1 4.7 4.7" /></>,
};

const navigationGroups = [
  { title: "科研工作台", items: ["chat", "attention", "canvas"] },
  { title: "科研知识库", items: ["project", "wiki", "papers"] },
] as const;

export function App() {
  return <WorkspaceProvider><ConversationProvider><WorkspaceApp /></ConversationProvider></WorkspaceProvider>;
}

function WorkspaceApp() {
  const [view, setView] = useState<View>("chat");
  const [viewHistory, setViewHistory] = useState<View[]>([]);
  const lastViewRef = useRef<View>("chat");
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const { projects, activeProject, activeProjectId, setActiveProjectId, refreshProjects, loading, error } = useWorkspace();
  const { sessions, activeSessionId, loading: sessionsLoading, selectSession, startNewConversation, deleteSession } = useConversations();

  useEffect(() => {
    if (!projectMenuOpen) return;
    const close = (event: PointerEvent) => { if (!projectMenuRef.current?.contains(event.target as Node)) setProjectMenuOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [projectMenuOpen]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") { event.preventDefault(); setCommandOpen((open) => !open); } if (event.key === "Escape") setCommandOpen(false); };
    window.addEventListener("keydown", shortcut); return () => window.removeEventListener("keydown", shortcut);
  }, []);
  // 视图导航历史：任何视图切换都把来源视图压栈，顶栏返回键据此回到上一视图
  useEffect(() => {
    if (view === lastViewRef.current) return;
    setViewHistory((history) => [...history.slice(-19), lastViewRef.current]);
    lastViewRef.current = view;
  }, [view]);
  const goBack = () => {
    const previous = viewHistory[viewHistory.length - 1];
    if (previous === undefined) return;
    lastViewRef.current = previous;
    setViewHistory((history) => history.slice(0, -1));
    setView(previous);
  };

  if (loading && !activeProject) return <main className="shell"><div className="view-loading">正在恢复科研工作区…</div></main>;
  if (!activeProject) return <main className="shell"><div className="view-loading">{error ?? "没有可用科研项目"}</div></main>;

  return (
    <main className={`shell ${view === "settings" ? "settings-mode" : ""}`}>
      {view !== "settings" ? <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="brand-mark"><img src="/brand/xiling-mark.png" alt="" /></div>
          <div className="brand-text"><b>汐灵</b><small>SCIENCE OS</small></div>
        </div>
        <div className="project-switcher" ref={projectMenuRef}>
          <button className="project-switcher-trigger" aria-expanded={projectMenuOpen} onClick={() => setProjectMenuOpen((open) => !open)}>
            <span><small>当前项目</small><b>{activeProject.name}{activeProject.id === FREE_EXPLORATION_PROJECT_ID ? <em className="project-badge-free">开放问答</em> : null}</b><em>{activeProject.researchQuestion}</em></span><i>⌄</i>
          </button>
          {projectMenuOpen ? <div className="project-switcher-menu">
            <header><b>科研项目</b><small>{projects.length} 个进行中</small></header>
            <div>{[...projects].sort((a, b) => (a.id === FREE_EXPLORATION_PROJECT_ID ? -1 : b.id === FREE_EXPLORATION_PROJECT_ID ? 1 : 0)).map((project) => <button className={project.id === activeProjectId ? "active" : ""} key={project.id} onClick={() => { setActiveProjectId(project.id); setProjectMenuOpen(false); }}><i>{project.id === activeProjectId ? "✓" : ""}</i><span><b>{project.name}{project.id === FREE_EXPLORATION_PROJECT_ID ? <em className="project-badge-free">开放问答</em> : null}</b><small>{project.researchQuestion}</small></span></button>)}</div>
            <footer><button onClick={() => { setView("project"); setProjectMenuOpen(false); }}>＋ 新建或管理项目</button></footer>
          </div> : null}
        </div>
        <nav className="sidebar-nav">
          {navigationGroups.map((group) => (
            <div className="nav-group" key={group.title}>
              <div className="nav-group-title">{group.title}</div>
              {group.items.map((item) => (
                <button aria-current={view === item ? "page" : undefined} className={view === item ? "active" : ""} key={item} onClick={() => setView(item)}>
                  <svg viewBox="0 0 20 20" aria-hidden="true">{icons[item]}</svg>
                  {labels[item]}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="recent-work">
          <header><small>对话历史</small>{sessions.length ? <span>{sessions.length}</span> : null}</header>
          {sessionsLoading ? <p className="session-loading">正在恢复…</p> : sessions.length ? (
            <div className="session-list">
              {sessions.map((session) => (
                <div className={`session-item ${view === "chat" && session.id === activeSessionId ? "active" : ""}`} key={session.id}>
                  <button onClick={() => { selectSession(session.id); setView("chat"); }}>
                    <i>●</i>
                    <span><b>{session.title}</b><small>{formatSessionTime(session.updatedAt)} · {session.messageCount} 条</small></span>
                  </button>
                  <button className="session-delete" aria-label={`删除对话「${session.title}」`} title="删除对话" onClick={(event) => { event.stopPropagation(); if (window.confirm(`确定删除对话「${session.title}」吗？删除后不可恢复。`)) void deleteSession(session.id); }}>✕</button>
                </div>
              ))}
            </div>
          ) : <p className="session-empty">这个项目还没有对话</p>}
        </div>
        <div className="sidebar-footer">
          <button className="new-conversation-btn" onClick={() => { startNewConversation(); setView("chat"); }}>
            <span>＋</span><span>新建对话</span>
          </button>
          <button className="settings-btn" onClick={() => setView("settings")} aria-label="设置">
            <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true" style={{stroke:"currentColor",fill:"none",strokeWidth:"1.8",strokeLinecap:"round",strokeLinejoin:"round"}}><circle cx="10" cy="10" r="2.5"/><path d="M10 2.5v2m0 11v2m7.5-7.5h-2m-11 0h-2m12.8-5.3-1.4 1.4M6.1 13.9l-1.4 1.4m10.6 0-1.4-1.4M6.1 6.1 4.7 4.7"/></svg>
          </button>
        </div>
      </aside> : null}
      <section className="workspace">
        <header className="workspace-header">
          <div className="workspace-title">
            <button aria-label="返回上一视图" title="返回上一视图" disabled={!viewHistory.length} onClick={goBack}>‹</button>
            <strong>{labels[view]}</strong>
            <span>{activeProject.name}</span>
          </div>
          {view === "settings"
            ? <div className="settings-top-status"><i />本地设置 · 凭据不会回传</div>
            : <div className="workspace-actions">
                <span className="save-state">● 本地已保存</span>
                <button onClick={() => setCommandOpen(true)}><kbd aria-hidden="true">Ctrl K</kbd> 搜索与跳转</button>
              </div>
          }
        </header>
        <div className="workspace-body">
          <Suspense fallback={<div className="view-loading">按需加载当前视图…</div>}>
            {view === "chat" ? <ChatView project={activeProject} />
              : view === "attention" ? <AttentionView projectId={activeProjectId} onNavigate={setView} />
              : view === "canvas" ? <ScientificCanvasView projectId={activeProjectId} onNavigate={setView} />
              : view === "project" ? <ProjectView projectId={activeProjectId} projects={projects} onProjectChange={setActiveProjectId} onProjectsChange={refreshProjects} />
              : view === "wiki" ? <WikiView projectId={activeProjectId} onNavigate={setView} />
              : view === "papers" ? <PaperGraphView projectId={activeProjectId} onNavigate={setView} />
              : view === "settings" ? <SettingsView />
              : <Placeholder title={labels[view]} />}
          </Suspense>
        </div>
      </section>
      {view === "chat" ? <OutputPanel project={activeProject} activeSessionId={activeSessionId} /> : null}
      {commandOpen ? <div className="command-palette" role="dialog" aria-modal="true" aria-label="搜索与跳转">
        <div>
          <header>
            <input autoFocus placeholder="跳转页面、切换项目或新建对话…" value={commandQuery} onChange={(event) => setCommandQuery(event.target.value)} />
            <kbd>ESC</kbd>
          </header>
          <section>
            <small>工作区</small>
            {(Object.keys(labels) as View[]).filter((target) => labels[target].includes(commandQuery.trim()) || !commandQuery.trim()).map((target) => (
              <button key={target} onClick={() => { setView(target); setCommandOpen(false); setCommandQuery(""); }}>
                <svg viewBox="0 0 20 20">{icons[target]}</svg>
                <span>{labels[target]}</span>
                <em>打开</em>
              </button>
            ))}
          </section>
          <section>
            <small>科研项目</small>
            {[...projects].sort((a, b) => (a.id === FREE_EXPLORATION_PROJECT_ID ? -1 : b.id === FREE_EXPLORATION_PROJECT_ID ? 1 : 0)).filter((project) => `${project.name} ${project.researchQuestion}`.toLocaleLowerCase().includes(commandQuery.trim().toLocaleLowerCase()) || !commandQuery.trim()).map((project) => (
              <button key={project.id} onClick={() => { setActiveProjectId(project.id); setCommandOpen(false); setCommandQuery(""); }}>
                <span>◎ {project.name}{project.id === FREE_EXPLORATION_PROJECT_ID ? <em className="project-badge-free">开放问答</em> : null}</span>
                <em>{project.id === activeProjectId ? "当前" : "切换"}</em>
              </button>
            ))}
          </section>
          <footer>
            <button onClick={() => { startNewConversation(); setView("chat"); setCommandOpen(false); }}>＋ 新建研究对话</button>
          </footer>
        </div>
      </div> : null}
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
