import { lazy, Suspense, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TrustedSurface, type OsSnapshot } from "../window-runtime.js";
import { selectSession, selectedSession } from "./session-selection.js";
import { ArtifactInputs, ArtifactResult } from "./artifact-inputs.js";
import { VoiceControls } from "./voice.js";

const Hiyori = lazy(() => import("./hiyori.js"));
/** 伴侣面板的科研作用域：与科研窗口共用同一个注册表，所以权限衰减与跨项目拒绝同规则。 */
const COMPANION_WINDOW = "system.companion";
/** Shared OS task/session; the character is AIRI's default Hiyori (Pro). */
export function Companion() {
  const [artifactIds, setArtifactIds] = useState<string[]>([]);
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [projectId, setProjectId] = useState("");
  const [open, setOpen] = useState(true);
  const [snapshot, setSnapshot] = useState<OsSnapshot>();
  const [sessionId, setSessionId] = useState(selectedSession);
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [artifact, setArtifact] = useState<{ artifactId: string; name: string; content: string; truncated: boolean }>();
  const [motion, setMotion] = useState(() => localStorage.getItem("xiling:companion-motion") !== "off");
  const bridge = window.xilingDesktop;
  useEffect(() => {
    const change = () => { setSessionId(selectedSession()); setArtifact(undefined); };
    window.addEventListener("xiling:main-session-change", change);
    return () => window.removeEventListener("xiling:main-session-change", change);
  }, []);
  useEffect(() => {
    if (!open || !bridge) return;
    let live = true, loading = false, dirty = false;
    const refresh = async () => {
      if (loading) { dirty = true; return; }
      loading = true;
      try { do { dirty = false; const next = await bridge.getOsSnapshot(); if (live) setSnapshot(next); } while (dirty && live); }
      catch (error) { if (live) setError(error instanceof Error ? error.message : String(error)); }
      finally { loading = false; }
    };
    void refresh();
    const unsubscribe = bridge.tasks.onChanged(() => { void refresh(); });
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", escape);
    return () => { live = false; unsubscribe(); window.removeEventListener("keydown", escape); };
  }, [bridge, open]);
  // 科研作用域：伴侣面板与科研窗口读同一个注册表，绑定事实在核心进程
  useEffect(() => {
    if (!open || !bridge) return;
    let live = true;
    void (async () => {
      try {
        const listed = await bridge.researchKnowledge({ action: "projects.list" });
        const status = await bridge.researchKnowledge({ action: "scope.status", windowId: COMPANION_WINDOW });
        if (!live) return;
        setProjects(listed.projects ?? []);
        setProjectId(status.binding?.projectId ?? "");
      } catch (error) { if (live) setError(error instanceof Error ? error.message : String(error)); }
    })();
    return () => { live = false; };
  }, [bridge, open]);
  const sessions = snapshot?.sessions.filter((session) => session.agentId === snapshot.mainAgentId && session.state === "active") ?? [];
  const tasks = snapshot?.tasks.filter((task) => sessionId && task.sessionId === sessionId) ?? [];
  const active = tasks.find((task) => !["completed", "failed", "cancelled"].includes(task.state));
  const latest = active ?? tasks[0];
  const message = snapshot?.messages.filter((message) => message.taskId === latest?.id && message.role === "assistant").at(-1);
  const mood = !open ? "idle" : active?.state === "running" ? "working" : active?.state.startsWith("waiting_") ? "waiting" : latest?.state === "failed" ? "attention" : "idle";
  const status = mood === "working" ? "正在处理你的目标" : mood === "waiting" ? "有一项工作正在等待" : mood === "attention" ? "任务遇到了问题" : "汐灵，在这里";
  const perform = async (work: () => Promise<unknown>) => { if (busy) return; setBusy(true); setError(""); try { await work(); } catch (error) { setError(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } };
  return <aside className="xiling-companion" data-motion={motion && open ? "on" : "off"} data-mood={mood} aria-label="汐灵虚拟伴侣">
    {open && <section className="companion-panel" aria-label="与汐灵交互">
      <header><div><small>HIYORI · 汐灵伴侣</small><strong>{status}</strong></div><button aria-label="收起伴侣面板" onClick={() => setOpen(false)}>−</button><button aria-label="关闭虚拟伴侣" onClick={() => setCompanionEnabled(false)}>×</button></header>
      {!bridge && <p role="alert">请在原生桌面应用中使用，浏览器预览不能运行任务。</p>}
      <label>工作会话<select value={sessionId ?? ""} disabled={busy} onChange={(event) => selectSession(event.target.value || undefined)}><option value="">新会话</option>{sessions.map((session) => <option key={session.id} value={session.id}>{session.title || "会话"} · {new Date(session.startedAt).toLocaleString()}</option>)}</select></label>
      <label>科研项目<select aria-label="伴侣的科研项目" value={projectId} disabled={busy || projects.length === 0} onChange={(event) => { const next = event.target.value; if (!next || !bridge) return; void perform(async () => { const bound = await bridge.researchKnowledge({ action: "scope.bind", windowId: COMPANION_WINDOW, projectId: next, confirm: true }); setProjectId(bound.binding?.projectId ?? ""); }); }}><option value="">{projects.length ? "不归属项目" : "还没有科研项目"}</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      {latest && <article className="companion-task" aria-live="polite"><strong>{latest.goal}</strong><p>{latest.statusReason || (latest.state === "completed" ? "已完成" : latest.state === "cancelled" ? "已取消" : status)}</p>{message && <details><summary>{message.text.slice(0, 130)}{message.text.length > 130 ? "… 展开回答" : ""}</summary><p className="companion-text">{message.text}</p></details>}
        {active && (active.state !== "running" || active.canCancelRunning) && <button disabled={busy} onClick={() => void perform(() => bridge!.tasks.cancel(active.id))}>取消此任务</button>}
        {latest.outputArtifacts.map((ref) => <ArtifactResult key={ref.artifactId} id={ref.artifactId} />)}
      </article>}
      {artifact && <section className="companion-artifact"><strong>{artifact.name}</strong><button aria-label="关闭产物预览" onClick={() => setArtifact(undefined)}>×</button><button disabled={artifact.truncated || busy} onClick={() => void perform(() => bridge!.artifacts.exportText(artifact.artifactId))}>导出到电脑</button><pre>{artifact.content}</pre>{artifact.truncated && <p>仅预览前 200,000 字符。</p>}</section>}
      {snapshot?.surfaces.filter((surface) => surface.taskId === latest?.id).map((surface) => <TrustedSurface key={surface.id} surface={surface} busy={busy} onAction={(id, action, input) => perform(async () => { await bridge!.submitUiAction(id, action, input); setSnapshot(await bridge!.getOsSnapshot()); })} />)}
      {error && <p role="alert">{error}</p>}
      <VoiceControls onText={setGoal} response={message?.text ?? ""} />
      <form onSubmit={(event) => { event.preventDefault(); const text = goal.trim(); if (!text || !bridge) return; void perform(async () => { const result = await bridge.submitGoal(text, sessionId, artifactIds, projectId ? { projectId, windowId: COMPANION_WINDOW } : undefined); selectSession(result.task.sessionId); setGoal(""); setArtifactIds([]); }); }}>
        <ArtifactInputs value={artifactIds} onChange={setArtifactIds} />
        <label>告诉汐灵你的目标<textarea rows={3} maxLength={12000} value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="例如：整理一份旅行准备清单，保存为产物" /></label>
        <button disabled={busy || !bridge || !goal.trim()} type="submit">{busy ? "处理中…" : "交给汐灵"}</button>
      </form>
      <footer><button onClick={() => { window.dispatchEvent(new CustomEvent("xiling:companion-open-app", { detail: "chat" })); }}>打开完整对话</button><button onClick={() => window.dispatchEvent(new CustomEvent("xiling:companion-open-app", { detail: "tasks" }))}>任务与审批</button><label><input type="checkbox" checked={motion} onChange={(event) => { setMotion(event.target.checked); localStorage.setItem("xiling:companion-motion", event.target.checked ? "on" : "off"); }} />轻微动态</label></footer>
      <small>麦克风仅在点击说话时启用，不读取摄像头或屏幕。关闭伴侣停止录音和播放，不取消已提交的任务。</small>
    </section>}
    <button className="companion-character" aria-expanded={open} aria-label={open ? "收起汐灵" : "唤出汐灵"} onClick={() => setOpen(!open)}>
      <Suspense fallback={<span>正在唤醒 Hiyori…</span>}><Hiyori motion={motion && open} /></Suspense>
    </button>
  </aside>;
}

let root: Root | undefined;
export function setCompanionEnabled(enabled: boolean) {
  try { localStorage.setItem("xiling:companion-enabled", String(enabled)); } catch { /* preview */ }
  window.dispatchEvent(new CustomEvent("xiling:companion-enabled", { detail: enabled }));
}
export function mountCompanion(enabled: boolean) {
  if (!enabled) { root?.unmount(); root = undefined; document.getElementById("companion-root")?.remove(); return; }
  if (root) return;
  const host = document.createElement("div"); host.id = "companion-root"; document.body.append(host);
  root = createRoot(host); root.render(<Companion />);
}
