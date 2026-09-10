// 科研画布窗口：呈现 Research Graph 投影（类型化科研关系）。
//
// 画布只读；它不写科研事实，坐标只是显示布局。投影失败或仍有待处理记录时如实显示，
// 不让空图看起来像"这个项目没有关系" —— 这正是本轮修掉的那类静默失败。

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ResearchGraphEntity, ResearchGraphProjection, ResearchGraphRelation } from "@xiling/contracts";
import { ResearchScopeGate, useResearchScope } from "./scope.js";

interface ProjectionResult {
  graph?: ResearchGraphProjection;
  graphPending?: number;
  graphError?: string;
}

const KIND_LABELS: Record<string, string> = {
  Project: "项目", ResearchQuestion: "研究问题", Paper: "论文", SourceFragment: "来源片段",
  EvidenceAssertion: "证据断言", WikiRevisionRef: "Wiki 版本", Artifact: "产物", ArtifactVersion: "产物版本",
  Claim: "结论", ClaimRevision: "结论版本", Method: "方法", Tool: "工具", Decision: "决定", Review: "审查",
};
const KIND_ORDER = ["Project", "ResearchQuestion", "Claim", "ClaimRevision", "EvidenceAssertion", "SourceFragment", "Paper", "WikiRevisionRef", "Artifact", "ArtifactVersion"];

const COLUMN_WIDTH = 236;
const ROW_HEIGHT = 46;
const NODE_WIDTH = 204;
const NODE_HEIGHT = 34;

export function CanvasWindow() {
  const scope = useResearchScope("system.canvas");
  const [projection, setProjection] = useState<ResearchGraphProjection>();
  const [pending, setPending] = useState(0);
  const [projectionError, setProjectionError] = useState("");
  const [hidden, setHidden] = useState<string[]>([]);
  const [selected, setSelected] = useState<string>();
  const [status, setStatus] = useState("");

  const load = useCallback(async () => {
    if (!scope.projectId) { setProjection(undefined); return; }
    setStatus("正在读取科研图谱…");
    try {
      const result = await scope.run<ProjectionResult>("graph.projection");
      setProjection(result.graph);
      setPending(result.graphPending ?? 0);
      setProjectionError(result.graphError ?? "");
      setStatus("");
    } catch (reason) { setStatus(scope.describeError(reason)); }
  }, [scope.projectId, scope.run, scope.describeError]);

  useEffect(() => { setSelected(undefined); void load(); }, [load]);

  const layout = useMemo(() => {
    const nodes = (projection?.nodes ?? []).filter((node) => !hidden.includes(node.kind));
    const kinds = [...new Set(nodes.map((node) => node.kind))].sort((left, right) => {
      const a = KIND_ORDER.indexOf(left); const b = KIND_ORDER.indexOf(right);
      return (a < 0 ? 99 : a) - (b < 0 ? 99 : b) || left.localeCompare(right);
    });
    const columns = new Map(kinds.map((kind, index) => [kind, index]));
    const rows = new Map<string, number>();
    const seen = new Map<string, number>();
    for (const node of nodes) {
      const row = seen.get(node.kind) ?? 0;
      rows.set(node.id, row);
      seen.set(node.kind, row + 1);
    }
    const positions = new Map<string, { x: number; y: number }>();
    for (const node of nodes) {
      positions.set(node.id, { x: (columns.get(node.kind) ?? 0) * COLUMN_WIDTH + 16, y: (rows.get(node.id) ?? 0) * ROW_HEIGHT + 40 });
    }
    return { nodes, kinds, positions, width: Math.max(kinds.length, 1) * COLUMN_WIDTH + 16, height: Math.max(...kinds.map((kind) => seen.get(kind) ?? 0), 1) * ROW_HEIGHT + 64 };
  }, [projection, hidden]);

  const selectedNode = (projection?.nodes ?? []).find((node) => node.id === selected);
  const related = (projection?.relations ?? []).filter((relation) => relation.sourceId === selected || relation.targetId === selected);
  const kindCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of projection?.nodes ?? []) counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [projection]);

  return <section className="research-window canvas-window">
    <ResearchScopeGate api={scope}>
      <header className="research-window-head">
        <div>
          <p className="eyebrow">科研关系</p>
          <h2>科研画布</h2>
          <p>类型化科研关系：哪份来源、证据、计算与产物支持哪个结论版本。画布不写科研事实，只读投影。</p>
        </div>
        <div className="research-window-metrics" aria-label="图谱摘要">
          <span><strong>{projection?.nodes.length ?? 0}</strong>科研实体</span>
          <span><strong>{projection?.relations.length ?? 0}</strong>类型化关系</span>
          <span><strong>{pending}</strong>待投影</span>
        </div>
      </header>

      {projectionError ? <p role="alert" className="research-window-error">
        图谱投影未完成：{projectionError} —— 下面的图可能不完整，存在 {pending} 条待投影关系；成功后会自动补齐。
      </p> : null}
      {pending > 0 && !projectionError ? <p className="research-window-status">还有 {pending} 条关系待投影。</p> : null}
      {status ? <p role="status" className="research-window-status">{status}</p> : null}

      <div className="canvas-filters" role="group" aria-label="按类型筛选">
        {kindCounts.map(([kind, count]) => <button key={kind} type="button" aria-pressed={!hidden.includes(kind)}
          onClick={() => setHidden((current) => current.includes(kind) ? current.filter((item) => item !== kind) : [...current, kind])}>
          {KIND_LABELS[kind] ?? kind} · {count}
        </button>)}
        <button type="button" className="canvas-refresh" onClick={() => void load()}>重新读取</button>
      </div>

      <div className="canvas-body">
        {(projection?.nodes.length ?? 0) === 0 ? <p className="research-window-empty">
          这个项目的科研图谱还是空的。从文献工作台把论文提升为项目证据后，这里会出现可追踪的论文、来源片段与证据断言。
        </p> : <div className="canvas-scroll">
          <svg className="canvas-svg" width={layout.width} height={layout.height} role="img" aria-label="科研关系图">
            {(projection?.relations ?? []).map((relation: ResearchGraphRelation) => {
              const from = layout.positions.get(relation.sourceId); const to = layout.positions.get(relation.targetId);
              if (!from || !to) return null;
              const x1 = from.x + NODE_WIDTH; const y1 = from.y + NODE_HEIGHT / 2;
              const x2 = to.x; const y2 = to.y + NODE_HEIGHT / 2;
              const mid = (x1 + x2) / 2;
              return <g key={relation.id} className={`canvas-edge ${selected && (relation.sourceId === selected || relation.targetId === selected) ? "is-focus" : ""}`}>
                <path d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`} fill="none" />
                <title>{relation.kind}</title>
              </g>;
            })}
            {layout.nodes.map((node: ResearchGraphEntity) => {
              const position = layout.positions.get(node.id)!;
              return <g key={node.id} className={`canvas-node ${selected === node.id ? "is-selected" : ""}`}
                transform={`translate(${position.x}, ${position.y})`} onClick={() => setSelected(node.id)} role="button" tabIndex={0}
                onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setSelected(node.id); }}>
                <rect width={NODE_WIDTH} height={NODE_HEIGHT} rx={6} />
                <text x={10} y={22}>{truncate(node.title, 26)}</text>
                <title>{`${node.kind}：${node.title}${node.summary ? ` — ${truncate(node.summary, 160)}` : ""}`}</title>
              </g>;
            })}
          </svg>
        </div>}

        <aside className="canvas-detail">
          {selectedNode ? <>
            <header><small>{KIND_LABELS[selectedNode.kind] ?? selectedNode.kind}</small><h3>{selectedNode.title}</h3></header>
            {selectedNode.summary ? <p>{selectedNode.summary}</p> : null}
            <dl>
              {selectedNode.stance ? <div><dt>立场</dt><dd>{selectedNode.stance}</dd></div> : null}
              {typeof selectedNode.confidence === "number" ? <div><dt>置信度</dt><dd>{Math.round(selectedNode.confidence * 100)}%</dd></div> : null}
              {selectedNode.status ? <div><dt>状态</dt><dd>{selectedNode.status}</dd></div> : null}
              {selectedNode.revision !== undefined ? <div><dt>版本</dt><dd>v{selectedNode.revision}</dd></div> : null}
              <div><dt>实体 ID</dt><dd className="canvas-mono">{selectedNode.id}</dd></div>
            </dl>
            {selectedNode.sourceLocator ? <p className="canvas-locator">来源定位：<span className="canvas-mono">{selectedNode.sourceLocator}</span></p> : null}
            <h4>关系（{related.length}）</h4>
            <ul className="canvas-relations">{related.map((relation) => <li key={relation.id}>
              <b>{relation.kind}</b>
              <span>{relation.sourceId === selectedNode.id ? `→ ${labelOf(projection, relation.targetId)}` : `← ${labelOf(projection, relation.sourceId)}`}</span>
            </li>)}</ul>
            {related.length === 0 ? <p className="research-window-hint">这个实体还没有类型化关系。</p> : null}
          </> : <p className="research-window-hint">点一个实体查看它的证据、来源定位与类型化关系。</p>}
        </aside>
      </div>
    </ResearchScopeGate>
  </section>;
}

function labelOf(projection: ResearchGraphProjection | undefined, id: string): string {
  return projection?.nodes.find((node) => node.id === id)?.title ?? id;
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}
