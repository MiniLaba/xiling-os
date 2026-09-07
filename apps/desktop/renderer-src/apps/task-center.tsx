import { useCallback, useEffect, useMemo, useState } from "react";

type TaskState = "created" | "queued" | "running" | "waiting_input" | "waiting_approval" | "waiting_dependency" | "completed" | "failed" | "cancelled";
type TaskFilter = "all" | "active" | "waiting" | "attention" | "done";

interface TaskView {
  canCancelRunning?: boolean;
  id: string;
  goal: string;
  state: TaskState;
  statusReason?: string;
  parentTaskId?: string;
  retryOfTaskId?: string;
  assignedAgentName?: string;
  outputArtifacts: Array<{ artifactId: string; version: number }>;
  createdAt: string;
  completedAt?: string;
  priority?: number;
}

interface ArtifactDetail {
  artifactId: string; name: string; type: string; mimeType: string; version: number; storageRef: string;
  createdAt: string; content: string; truncated: boolean;
  lineage: Array<{ artifactId: string; version: number; name: string; type: string }>;
}

const FILTERS: Array<{ id: TaskFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "active", label: "进行中" },
  { id: "waiting", label: "等待" },
  { id: "attention", label: "需处理" },
  { id: "done", label: "已结束" },
];

const STATE_LABEL: Record<TaskState, string> = {
  created: "已创建", queued: "排队中", running: "运行中", waiting_input: "等待输入",
  waiting_approval: "等待确认", waiting_dependency: "等待依赖", completed: "已完成",
  failed: "失败", cancelled: "已取消",
};

function matches(task: TaskView, filter: TaskFilter): boolean {
  if (filter === "all") return true;
  if (filter === "active") return task.state === "created" || task.state === "queued" || task.state === "running";
  if (filter === "waiting") return task.state.startsWith("waiting_");
  if (filter === "attention") return task.state === "failed" || task.state === "waiting_input" || task.state === "waiting_approval";
  return task.state === "completed" || task.state === "cancelled";
}

function readableTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

export function TaskCenterApp() {
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState<string>();
  const [artifact, setArtifact] = useState<ArtifactDetail>();
  const bridge = window.xilingDesktop;

  const refresh = useCallback(async () => {
    if (!bridge) return;
    try {
      const snapshot = await bridge.getOsSnapshot();
      setTasks(snapshot.tasks as TaskView[]);
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [bridge]);

  useEffect(() => {
    void refresh();
    return bridge?.tasks.onChanged(() => { void refresh(); });
  }, [bridge, refresh]);

  const visible = useMemo(() => tasks.filter((task) => matches(task, filter)), [tasks, filter]);
  const waiting = tasks.filter((task) => task.state.startsWith("waiting_")).length;
  const attention = tasks.filter((task) => task.state === "failed" || task.state === "waiting_input" || task.state === "waiting_approval").length;

  const perform = async (taskId: string, action: () => Promise<unknown>) => {
    setBusyId(taskId);
    setError(undefined);
    try { await action(); await refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusyId(undefined); }
  };

  const inspectArtifact = async (artifactId: string) => {
    if (!bridge) return;
    setError(undefined);
    try { setArtifact((await bridge.artifacts.get(artifactId)).artifact); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  useEffect(() => {
    if (!artifact) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setArtifact(undefined); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [artifact]);

  return (
    <section className="task-center">
      <header className="task-center-header">
        <div><p className="eyebrow">调度与恢复</p><h2>任务中心</h2><p>只呈现任务状态与需要你的决定；运行细节留在对话轨迹中。</p></div>
        <div className="task-center-metrics" aria-label="任务摘要"><span><strong>{tasks.length}</strong>总计</span><span><strong>{waiting}</strong>等待</span><span><strong>{attention}</strong>需处理</span></div>
      </header>
      <nav className="task-filter" aria-label="筛选任务">
        {FILTERS.map((item) => <button key={item.id} type="button" aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{item.label}</button>)}
      </nav>
      {error ? <p className="task-center-error" role="alert">{error}</p> : null}
      <div className={`task-center-body${artifact ? " is-viewing" : ""}`}>
      <div className="task-center-list">
        {visible.map((task) => {
          const cancellable = ["created", "queued", "waiting_input", "waiting_approval", "waiting_dependency"].includes(task.state) || (task.state === "running" && task.canCancelRunning === true);
          const retryable = task.state === "failed" || task.state === "cancelled";
          const editablePriority = !["running", "completed", "failed", "cancelled"].includes(task.state);
          return <article className="task-center-item" key={task.id}>
            <div className="task-center-main">
              <div className="task-center-line"><span className={`task-state is-${task.state}`}>{STATE_LABEL[task.state]}</span><time>{readableTime(task.createdAt)}</time></div>
              <h3>{task.goal}</h3>
              {task.statusReason ? <p className="task-status-reason">{task.statusReason}</p> : null}
              <p className="task-meta">{task.assignedAgentName ?? "主智能体"} · {task.outputArtifacts.length} 个产物{task.retryOfTaskId ? " · 来自重试" : ""}</p>
              {task.outputArtifacts.length > 0 ? <div className="task-artifacts" aria-label="任务产物">{task.outputArtifacts.map((item) => <button type="button" key={`${item.artifactId}:${item.version}`} onClick={() => void inspectArtifact(item.artifactId)}>查看产物 v{item.version}</button>)}</div> : null}
            </div>
            <div className="task-center-actions">
              <label>优先级<select aria-label={`${task.goal}的优先级`} value={task.priority ?? 0} disabled={!editablePriority || busyId === task.id} onChange={(event) => void perform(task.id, () => bridge!.tasks.setPriority(task.id, Number(event.target.value)))}><option value={-5}>低</option><option value={0}>普通</option><option value={5}>高</option><option value={10}>紧急</option></select></label>
              {cancellable ? <button type="button" disabled={busyId === task.id} onClick={() => void perform(task.id, () => bridge!.tasks.cancel(task.id))}>取消</button> : null}
              {retryable ? <button className="primary-action" type="button" disabled={busyId === task.id} onClick={() => void perform(task.id, () => bridge!.tasks.retry(task.id))}>重试</button> : null}
            </div>
          </article>;
        })}
        {visible.length === 0 ? <p className="task-center-empty">此筛选下没有任务。</p> : null}
      </div>
      {artifact ? <aside className="artifact-inspector" role="dialog" aria-label={`产物：${artifact.name}`}>
        <header><div><span>{artifact.type} · v{artifact.version}</span><h3>{artifact.name}</h3></div><button type="button" aria-label="关闭产物查看器" onClick={() => setArtifact(undefined)}>×</button></header>
        <dl><div><dt>格式</dt><dd>{artifact.mimeType}</dd></div><div><dt>来源链</dt><dd>{artifact.lineage.length} 个版本/产物</dd></div></dl>
        <pre tabIndex={0}>{artifact.content}</pre>
        {artifact.truncated ? <p className="artifact-truncated">内容较大，此处仅显示前 200 KB。</p> : null}
        <button type="button" disabled={artifact.truncated} onClick={() => void bridge?.artifacts.exportText(artifact.artifactId).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))}>导出到电脑</button>
        {artifact.lineage.length > 1 ? <details><summary>查看溯源链</summary><ol>{artifact.lineage.map((item) => <li key={item.artifactId}>{item.name} · {item.type} · v{item.version}</li>)}</ol></details> : null}
      </aside> : null}
      </div>
    </section>
  );
}
