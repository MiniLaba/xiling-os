// 项目窗口：科研工作的入口。项目事项看板，全部经统一科研服务与窗口作用域。
// 这里的每个读写都带本窗口 ID，由核心进程判定归属；渲染器不持有全局选中项目。

import { useCallback, useEffect, useState } from "react";
import type { ProjectItem, ProjectItemKind, ProjectItemStatus } from "@xiling/contracts";
import { ResearchScopeGate, useResearchScope } from "./scope.js";

const STATUSES: readonly ProjectItemStatus[] = ["backlog", "ready", "running", "blocked", "done"];
const STATUS_LABELS: Record<ProjectItemStatus, string> = { backlog: "待梳理", ready: "可执行", running: "进行中", blocked: "受阻", done: "已完成" };
const KIND_LABELS: Record<ProjectItemKind, string> = { task: "任务", milestone: "里程碑", experiment: "实验" };

interface Overview { items?: ProjectItem[]; wiki?: unknown[]; evidence?: unknown[] }

export function ProjectWindow() {
  const scope = useResearchScope("system.project");
  const [items, setItems] = useState<ProjectItem[]>([]);
  const [counts, setCounts] = useState({ wiki: 0, evidence: 0 });
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<ProjectItemKind>("task");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!scope.projectId) { setItems([]); return; }
    try {
      const view = await scope.run<Overview>("project.overview");
      setItems(view.items ?? []);
      setCounts({ wiki: (view.wiki ?? []).length, evidence: (view.evidence ?? []).length });
      setStatus("");
    } catch (reason) { setStatus(scope.describeError(reason)); }
  }, [scope.projectId, scope.run, scope.describeError]);

  useEffect(() => { void refresh(); }, [refresh]);

  const addItem = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      const result = await scope.run<{ items?: ProjectItem[] }>("project.items.create", { kind, title: title.trim(), notes: "" });
      setItems(result.items ?? []);
      setTitle("");
    } catch (reason) { setStatus(scope.describeError(reason)); }
    finally { setBusy(false); }
  };

  const move = async (item: ProjectItem, next: ProjectItemStatus) => {
    setBusy(true);
    try {
      const result = await scope.run<{ items?: ProjectItem[] }>("project.items.update", { itemId: item.id, status: next });
      setItems(result.items ?? []);
    } catch (reason) { setStatus(scope.describeError(reason)); }
    finally { setBusy(false); }
  };

  return <section className="research-window project-window">
    <ResearchScopeGate api={scope}>
      <header className="research-window-head">
        <div>
          <p className="eyebrow">科研项目</p>
          <h2>{scope.project?.name ?? "项目"}</h2>
          <p>{scope.project?.researchQuestion}</p>
        </div>
        <div className="research-window-metrics" aria-label="项目摘要">
          <span><strong>{items.length}</strong>研究事项</span>
          <span><strong>{items.filter((item) => item.status === "running").length}</strong>进行中</span>
          <span><strong>{counts.wiki}</strong>Wiki</span>
          <span><strong>{counts.evidence}</strong>证据</span>
        </div>
      </header>

      <form className="research-window-create" onSubmit={(event) => { event.preventDefault(); void addItem(); }}>
        <select aria-label="事项类型" value={kind} onChange={(event) => setKind(event.target.value as ProjectItemKind)}>
          {(["task", "milestone", "experiment"] as const).map((value) => <option key={value} value={value}>{KIND_LABELS[value]}</option>)}
        </select>
        <input aria-label="新事项标题" placeholder="添加任务、里程碑或实验…" maxLength={300} value={title} onChange={(event) => setTitle(event.target.value)} />
        <button type="submit" disabled={busy || !title.trim()}>添加事项</button>
      </form>
      {status ? <p role="alert" className="research-window-error">{status}</p> : null}

      <div className="research-board">
        {STATUSES.map((value) => <div className="research-board-column" key={value}>
          <header><b>{STATUS_LABELS[value]}</b><span>{items.filter((item) => item.status === value).length}</span></header>
          {items.filter((item) => item.status === value).map((item) => <article key={item.id}>
            <small>{KIND_LABELS[item.kind]}</small>
            <h3>{item.title}</h3>
            {item.notes ? <p>{item.notes}</p> : null}
            <select aria-label={`${item.title}的状态`} value={item.status} disabled={busy} onChange={(event) => void move(item, event.target.value as ProjectItemStatus)}>
              {STATUSES.map((option) => <option key={option} value={option}>{STATUS_LABELS[option]}</option>)}
            </select>
          </article>)}
        </div>)}
      </div>
      {items.length === 0 ? <p className="research-window-empty">这个项目还没有研究事项。从上面添加第一条开始。</p> : null}
    </ResearchScopeGate>
  </section>;
}
