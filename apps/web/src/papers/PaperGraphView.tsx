import { useEffect, useRef, useState } from "react";
import cytoscape, { type Core } from "cytoscape";
import type { EvidenceRecord, LiteratureGraph, LiteratureGraphNode, LiteratureSearchResponse, ResearchGraphEntity, ResearchGraphProjection } from "@xiling/contracts";

const edgeColors = {
  citation: "#4f7d88",
  recommendation: "#b58a3f",
  "co-citation": "#8a70bd",
  "bibliographic-coupling": "#36a48f",
};

export function PaperGraphView({ projectId, onNavigate }: { projectId: string; onNavigate?: (view: "canvas") => void }) {
  const container = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const [graph, setGraph] = useState<LiteratureGraph>();
  const [selected, setSelected] = useState<LiteratureGraphNode>();
  const [edgeFilter, setEdgeFilter] = useState<keyof typeof edgeColors | "all">("all");
  const [evidence, setEvidence] = useState<EvidenceRecord[]>([]);
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [stanceDrafts, setStanceDrafts] = useState<Record<string, EvidenceRecord["stance"]>>({});
  const [confidenceDrafts, setConfidenceDrafts] = useState<Record<string, number>>({});
  const [quoteDrafts, setQuoteDrafts] = useState<Record<string, string>>({});
  const [locatorDrafts, setLocatorDrafts] = useState<Record<string, string>>({});
  const [limitationDrafts, setLimitationDrafts] = useState<Record<string, string>>({});
  const [claimDrafts, setClaimDrafts] = useState<Record<string, string>>({});
  const [claimRevisions, setClaimRevisions] = useState<ResearchGraphEntity[]>([]);
  const [listMode, setListMode] = useState<"discovery" | "evidence">("discovery");
  const [actionStatus, setActionStatus] = useState("");
  const [query, setQuery] = useState("");
  const [searchStatus, setSearchStatus] = useState("");
  const [searchMeta, setSearchMeta] = useState<Pick<LiteratureSearchResponse, "provider" | "cache" | "degradedFrom">>();
  const [searching, setSearching] = useState(false);
  const [detailOpen, setDetailOpen] = useState(true);

  const focusPaper = (paper: LiteratureGraphNode | undefined) => {
    if (!paper) return;
    setSelected(paper);
    setDetailOpen(true);
    const cy = cyRef.current;
    if (!cy) return;
    cy.nodes().unselect();
    cy.edges().removeClass("focus");
    const node = cy.getElementById(paper.id);
    node.select();
    node.connectedEdges().addClass("focus");
  };

  useEffect(() => {
    void fetch(`/api/v1/evidence?projectId=${encodeURIComponent(projectId)}`).then((response) => response.json()).then((records: EvidenceRecord[]) => {
      setEvidence(records);
      setNoteDrafts(Object.fromEntries(records.map((record) => [record.paper.id, record.note])));
      setStanceDrafts(Object.fromEntries(records.map((record) => [record.paper.id, record.stance])));
      setConfidenceDrafts(Object.fromEntries(records.map((record) => [record.paper.id, record.confidence])));
    });
    void fetch(`/api/projects/${encodeURIComponent(projectId)}/research-graph?view=evidence`).then((response) => response.json()).then((projection: ResearchGraphProjection) => setClaimRevisions(projection.nodes.filter((node) => node.kind === "ClaimRevision" && node.status !== "superseded")));
  }, [projectId]);

  const saveEvidence = async () => {
    if (!selected) return; setActionStatus("正在生成可追溯证据…");
    const response = await fetch("/api/v1/evidence", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId, paper: selected, note: noteDrafts[selected.id] ?? "", stance: stanceDrafts[selected.id] ?? "insufficient", confidence: confidenceDrafts[selected.id] ?? 0.5, sourceQuote: quoteDrafts[selected.id] ?? "", sourceLocator: locatorDrafts[selected.id] || selected.url, limitations: limitationDrafts[selected.id] ?? "", claimRevisionId: claimDrafts[selected.id] || undefined }) });
    if (response.ok) {
      const record = await response.json() as EvidenceRecord;
      setEvidence((current) => [record, ...current]);
      setActionStatus("已提升为项目证据，科研画布会自动更新");
    } else setActionStatus("证据提升失败");
  };
  const searchRemote = async () => {
    const normalized = query.trim(); if (normalized.length < 2) { setSearchStatus("请输入至少 2 个字符"); return; }
    setSearchStatus("正在检索 Semantic Scholar…"); setSearching(true);
    try {
      const response = await fetch(`/api/v1/literature/search?q=${encodeURIComponent(normalized)}&limit=40`);
      const result = await response.json() as LiteratureSearchResponse & { graph?: LiteratureGraph; error?: string };
      if (!response.ok) throw new Error(result.error ?? "检索失败");
      if (!result.graph) { setSearchStatus("没有找到可构图的论文"); return; }
      setGraph(result.graph); setSelected(result.graph.nodes[0]); setSearchMeta({ provider: result.provider, cache: result.cache, ...(result.degradedFrom ? { degradedFrom: result.degradedFrom } : {}) });
      setSearchStatus(`${result.graph.nodes.length} 篇 · ${result.cache === "hit" ? "缓存命中" : result.cache === "stale" ? "使用过期缓存" : "已缓存"}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "检索失败";
      setSearchStatus(message.includes("429") ? "匿名配额已限流；请稍后重试，或在设置中配置文献 API Key" : "文献服务暂时不可用；已保留当前图");
    } finally { setSearching(false); }
  };

  useEffect(() => {
    if (!container.current || !graph) return;
    const nonSeeds = graph.nodes.filter((node) => !node.seed);
    const years = graph.nodes.map((node) => node.year);
    const minYear = Math.min(...years);
    const maxYear = Math.max(...years);
    const maxCitations = Math.max(...graph.nodes.map((node) => node.citationCount), 1);
    const filteredEdges = graph.edges.filter((edge) => edgeFilter === "all" || edge.kind === edgeFilter);
    const visibleEdges = [...filteredEdges].sort((a, b) => b.score - a.score).slice(0, Math.max(graph.nodes.length + 2, Math.min(filteredEdges.length, Math.ceil(graph.nodes.length * 1.5))));
    const elements = [
      ...graph.nodes.map((node) => {
        const index = nonSeeds.findIndex((item) => item.id === node.id);
        const angle = (Math.PI * 2 * Math.max(index, 0)) / Math.max(nonSeeds.length, 1);
        const radius = node.seed ? 0 : 190 - Math.min(node.relevance, 1) * 45;
        const firstAuthor = node.authors[0]?.split(/\s+/).at(-1) ?? "Unknown";
        const visualSize = 32 + Math.sqrt(node.citationCount / maxCitations) * 36;
        return { data: { id: node.id, label: `${firstAuthor}, ${node.year}`, seed: node.seed ? 1 : 0, citations: node.citationCount, relevance: node.relevance, year: node.year, visualSize }, position: { x: 320 + Math.cos(angle) * radius, y: 260 + Math.sin(angle) * radius } };
      }),
      ...visibleEdges.map((edge) => ({ data: edge })),
    ];
    const cy = cytoscape({
      container: container.current,
      elements,
      layout: { name: "cose", fit: true, padding: 54, animate: false, randomize: false, nodeRepulsion: () => 4_800, idealEdgeLength: () => 82, edgeElasticity: () => 90, nestingFactor: 1, gravity: 0.85, numIter: 1_200, componentSpacing: 90 },
      minZoom: 0.45,
      maxZoom: 2.2,
      autoungrabify: true,
      style: [
        { selector: "node", style: {
          "background-color": `mapData(year, ${minYear}, ${maxYear}, #bdd0d0, #2f696c)`,
          "border-color": "#ffffff",
          "border-width": 1.5,
          width: "data(visualSize)",
          height: "data(visualSize)",
          label: "data(label)",
          "font-size": 12,
          color: "#343633",
          "text-wrap": "none",
          "text-valign": "top",
          "text-margin-y": -8,
        } },
        { selector: "node[seed = 1]", style: { "border-color": "#9d5b91", "border-width": 6, color: "#8e477e", "font-weight": 700 } },
        { selector: "node:selected", style: { "border-color": "#9d5b91", "border-width": 5 } },
        { selector: "edge", style: { width: 1, "curve-style": "bezier", opacity: 0.2, "line-color": "#97a3a1", "target-arrow-color": "#97a3a1" } },
        { selector: "edge[kind = 'citation']", style: { "line-color": edgeColors.citation, "target-arrow-color": edgeColors.citation, "target-arrow-shape": "triangle", "arrow-scale": .55 } },
        { selector: "edge[kind = 'recommendation']", style: { "line-color": edgeColors.recommendation, "line-style": "dashed" } },
        { selector: "edge[kind = 'co-citation']", style: { "line-color": edgeColors["co-citation"], "line-style": "dotted" } },
        { selector: "edge[kind = 'bibliographic-coupling']", style: { "line-color": edgeColors["bibliographic-coupling"] } },
        { selector: "edge.focus", style: { width: 2.2, opacity: .92, "line-color": "#075f91", "target-arrow-color": "#075f91" } },
      ],
    });
    cyRef.current = cy;
    const initial = graph.nodes.find((node) => node.seed) ?? graph.nodes[0];
    if (initial) { const node = cy.getElementById(initial.id); node.select(); node.connectedEdges().addClass("focus"); }
    cy.on("tap", "node", (event) => focusPaper(graph.nodes.find((node) => node.id === event.target.id())));
    return () => { cyRef.current = null; cy.destroy(); };
  }, [graph, edgeFilter]);

  if (!graph) return <div className="literature-start">
    <section><small>LITERATURE WORKBENCH</small><h1>从一个研究问题开始探索论文关系</h1><p>检索结果是临时发现图。只有经过阅读、精确摘录并明确关联主张后，内容才会进入项目 Research Graph。</p><div><input autoFocus aria-label="检索论文" placeholder="输入研究主题、论文标题或关键词" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void searchRemote(); }} /><button disabled={searching} onClick={() => void searchRemote()}>{searching ? "检索中…" : "开始检索"}</button></div>{searchStatus ? <span>{searchStatus}</span> : null}</section>
    <aside><header><b>项目证据</b><span>{evidence.length}</span></header>{evidence.slice(0, 6).map((record) => <article key={record.id}><small>{record.stance} · {Math.round(record.confidence * 100)}%</small><b>{record.paper.title}</b><p>{record.sourceQuote || record.note || "未记录精确摘录"}</p></article>)}{!evidence.length ? <p>还没有经过核对的文献证据。</p> : null}</aside>
  </div>;
  const evidenceByPaper = new Map(evidence.map((record) => [record.paper.id, record]));
  const displayedPapers: LiteratureGraphNode[] = listMode === "discovery" ? graph.nodes : evidence.map((record) => {
    const known = graph.nodes.find((paper) => paper.id === record.paper.id);
    return { ...record.paper, seed: known?.seed ?? false, relevance: known?.relevance ?? 0 };
  });
  const selectedEvidence = selected ? evidenceByPaper.get(selected.id) : undefined;
  const graphYears = graph.nodes.map((node) => node.year);
  const graphMinYear = Math.min(...graphYears);
  const graphMaxYear = Math.max(...graphYears);
  return <div className={`paper-graph-view ${detailOpen ? "detail-open" : "detail-closed"}`}>
    <aside className="paper-list">
      <div className="paper-list-head"><small>发现</small><b>{graph.nodes.length} 篇论文</b></div>
      <div className="paper-list-tabs"><button className={listMode === "discovery" ? "active" : ""} onClick={() => setListMode("discovery")}>发现结果</button><button className={listMode === "evidence" ? "active" : ""} onClick={() => { setListMode("evidence"); if (evidence[0]) setSelected({ ...evidence[0].paper, seed: false, relevance: graph.nodes.find((paper) => paper.id === evidence[0]?.paper.id)?.relevance ?? 0 }); }}>项目证据 {evidence.length}</button></div>
      <div className="paper-list-scroll">{displayedPapers.length ? [...displayedPapers].sort((a, b) => Number(b.seed) - Number(a.seed) || b.relevance - a.relevance).map((paper) => <button key={paper.id} className={`${selected?.id === paper.id ? "active" : ""} ${paper.seed ? "seed" : ""}`} onClick={() => focusPaper(paper)}><small>{paper.seed ? "起点论文" : evidenceByPaper.has(paper.id) ? "项目证据" : `${paper.year} · ${paper.citationCount} 次引用`}</small><b>{paper.title}</b><span>{paper.authors.slice(0, 2).join(" · ")}</span></button>) : <p className="paper-list-empty">尚未提升任何项目证据。</p>}</div>
    </aside>
    <section className="paper-graph-main">
      <div className="paper-graph-toolbar">
        <div><small>文献关联图 · {searchMeta?.provider ?? graph.provider}{searchMeta?.degradedFrom ? " · 降级来源" : ""}</small><h1>{searchMeta ? query : "文献关系探索"}</h1><p>距离表示相关性 · 大小表示被引量 · 默认突出最强关系{searchStatus ? ` · ${searchStatus}` : ""}</p></div>
        <div className="paper-graph-actions">
          <input aria-label="检索论文" placeholder="主题、标题或关键词…" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void searchRemote(); }} />
          <button disabled={searching} onClick={() => void searchRemote()}>{searching ? "检索中…" : "检索"}</button>
          <select value={edgeFilter} onChange={(event) => setEdgeFilter(event.target.value as typeof edgeFilter)} aria-label="关系筛选">
            <option value="all">全部关系</option><option value="citation">引用</option><option value="recommendation">推荐</option><option value="co-citation">共被引</option><option value="bibliographic-coupling">书目耦合</option>
          </select>
          <button onClick={() => { const cy = cyRef.current; if (cy) cy.fit(cy.elements(), 45); }}>◎</button>
        </div>
      </div>
      <div className="paper-graph-canvas" ref={container} />
      <div className="paper-graph-bottom"><div className="graph-utility"><button title="图例说明">?</button><button title="居中图谱" onClick={() => cyRef.current?.fit(cyRef.current.elements(), 54)}>⊙</button></div><div className="paper-relation-legend"><span><i style={{ borderColor: edgeColors.citation }} />引用</span><span><i className="dashed" style={{ borderColor: edgeColors.recommendation }} />推荐</span><span><i className="dotted" style={{ borderColor: edgeColors["co-citation"] }} />共被引</span><span><i style={{ borderColor: edgeColors["bibliographic-coupling"] }} />耦合</span></div><div className="year-legend"><small>发表年份</small><i /><div><span>{graphMinYear}</span><span>{graphMaxYear}</span></div></div></div>
    </section>
    <aside className="paper-detail">
      <header className="paper-detail-head"><small>{selected?.seed ? "起点论文" : "关联论文"}</small><button aria-label="关闭论文详情" onClick={() => setDetailOpen(false)}>×</button></header>
      <h2>{selected?.title}</h2>
      <p>{selected?.authors.join(" · ")} · {selected?.year}</p>
      <div className="paper-open-row"><span>{selected?.citationCount} 次引用</span>{selected?.url ? <a href={selected.url} target="_blank" rel="noreferrer">打开原文 ↗</a> : <span>暂无原文链接</span>}</div>
      <div className="paper-abstract"><b>摘要</b><p>{selected?.abstract || "当前数据源未返回摘要。汐灵不会用生成内容冒充论文摘要；可打开原文继续阅读。"}</p></div>
      <dl><div><dt>相关度</dt><dd>{selected?.relevance.toFixed(2)}</dd></div><div><dt>数据来源</dt><dd>{selected?.source}</dd></div></dl>
      <label className="paper-annotation"><span>精确证据摘录</span><textarea aria-label="精确证据摘录" placeholder="粘贴论文中的原句或表述；不要用摘要或自己的概括替代…" value={selected ? quoteDrafts[selected.id] ?? "" : ""} onChange={(event) => { if (selected) setQuoteDrafts((current) => ({ ...current, [selected.id]: event.target.value })); }} /></label>
      <label className="paper-annotation compact"><span>来源定位</span><input aria-label="来源定位" placeholder="页码、章节、图表或稳定 URL" value={selected ? locatorDrafts[selected.id] ?? "" : ""} onChange={(event) => { if (selected) setLocatorDrafts((current) => ({ ...current, [selected.id]: event.target.value })); }} /></label>
      <label className="paper-annotation"><span>阅读解释</span><textarea aria-label="论文阅读标注" placeholder="解释该摘录与主张的关系…" value={selected ? noteDrafts[selected.id] ?? "" : ""} onChange={(event) => { if (selected) setNoteDrafts((current) => ({ ...current, [selected.id]: event.target.value })); }} /></label>
      <label className="paper-annotation compact"><span>目标主张版本</span><select aria-label="目标主张版本" value={selected ? claimDrafts[selected.id] ?? "" : ""} onChange={(event) => { if (selected) setClaimDrafts((current) => ({ ...current, [selected.id]: event.target.value })); }}><option value="">暂不关联主张</option>{claimRevisions.map((claim) => <option key={claim.id} value={claim.id}>v{claim.revision} · {claim.title}</option>)}</select></label>
      <div className="paper-evidence-semantics"><label><span>对目标主张的作用</span><select aria-label="证据立场" value={selected ? stanceDrafts[selected.id] ?? "insufficient" : "insufficient"} onChange={(event) => { if (selected) setStanceDrafts((current) => ({ ...current, [selected.id]: event.target.value as EvidenceRecord["stance"] })); }}><option value="supports">支持</option><option value="refutes">反驳</option><option value="qualifies">限定条件</option><option value="insufficient">证据尚不充分</option></select></label><label><span>证据置信度</span><select aria-label="证据置信度" value={String(selected ? confidenceDrafts[selected.id] ?? 0.5 : 0.5)} onChange={(event) => { if (selected) setConfidenceDrafts((current) => ({ ...current, [selected.id]: Number(event.target.value) })); }}><option value="0.25">25% · 初步</option><option value="0.5">50% · 中等</option><option value="0.75">75% · 较强</option><option value="0.9">90% · 很强</option></select></label></div>
      <label className="paper-annotation compact"><span>适用限制</span><input aria-label="适用限制" placeholder="数据范围、方法限制或不确定性" value={selected ? limitationDrafts[selected.id] ?? "" : ""} onChange={(event) => { if (selected) setLimitationDrafts((current) => ({ ...current, [selected.id]: event.target.value })); }} /></label>
      <button className="paper-promote" disabled={!selected || !(selected && quoteDrafts[selected.id]?.trim())} onClick={() => void saveEvidence()}>{selectedEvidence ? "新增一条证据记录" : "提升为项目证据"}</button>
      {selectedEvidence ? <button onClick={() => onNavigate?.("canvas")}>在科研画布中查看 →</button> : null}
      {actionStatus ? <p className="paper-action-status">{actionStatus}</p> : null}
      <div className="algorithm-note"><b>算法透明</b><p>{graph.algorithm}</p><small>{graph.nodes.length} nodes · {graph.edges.length} edges · {graph.fetchedAt}</small></div>
    </aside>
    {!detailOpen ? <button className="paper-detail-reopen" onClick={() => setDetailOpen(true)}>打开论文详情</button> : null}
  </div>;
}
