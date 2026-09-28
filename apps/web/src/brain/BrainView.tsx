import { lazy, Suspense, useState } from "react";
import type { WikiPageDetail } from "@xiling/contracts";
import { apiJson, jsonInit } from "../lib/api-client.js";

const ScientificCanvasView = lazy(async () => ({ default: (await import("../canvas/ScientificCanvasView.js")).ScientificCanvasView }));
const PaperGraphView = lazy(async () => ({ default: (await import("../papers/PaperGraphView.js")).PaperGraphView }));
const WikiView = lazy(async () => ({ default: (await import("../wiki/WikiView.js")).WikiView }));

type BrainHit = { id: string; kind: "note" | "chat" | "paper" | "chart" | "report" | "entity"; title: string; excerpt: string; locator?: string };
type Neighborhood = { focusId: string; nodes: Array<{ id: string; title: string; kind: string; summary: string }>; relations: Array<{ kind: string; sourceId: string; targetId: string }> };
type Panel = "read" | "notes" | "canvas" | "papers";

const kindLabel: Record<BrainHit["kind"], string> = { note: "笔记", chat: "聊天", paper: "论文", chart: "图表", report: "报告", entity: "图谱" };

export function BrainView({ projectId, onOpenProject, onOpenChat }: { projectId: string; onOpenProject?: () => void; onOpenChat?: () => void }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<BrainHit[]>([]);
  const [panel, setPanel] = useState<Panel>("read");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState<WikiPageDetail>();
  const [source, setSource] = useState<{ title: string; body: string; sourceLabel?: string }>();
  const [neighborhood, setNeighborhood] = useState<Neighborhood>();
  const [noteTitle, setNoteTitle] = useState("");
  const [noteBody, setNoteBody] = useState("");

  const search = async (event?: React.FormEvent) => {
    event?.preventDefault();
    const q = query.trim();
    if (!q) return;
    setStatus("正在搜索共享大脑…");
    try {
      const next = await apiJson<BrainHit[]>(`/api/v1/brain/search?projectId=${encodeURIComponent(projectId)}&q=${encodeURIComponent(q)}`);
      setHits(next);
      setPanel("read");
      setStatus(next.length ? `${next.length} 条结果` : "没有匹配内容");
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  };

  const openHit = async (hit: BrainHit) => {
    setStatus("");
    if (hit.kind === "paper") {
      const records = await apiJson<Array<{ id: string; paper: { title: string; abstract?: string; year?: number; authors?: string[] }; sourceQuote?: string; note?: string; sourceLocator?: string }>>(`/api/v1/evidence?projectId=${encodeURIComponent(projectId)}`);
      const record = records.find((item) => item.id === hit.id);
      setPage(undefined);
      setSource({
        title: record?.paper.title ?? hit.title,
        sourceLabel: "论文",
        body: [record?.paper.authors?.join(", "), record?.paper.year ? String(record.paper.year) : "", record?.paper.abstract, record?.sourceQuote ? `摘录：${record.sourceQuote}` : "", record?.note, record?.sourceLocator ? `来源：${record.sourceLocator}` : "", hit.excerpt].filter(Boolean).join("\n\n"),
      });
      setNeighborhood(await apiJson<Neighborhood>(`/api/v1/brain/neighborhood?projectId=${encodeURIComponent(projectId)}`));
      return;
    }
    if (hit.kind === "note") {
      const detail = await apiJson<WikiPageDetail>(`/api/v1/wiki/pages/${encodeURIComponent(hit.id)}`);
      setPage(detail);
      setSource(undefined);
      setNeighborhood(await apiJson<Neighborhood>(`/api/v1/brain/neighborhood?projectId=${encodeURIComponent(projectId)}`));
      return;
    }
    if (hit.kind === "entity" || hit.kind === "chart" || hit.kind === "report") {
      const content = await apiJson<{ title: string; body: string; sourceLabel?: string }>(`/api/v1/brain/sources/${encodeURIComponent(hit.id)}?projectId=${encodeURIComponent(projectId)}`);
      setSource(content);
      setPage(undefined);
      setNeighborhood(await apiJson<Neighborhood>(`/api/v1/brain/neighborhood?projectId=${encodeURIComponent(projectId)}&focus=${encodeURIComponent(hit.id)}`));
      return;
    }
    setPage(undefined);
    setSource({ title: hit.title, body: hit.excerpt, sourceLabel: kindLabel[hit.kind] });
  };

  const saveNote = async (event: React.FormEvent) => {
    event.preventDefault();
    const saved = await apiJson<WikiPageDetail>("/api/v1/brain/notes", jsonInit("POST", { projectId, title: noteTitle, markdown: noteBody, ...(page ? { pageId: page.id } : {}) }));
    setPage(saved);
    setStatus("笔记已保存");
  };

  return (
    <div className="brain-view">
      <form className="brain-search" onSubmit={(event) => void search(event)}>
        <input value={query} placeholder="搜索笔记、聊天、论文、图表或报告" aria-label="搜索共享大脑" onChange={(event) => setQuery(event.target.value)} />
        <button type="submit">搜索</button>
      </form>
      <div className="brain-panels" role="tablist">
        {([["read", "阅读"], ["notes", "笔记"], ["canvas", "邻域图"], ["papers", "文献"]] as const).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={panel === id} className={panel === id ? "active" : ""} onClick={() => setPanel(id)}>{label}</button>
        ))}
      </div>
      {status ? <p className="brain-status">{status}</p> : null}
      {panel === "read" ? (
        <div className="brain-read">
          <aside>
            {hits.length ? hits.map((hit) => (
              <button key={`${hit.kind}:${hit.id}`} data-kind={hit.kind} onClick={() => void openHit(hit)}>
                <small>{kindLabel[hit.kind]}</small>
                <b>{hit.title}</b>
                <span>{hit.excerpt}</span>
              </button>
            )) : <p className="brain-empty">搜索笔记、聊天、论文、图表或报告。</p>}
          </aside>
          <article>
            {page ? (
              <>
                <header><small>笔记</small><h2>{page.title}</h2></header>
                <div className="brain-prose">{page.currentRevision?.markdown}</div>
                {page.backlinks.length ? <section><h3>反向链接</h3>{page.backlinks.map((link) => <button key={link.id} onClick={() => void openHit({ id: link.id, kind: "note", title: link.title, excerpt: link.slug })}>{link.title}</button>)}</section> : null}
              </>
            ) : source ? (
              <>
                <header><small>{source.sourceLabel ?? "来源"}</small><h2>{source.title}</h2></header>
                <div className="brain-prose">{source.body}</div>
              </>
            ) : <p className="brain-empty">从左侧结果打开一篇笔记、论文或图表。关联内容会在这里按需展开。</p>}
            {neighborhood ? (
              <section>
                <h3>当前邻域</h3>
                <ul>{neighborhood.nodes.map((node) => <li key={node.id}><b>{node.title}</b><small>{node.kind}</small></li>)}</ul>
                <button onClick={() => setPanel("canvas")}>继续展开图谱</button>
              </section>
            ) : null}
          </article>
        </div>
      ) : null}
      {panel === "notes" ? (
        <form className="brain-note" onSubmit={(event) => void saveNote(event)}>
          <input value={noteTitle} placeholder="笔记标题" aria-label="笔记标题" onChange={(event) => setNoteTitle(event.target.value)} required />
          <textarea value={noteBody} placeholder="用 [[slug]] 链接其他笔记" aria-label="笔记正文" onChange={(event) => setNoteBody(event.target.value)} required />
          <button type="submit">{page ? "保存修订" : "保存笔记"}</button>
        </form>
      ) : null}
      {panel === "canvas" ? <Suspense fallback={<p>正在打开邻域图…</p>}><ScientificCanvasView projectId={projectId} initialFocusId={page?.id ?? neighborhood?.focusId ?? `research-question:${projectId}`} onNavigate={(view) => { if (view === "wiki") setPanel("notes"); else if (view === "chat") onOpenChat?.(); else setPanel("papers"); }} /></Suspense> : null}
      {panel === "papers" ? <Suspense fallback={<p>正在打开文献…</p>}><PaperGraphView projectId={projectId} onNavigate={() => setPanel("canvas")} /></Suspense> : null}
      {panel === "read" ? null : panel === "notes" ? <Suspense fallback={null}><WikiView projectId={projectId} onNavigate={(view) => { if (view === "project") onOpenProject?.(); else setPanel("papers"); }} /></Suspense> : null}
    </div>
  );
}
