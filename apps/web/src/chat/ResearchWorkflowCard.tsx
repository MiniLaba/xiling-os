import { useState } from "react";
import type { ProjectResearchWorkflow } from "@xiling/domain-ocean";
import { jsonInit } from "../lib/api-client.js";

const stageLabels: Record<ProjectResearchWorkflow["status"], string> = {
  draft: "等待元数据探测", probing: "正在获取元数据", pending_approval: "等待审批", approved: "已批准", downloading: "正在下载", analyzing: "正在计算与审查", completed: "闭环完成", rejected: "已拒绝", failed: "执行失败", cancelled: "已取消",
};
const formatBytes = (value?: number) => value === undefined ? "等待探测" : value < 1024 * 1024 ? `${Math.ceil(value / 1024)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`;
const artifactHref = (uri: string, projectId: string) => {
  if (/^artifact:\/\/sha256\/[a-f0-9]{64}$/.test(uri)) return `/api/v1/artifact-content?projectId=${encodeURIComponent(projectId)}&uri=${encodeURIComponent(uri)}`;
  return undefined;
};

export function ResearchWorkflowCard({ workflow, onChange }: { workflow: ProjectResearchWorkflow; onChange: (workflow: ProjectResearchWorkflow) => void }) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const invoke = async (action: string) => {
    const response = await fetch(`/api/v1/research-workflows/${encodeURIComponent(workflow.id)}/${action}`, jsonInit("POST", { projectId: workflow.projectId }));
    const body = await response.json() as ProjectResearchWorkflow | { error: string };
    if (!response.ok) throw new Error("error" in body ? body.error : `HTTP ${response.status}`);
    onChange(body as ProjectResearchWorkflow); return body as ProjectResearchWorkflow;
  };
  const refresh = async () => { const response = await fetch(`/api/v1/research-workflows?projectId=${encodeURIComponent(workflow.projectId)}&sessionId=${encodeURIComponent(workflow.sessionId)}`); if (response.ok) { const items = await response.json() as ProjectResearchWorkflow[]; const current = items.find((item) => item.id === workflow.id); if (current) onChange(current); } };
  const act = async (action: "probe" | "reject" | "reset" | "settle") => {
    setBusy(action); setError(""); try { await invoke(action); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); await refresh(); } finally { setBusy(""); }
  };
  const approveAndRun = async () => {
    setBusy("run"); setError("");
    try { const approved = await invoke("approve"); onChange({ ...approved, status: "downloading" }); await invoke("run"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); await refresh(); }
    finally { setBusy(""); }
  };
  const cancel = async () => { try { await invoke("cancel"); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } };
  const request = workflow.request;
  return <section className={`research-workflow-card status-${workflow.status}`}>
    <header><div><small>RESEARCH WORKFLOW</small><h3>{request.connectorId} · {request.datasetId}</h3></div><span><i />{busy === "run" ? "执行中" : stageLabels[workflow.status]}</span></header>
    <div className="workflow-scope"><span><b>变量</b>{request.variables.join(" · ")}</span><span><b>区域</b>{request.region.west}–{request.region.east}°E / {request.region.south}–{request.region.north}°N</span><span><b>时间</b>{request.time.start} — {request.time.end}</span><span><b>预计体积</b>{formatBytes(workflow.preflight.estimatedBytes)}</span></div>
    {workflow.status === "draft" ? <div className="workflow-disclosure"><p>下一步仅访问官方数据源获取元数据和体积估算，不下载科研数据。</p><button disabled={Boolean(busy)} onClick={() => void act("probe")}>{busy ? "正在探测…" : "获取元数据"}</button></div> : null}
    {workflow.status === "pending_approval" ? <div className="workflow-approval"><div><b>执行前确认</b><p>将下载约 {formatBytes(workflow.preflight.estimatedBytes)} 至受控项目存储，随后在隔离 Runner 中计算并运行 Reviewer。</p></div><div><button className="secondary" disabled={Boolean(busy)} onClick={() => void act("reject")}>拒绝</button><button disabled={Boolean(busy)} onClick={() => void approveAndRun()}>批准并执行</button></div></div> : null}
    {(["probing", "downloading", "analyzing"].includes(workflow.status) || busy === "run") ? <div className="workflow-progress"><i /><span>{workflow.status === "probing" ? "正在读取官方元数据…" : workflow.status === "analyzing" ? "xarray 计算、Reviewer 与 RO-Crate 正在生成…" : "正在下载已批准的数据切片…"}</span><button onClick={() => void cancel()}>取消</button></div> : null}
    {workflow.review ? <div className={`workflow-review ${workflow.review.verdict}`}><b>Reviewer · {workflow.review.verdict === "accepted" ? "通过" : "未通过"}</b>{workflow.review.checks.map((check) => <span key={check.id}>{check.passed ? "✓" : "✕"} {check.detail}</span>)}{workflow.review.limitations.map((item) => <p key={item}>{item}</p>)}</div> : null}
    {workflow.run?.artifactUris.length ? <div className="workflow-artifacts"><b>Artifacts</b>{workflow.run.artifactUris.map((uri) => { const href = artifactHref(uri, workflow.projectId); return href ? <a href={href} target="_blank" rel="noreferrer" key={uri}>{uri.split("/").at(-1)} ↗</a> : <span key={uri}>{uri}</span>; })}</div> : null}
    {workflow.status === "completed" ? <footer><span>{workflow.settledAt ? "✓ 已沉淀到项目、Wiki 与画布" : "运行完成，等待沉淀"}</span>{!workflow.settledAt ? <button onClick={() => void act("settle")}>完成沉淀</button> : null}</footer> : null}
    {(["failed", "cancelled", "rejected"].includes(workflow.status)) ? <footer className="workflow-error"><span>{error || workflow.error || stageLabels[workflow.status]}</span><button onClick={() => void act("reset")}>重新规划</button></footer> : error ? <p className="workflow-inline-error">{error}</p> : null}
  </section>;
}
