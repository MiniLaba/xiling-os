import { useCallback, useEffect, useState } from "react";
import type { ResearchProject, ProjectItem, ProjectItemKind, ProjectItemStatus } from "@xiling/contracts";
import { RecordDetailModal } from "../components/RecordDetailModal.js";
import { ProjectWorkflowDashboard } from "./ProjectWorkflowDashboard.js";

const statuses: ProjectItemStatus[] = ["backlog", "ready", "running", "blocked", "done"];
const statusLabels: Record<ProjectItemStatus, string> = { backlog: "待梳理", ready: "可执行", running: "进行中", blocked: "受阻", done: "已完成" };
type ScienceDomainSummary = { id: string; title: string; description: string; disciplines: string[] };

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init); const body = await response.json() as T | { error: unknown };
  if (!response.ok) throw new Error(`请求失败：${response.status}`);
  return body as T;
}

export function ProjectView({ projectId, projects, onProjectChange, onProjectsChange }: { projectId: string; projects: ResearchProject[]; onProjectChange: (id: string) => void; onProjectsChange: (preferredId?: string) => Promise<void> }) {
  const [tab, setTab] = useState<"manage" | "run">("manage");
  const [items, setItems] = useState<ProjectItem[]>([]);
  const [newTitle, setNewTitle] = useState("");
  const [newKind, setNewKind] = useState<ProjectItemKind>("task");
  const [creatingProject, setCreatingProject] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [question, setQuestion] = useState("");
  const [domains, setDomains] = useState<ScienceDomainSummary[]>([]);
  const [domainId, setDomainId] = useState("general-science");
  const [error, setError] = useState("");
  const [expandedItem, setExpandedItem] = useState<ProjectItem>();

  const loadItems = useCallback(async () => {
    if (projectId) setItems(await jsonRequest<ProjectItem[]>(`/api/v1/project-items?projectId=${encodeURIComponent(projectId)}`));
  }, [projectId]);
  useEffect(() => { void loadItems().catch((cause) => setError(String(cause))); }, [loadItems]);
  useEffect(() => { void jsonRequest<{ domains: ScienceDomainSummary[] }>("/api/science/domains").then((value) => setDomains(value.domains)).catch((cause) => setError(String(cause))); }, []);

  if (tab === "run") return <div className="project-composite"><ViewTabs tab={tab} setTab={setTab} /><ProjectWorkflowDashboard projectId={projectId} /></div>;
  const selected = projects.find((project) => project.id === projectId);

  const createItem = async () => {
    if (!newTitle.trim() || !projectId) return;
    await jsonRequest<ProjectItem>("/api/v1/project-items", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId, kind: newKind, title: newTitle.trim(), notes: "" }) });
    setNewTitle(""); await loadItems();
  };
  const updateStatus = async (item: ProjectItem, status: ProjectItemStatus) => {
    await jsonRequest<ProjectItem>(`/api/v1/project-items/${item.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status }) }); await loadItems();
  };
  const createProject = async () => {
    if (!projectName.trim() || !question.trim()) return;
    const project = await jsonRequest<ResearchProject>("/api/v1/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: projectName.trim(), researchQuestion: question.trim(), description: "个人科学研究项目", domainIds: [domainId] }) });
    setCreatingProject(false); setProjectName(""); setQuestion(""); onProjectChange(project.id); await onProjectsChange(project.id);
  };

  return <div className="project-management">
    <ViewTabs tab={tab} setTab={setTab} />
    <section className="project-management-head">
      <div><small>PERSONAL RESEARCH PROJECT</small><h1>{selected?.name ?? "科研项目"}</h1><p>{selected?.researchQuestion}</p>{selected?.domainIds?.length ? <div className="project-domain-tags">{selected.domainIds.map((id) => <span key={id}>{domains.find((domain) => domain.id === id)?.title ?? id}</span>)}</div> : null}</div>
      <div className="project-picker"><select aria-label="选择科研项目" value={projectId} onChange={(event) => onProjectChange(event.target.value)}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select><button onClick={() => setCreatingProject((value) => !value)}>＋ 新项目</button></div>
    </section>
    {creatingProject ? <section className="inline-create"><input aria-label="项目名称" placeholder="项目名称" value={projectName} onChange={(event) => setProjectName(event.target.value)} /><input aria-label="研究问题" placeholder="核心研究问题" value={question} onChange={(event) => setQuestion(event.target.value)} /><select aria-label="科学领域" value={domainId} onChange={(event) => setDomainId(event.target.value)}>{domains.map((domain) => <option key={domain.id} value={domain.id}>{domain.title}</option>)}</select><button onClick={() => void createProject()}>创建</button></section> : null}
    <section className="project-stats"><article><b>{items.length}</b><span>研究事项</span></article><article><b>{items.filter((item) => item.status === "running").length}</b><span>进行中</span></article><article><b>{items.filter((item) => item.status === "done").length}</b><span>已完成</span></article><article><b>{items.filter((item) => item.kind === "experiment").length}</b><span>实验记录</span></article></section>
    <section className="item-create"><select aria-label="事项类型" value={newKind} onChange={(event) => setNewKind(event.target.value as ProjectItemKind)}><option value="task">任务</option><option value="milestone">里程碑</option><option value="experiment">实验</option></select><input aria-label="新事项标题" placeholder="添加任务、里程碑或实验…" value={newTitle} onChange={(event) => setNewTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void createItem(); }} /><button onClick={() => void createItem()}>添加事项</button></section>
    {error ? <p className="research-error">{error}</p> : null}
    <section className="project-board">{statuses.map((status) => <div className="board-column" key={status}><header><b>{statusLabels[status]}</b><span>{items.filter((item) => item.status === status).length}</span></header>{items.filter((item) => item.status === status).map((item) => <article key={item.id}><small>{item.kind}</small><h3>{item.title}</h3><p className="record-preview">{item.notes || "尚无补充记录"}</p>{item.notes.length > 220 ? <button className="record-expand" onClick={() => setExpandedItem(item)}>查看全文 <span>↗</span></button> : null}<select aria-label={`${item.title}状态`} value={item.status} onChange={(event) => void updateStatus(item, event.target.value as ProjectItemStatus)}>{statuses.map((value) => <option value={value} key={value}>{statusLabels[value]}</option>)}</select></article>)}</div>)}</section>
    {expandedItem ? <RecordDetailModal eyebrow={expandedItem.kind.toUpperCase()} title={expandedItem.title} onClose={() => setExpandedItem(undefined)}><div className="record-full-text">{expandedItem.notes}</div></RecordDetailModal> : null}
  </div>;
}

function ViewTabs({ tab, setTab }: { tab: "manage" | "run"; setTab: (tab: "manage" | "run") => void }) {
  return <div className="project-tabs"><button className={tab === "manage" ? "active" : ""} onClick={() => setTab("manage")}>项目管理</button><button className={tab === "run" ? "active" : ""} onClick={() => setTab("run")}>科研运行</button></div>;
}
