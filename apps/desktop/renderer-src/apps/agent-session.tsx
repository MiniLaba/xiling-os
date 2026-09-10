import { useEffect, useState } from "react";
import { SaveAnswer } from "./save-answer.js";
import { ArtifactInputs, ArtifactResult } from "./artifact-inputs.js";
import { TrustedSurface, type OsSnapshot } from "../window-runtime.js";

interface View {
  app: { state: string; package: { name: string } };
  session: { state: string };
  tasks: Array<{ id: string; goal: string; state: string; statusReason?: string; outputArtifacts: Array<{ artifactId: string }> }>;
  surfaces: OsSnapshot["surfaces"];
  messages: Array<{ id: string; taskId: string; text: string; role: string }>;
}

export function AgentSessionWindow({ instanceId, sessionId }: { instanceId: string; sessionId: string }) {
  const [artifactIds, setArtifactIds] = useState<string[]>([]);
  const [view, setView] = useState<View>();
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const bridge = window.xilingDesktop;
  useEffect(() => {
    let disposed = false;
    let loading = false;
    let dirty = false;
    const refresh = async () => {
      if (!bridge || disposed) return;
      if (loading) { dirty = true; return; }
      loading = true;
      try {
        do {
          dirty = false;
          const next = await bridge.manageAgentApps({ action: "view", id: instanceId, sessionId }) as View;
          if (!disposed) setView(next);
        } while (dirty && !disposed);
      } catch (error) { if (!disposed) setError(error instanceof Error ? error.message : String(error)); }
      finally { loading = false; }
    };
    void refresh();
    const unsubscribe = bridge?.tasks.onChanged(() => { void refresh(); });
    return () => { disposed = true; unsubscribe?.(); };
  }, [bridge, instanceId, sessionId]);
  const labels: Record<string, string> = { created: "待执行", queued: "排队", running: "执行中", failed: "失败", completed: "已完成", cancelled: "已取消", waiting_approval: "等待审批", waiting_input: "等待输入", waiting_dependency: "等待协作" };
  return <div className="agent-app-manager" aria-label="独立应用会话">
    <p>当前应用的独立工作会话。关闭窗口不会删除任务与数据。</p>
    {error && <p role="alert">{error}</p>}
    {view?.tasks.length === 0 && <p>输入一个工作目标开始。模型与运行时未配置时会明确报错。</p>}
    <div aria-live="polite">{view?.tasks.map((task) => <article key={task.id}>
      <h4>{task.goal}</h4><p>{labels[task.state] ?? task.state}</p>
      {task.statusReason && <p>{task.statusReason}</p>}
      {task.outputArtifacts.map((ref) => <ArtifactResult key={ref.artifactId} id={ref.artifactId} />)}
      {view.surfaces.filter((surface) => surface.taskId === task.id).map((surface) => <TrustedSurface key={surface.id} surface={surface} busy={busy} onAction={async (surfaceId, actionId, input) => {
        setBusy(true); setError("");
        try { await bridge!.submitUiAction(surfaceId, actionId, input); } catch (reason) { setError(String(reason)); } finally { setBusy(false); }
      }} />)}
      {view.messages.filter((message) => message.taskId === task.id).map((message) => <p key={message.id} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{message.text}</p>)}
      {task.state === "completed" && view.messages.filter((message) => message.taskId === task.id && message.role === "assistant").slice(-1).map((message) => <SaveAnswer key={message.id} messageId={message.id} />)}
    </article>)}</div>
    <form onSubmit={(event) => { event.preventDefault(); if (!bridge) return; setBusy(true); setError("");
      void bridge.manageAgentApps({ action: "submit", id: instanceId, sessionId, goal: goal.trim(), artifactIds }).then(() => { setGoal(""); setArtifactIds([]); }).catch((error: unknown) => setError(error instanceof Error ? error.message : String(error))).finally(() => setBusy(false));
    }}>
      <label>工作目标<textarea value={goal} rows={3} maxLength={12000} onChange={(event) => setGoal(event.target.value)} /></label>
      <ArtifactInputs value={artifactIds} onChange={setArtifactIds} />
      <button disabled={busy || !goal.trim() || !view || view.app.state !== "enabled" || view.session.state !== "active"}>提交给此应用</button>
    </form>
  </div>;
}
