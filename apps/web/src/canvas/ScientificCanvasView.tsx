import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
  type ReactFlowInstance,
  type Viewport,
} from "@xyflow/react";
import {
  BookOpen, CheckCircle2, ClipboardCheck, Cpu, Database, FileText, FolderKanban, GripHorizontal, HelpCircle, Layers, MessageSquareQuote, Package, Search, User, X,
} from "lucide-react";
import type { ResearchGraphEntity, ResearchGraphProjection, ResearchGraphProposal, ResearchGraphView, ResearchRelationKind, ScientificCanvasLayout } from "@xiling/contracts";
import { apiJson, jsonInit } from "../lib/api-client.js";
import { useConversations } from "../workspace/ConversationContext.js";

type ScientificNodeData = ResearchGraphEntity & Record<string, unknown> & { compact?: boolean | undefined; refTier?: number | undefined };
type ScientificNode = Node<ScientificNodeData, "scientific">;
type ScientificEdge = Edge<{ kind: ResearchRelationKind }>;

const views: Array<{ id: ResearchGraphView; label: string; hint: string }> = [
  { id: "all", label: "总览", hint: "项目全部科研对象" },
  { id: "literature", label: "文献", hint: "论文、片段与引用" },
  { id: "evidence", label: "证据", hint: "主张与支持/反驳链" },
  { id: "provenance", label: "溯源", hint: "数据、计算与审查" },
  { id: "artifacts", label: "产物", hint: "版本与生命周期" },
];

const kindLabel: Record<string, string> = {
  Project: "项目", ResearchQuestion: "研究问题", Hypothesis: "假设", Claim: "主张", ClaimRevision: "主张版本",
  EvidenceAssertion: "证据断言", Paper: "论文", SourceFragment: "来源片段", Dataset: "数据集", DatasetSnapshot: "数据快照",
  ResearchPlan: "研究计划", Approval: "审批", ResearchRun: "计算运行", Artifact: "产物", ArtifactVersion: "产物版本",
  LifecycleEvent: "生命周期", ReviewReport: "审查报告", WikiRevisionRef: "Wiki 版本", Actor: "责任主体",
};
const relationLabel: Record<ResearchRelationKind, string> = {
  CONTAINS: "包含", HAS_REVISION: "版本", HAS_FRAGMENT: "片段", CITES: "引用", ASSERTS: "断言", BASED_ON: "依据",
  USED: "使用", GENERATED: "生成", DERIVED_FROM: "派生", EVALUATES: "评估", DOCUMENTS: "记录", SUPERSEDES: "取代",
  HAS_VERSION: "拥有版本", TRANSITIONED_BY: "状态变化", ASSOCIATED_WITH: "关联", REFERENCES: "指向",
};
const relationKinds = Object.keys(relationLabel) as ResearchRelationKind[];
const relationVar = (kind: ResearchRelationKind) => `var(--xl-rel-${kind.toLowerCase().replaceAll("_", "-")})`;

const kindIcon: Record<string, React.ReactNode> = {
  Project: <FolderKanban size={13} aria-hidden="true" />,
  ResearchQuestion: <HelpCircle size={13} aria-hidden="true" />,
  Hypothesis: <MessageSquareQuote size={13} aria-hidden="true" />,
  Claim: <MessageSquareQuote size={13} aria-hidden="true" />,
  ClaimRevision: <Layers size={13} aria-hidden="true" />,
  EvidenceAssertion: <CheckCircle2 size={13} aria-hidden="true" />,
  Paper: <FileText size={13} aria-hidden="true" />,
  SourceFragment: <FileText size={13} aria-hidden="true" />,
  Dataset: <Database size={13} aria-hidden="true" />,
  DatasetSnapshot: <Database size={13} aria-hidden="true" />,
  ResearchRun: <Cpu size={13} aria-hidden="true" />,
  Artifact: <Package size={13} aria-hidden="true" />,
  ArtifactVersion: <Package size={13} aria-hidden="true" />,
  ReviewReport: <ClipboardCheck size={13} aria-hidden="true" />,
  Approval: <CheckCircle2 size={13} aria-hidden="true" />,
  WikiRevisionRef: <BookOpen size={13} aria-hidden="true" />,
  Actor: <User size={13} aria-hidden="true" />,
};

const stanceLabel: Record<string, string> = { supports: "支持", refutes: "反驳", qualifies: "限定", insufficient: "证据不足" };

function ScientificNodeCard({ data, selected }: NodeProps<ScientificNode>) {
  const entityColor = `var(--xl-entity-${data.kind.toLowerCase()})`;
  if (data.compact) {
    return (
      <article className={`scientific-node scientific-node-compact ${selected ? "selected" : ""}`} title={`${kindLabel[data.kind] ?? data.kind} · ${data.title}`} style={{ borderColor: entityColor }}>
        <Handle type="target" position={Position.Top} isConnectable={false} />
        <i style={{ background: entityColor }} />
        <Handle type="source" position={Position.Bottom} isConnectable={false} />
      </article>
    );
  }
  return (
    <article className={`scientific-node ${selected ? "selected" : ""} ${data.refTier === 2 ? "ref-tier-2" : data.refTier === 1 ? "ref-tier-1" : ""}`}>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <header>
        <span className="scientific-kind" style={{ color: entityColor }}>{kindIcon[data.kind] ?? <Layers size={13} aria-hidden="true" />}{kindLabel[data.kind] ?? data.kind}</span>
        {data.status ? <i className="scientific-status">{data.status}</i> : null}
      </header>
      <h3>{data.title}</h3>
      <p>{data.summary || "暂无摘要"}</p>
      <footer>
        <span>v{data.revision}</span>
        {data.confidence !== undefined ? <span>置信度 {Math.round(data.confidence * 100)}%</span> : null}
        {data.stance ? <span className={`scientific-stance stance-${data.stance}`}>{stanceLabel[data.stance] ?? data.stance}</span> : null}
      </footer>
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </article>
  );
}

const nodeTypes: NodeTypes = { scientific: ScientificNodeCard };

const semanticRank: Record<string, number> = {
  Project: 0, ResearchQuestion: 1, Hypothesis: 2, ResearchPlan: 2, Claim: 3, Paper: 3, Dataset: 3, Approval: 3,
  ClaimRevision: 4, SourceFragment: 4, DatasetSnapshot: 4, EvidenceAssertion: 5, ResearchRun: 5, WikiRevisionRef: 5,
  Artifact: 6, ReviewReport: 6, ArtifactVersion: 7, LifecycleEvent: 8, Actor: 8,
};

const LANE_GAP = 236;
const COLUMN_GAP = 296;

export function clampFloatingPanelPosition(
  x: number,
  y: number,
  panel: { width: number; height: number },
  container: { width: number; height: number },
) {
  return {
    x: Math.min(Math.max(0, x), Math.max(0, container.width - panel.width)),
    y: Math.min(Math.max(0, y), Math.max(0, container.height - panel.height)),
  };
}

/**
 * 语义分层布局：行由科研语义与关系方向决定（纵向有序），行内用 barycenter
 * 启发式最小化连线交叉（Sugiyama 单层迭代），保证大图可读。
 */
export function arrangedPositions(entities: ResearchGraphEntity[], relations: ResearchGraphProjection["relations"] = []): Map<string, { x: number; y: number }> {
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  const forward = new Set<ResearchRelationKind>(["CONTAINS", "HAS_REVISION", "HAS_FRAGMENT", "GENERATED", "HAS_VERSION", "TRANSITIONED_BY"]);
  const reverse = new Set<ResearchRelationKind>(["ASSERTS", "BASED_ON", "USED", "DERIVED_FROM", "EVALUATES", "DOCUMENTS", "SUPERSEDES"]);
  for (const relation of relations) {
    const parentId = forward.has(relation.kind) ? relation.sourceId : reverse.has(relation.kind) ? relation.targetId : undefined;
    const childId = forward.has(relation.kind) ? relation.targetId : reverse.has(relation.kind) ? relation.sourceId : undefined;
    if (parentId && childId) {
      incoming.set(childId, [...(incoming.get(childId) ?? []), parentId]);
      outgoing.set(parentId, [...(outgoing.get(parentId) ?? []), childId]);
    }
  }
  const ranks = new Map<string, number>();
  const rankOf = (entity: ResearchGraphEntity, stack = new Set<string>()): number => {
    const cached = ranks.get(entity.id); if (cached !== undefined) return cached;
    if (stack.has(entity.id)) return semanticRank[entity.kind] ?? 4;
    const nextStack = new Set(stack).add(entity.id);
    const parents = (incoming.get(entity.id) ?? []).map((id) => entities.find((candidate) => candidate.id === id)).filter(Boolean) as ResearchGraphEntity[];
    const graphRank = parents.length ? Math.max(...parents.map((parent) => rankOf(parent, nextStack))) + 1 : 0;
    const value = Math.max(graphRank, semanticRank[entity.kind] ?? 0);
    ranks.set(entity.id, value); return value;
  };
  const rows = new Map<number, ResearchGraphEntity[]>();
  for (const entity of entities) {
    const rank = rankOf(entity);
    rows.set(rank, [...(rows.get(rank) ?? []), entity]);
  }
  const sortedRows = [...rows.entries()].sort(([left], [right]) => left - right);
  const ordered = new Map<number, ResearchGraphEntity[]>(sortedRows.map(([rank, siblings]) => [rank, [...siblings].sort((left, right) => left.title.localeCompare(right.title, "zh-CN"))]));
  // barycenter 迭代：按相邻行邻居的列均值重排行内顺序，降低连线交叉。
  for (let pass = 0; pass < 3; pass += 1) {
    for (const [rowIndex, [rank, siblings]] of sortedRows.entries()) {
      const indexOf = new Map(siblings.map((entity, index) => [entity.id, index]));
      const neighborRanks = [sortedRows[rowIndex - 1]?.[0], sortedRows[rowIndex + 1]?.[0]].filter((value): value is number => value !== undefined);
      const barycenter = (entity: ResearchGraphEntity) => {
        const neighbors = [...(incoming.get(entity.id) ?? []), ...(outgoing.get(entity.id) ?? [])]
          .filter((id) => neighborRanks.some((rankValue) => ranks.get(id) === rankValue))
          .map((id) => {
            const neighborRank = ranks.get(id) ?? rank;
            const neighborIndex = (ordered.get(neighborRank) ?? []).findIndex((candidate) => candidate.id === id);
            return neighborIndex >= 0 ? neighborIndex : indexOf.get(entity.id) ?? 0;
          });
        if (!neighbors.length) return indexOf.get(entity.id) ?? 0;
        return neighbors.reduce((total, value) => total + value, 0) / neighbors.length;
      };
      ordered.set(rank, [...siblings].sort((left, right) => barycenter(left) - barycenter(right) || left.title.localeCompare(right.title, "zh-CN")));
    }
  }
  const result = new Map<string, { x: number; y: number }>();
  sortedRows.forEach(([rank], rowIndex) => {
    const siblings = ordered.get(rank) ?? [];
    const width = (siblings.length - 1) * COLUMN_GAP;
    siblings.forEach((entity, column) => result.set(entity.id, { x: column * COLUMN_GAP - width / 2, y: rowIndex * LANE_GAP }));
  });
  return result;
}

function toNodes(graph: ResearchGraphProjection, layout: ScientificCanvasLayout): ScientificNode[] {
  const automatic = arrangedPositions(graph.nodes, graph.relations);
  const persisted = new Map(layout.positions.map((position) => [position.entityId, { x: position.x, y: position.y }]));
  return graph.nodes.map((entity) => ({ id: entity.id, type: "scientific", data: entity as ScientificNodeData, position: persisted.get(entity.id) ?? automatic.get(entity.id) ?? { x: 0, y: 0 } }));
}

function toEdges(graph: ResearchGraphProjection): ScientificEdge[] {
  return graph.relations.map((relation) => ({
    id: relation.id,
    source: relation.sourceId,
    target: relation.targetId,
    // React Flow's built-in "default" edge is the cubic Bézier renderer.
    type: "default",
    selectable: true,
    focusable: true,
    label: relationLabel[relation.kind],
    data: { kind: relation.kind },
    className: `scientific-edge scientific-edge-${relation.kind.toLowerCase().replaceAll("_", "-")}`,
    style: { stroke: relationVar(relation.kind), strokeWidth: 1.35, opacity: .66 },
    markerEnd: { type: MarkerType.ArrowClosed, color: relationVar(relation.kind), width: 13, height: 13 },
  }));
}

export function ScientificCanvasView({ projectId, onNavigate }: { projectId: string; onNavigate?: (view: "chat" | "wiki" | "papers") => void }) {
  const [view, setView] = useState<ResearchGraphView>("all");
  const [graph, setGraph] = useState<ResearchGraphProjection>();
  const [layout, setLayout] = useState<ScientificCanvasLayout>();
  const [nodes, setNodes, onNodesChange] = useNodesState<ScientificNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<ScientificEdge>([]);
  const [selectedId, setSelectedId] = useState("");
  const [selectedEdgeId, setSelectedEdgeId] = useState("");
  const [quotedIds, setQuotedIds] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [focusDepth, setFocusDepth] = useState<0 | 1 | 2>(0);
  const [relationFilter, setRelationFilter] = useState<ResearchRelationKind | "all">("all");
  const [status, setStatus] = useState("正在读取科研图…");
  const [proposals, setProposals] = useState<ResearchGraphProposal[]>([]);
  const [proposalOpen, setProposalOpen] = useState(false);
  const [proposalTitle, setProposalTitle] = useState("");
  const [proposalSummary, setProposalSummary] = useState("");
  const [zoom, setZoom] = useState(1);
  const [detailPosition, setDetailPosition] = useState<{ x: number; y: number; height: number }>();
  const [detailDragging, setDetailDragging] = useState(false);
  const canvasShell = useRef<HTMLDivElement | null>(null);
  const detailPanel = useRef<HTMLElement | null>(null);
  const detailDragCleanup = useRef<(() => void) | undefined>(undefined);
  const flow = useRef<ReactFlowInstance<ScientificNode, ScientificEdge> | null>(null);
  const revisionByView = useRef(new Map<ResearchGraphView, number>());
  const viewRef = useRef(view);
  const viewport = useRef<Viewport>({ x: 0, y: 0, zoom: 1 });
  const acceptViewportChanges = useRef(false);
  const nodesRef = useRef(nodes);
  const saveChain = useRef(Promise.resolve());
  const { activeSessionId, refreshSessions } = useConversations();

  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  useEffect(() => { viewRef.current = view; }, [view]);
  useEffect(() => () => detailDragCleanup.current?.(), []);
  useEffect(() => {
    const shell = canvasShell.current;
    if (!shell || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => {
      setDetailPosition((current) => {
        if (!current || !detailPanel.current) return current;
        const next = clampFloatingPanelPosition(current.x, current.y, { width: detailPanel.current.offsetWidth, height: current.height }, { width: shell.clientWidth, height: shell.clientHeight });
        return next.x === current.x && next.y === current.y ? current : { ...current, ...next };
      });
    });
    observer.observe(shell);
    return () => observer.disconnect();
  }, []);

  const referenceCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const relation of graph?.relations ?? []) counts.set(relation.targetId, (counts.get(relation.targetId) ?? 0) + 1);
    return counts;
  }, [graph?.relations]);

  const load = useCallback(async () => {
    acceptViewportChanges.current = false;
    setStatus("正在读取科研图…");
    try {
      const encodedProject = encodeURIComponent(projectId);
      const [nextGraph, nextLayout, nextProposals] = await Promise.all([
        apiJson<ResearchGraphProjection>(`/api/projects/${encodedProject}/research-graph?view=${view}`),
        apiJson<ScientificCanvasLayout>(`/api/projects/${encodedProject}/research-graph/layout?view=${view}`),
        apiJson<ResearchGraphProposal[]>(`/api/projects/${encodedProject}/research-graph/proposals`),
      ]);
      setGraph(nextGraph);
      setLayout(nextLayout);
      revisionByView.current.set(view, nextLayout.revision);
      setNodes(toNodes(nextGraph, nextLayout));
      setEdges(toEdges(nextGraph));
      setProposals(nextProposals);
      setSelectedId((current) => nextGraph.nodes.some((node) => node.id === current) ? current : nextGraph.nodes.find((node) => node.kind === "ResearchQuestion")?.id ?? nextGraph.nodes[0]?.id ?? "");
      setQuotedIds([]);
      setStatus(`${nextGraph.nodes.length} 个科研对象 · ${nextGraph.relations.length} 条关系`);
      window.setTimeout(async () => {
        if (nextLayout.viewport) await flow.current?.setViewport(nextLayout.viewport, { duration: 0 });
        else await flow.current?.fitView({ padding: .18, duration: 300 });
        acceptViewportChanges.current = true;
      }, 30);
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  }, [projectId, setEdges, setNodes, view]);

  useEffect(() => { void load(); }, [load]);

  const persistLayout = useCallback((snapshot: ScientificNode[], nextViewport = viewport.current) => {
    const targetView = view;
    const positions = snapshot.map((node) => ({ entityId: node.id, x: node.position.x, y: node.position.y }));
    saveChain.current = saveChain.current.then(async () => {
      try {
        const saved = await apiJson<ScientificCanvasLayout>(`/api/projects/${encodeURIComponent(projectId)}/research-graph/layout?view=${targetView}`, jsonInit("PUT", { revision: revisionByView.current.get(targetView) ?? 0, positions, viewport: nextViewport }));
        revisionByView.current.set(targetView, saved.revision);
        if (viewRef.current === targetView) { setLayout(saved); setStatus(`布局已保存 · r${saved.revision}`); }
      } catch (error) {
        if (viewRef.current === targetView) { setStatus(error instanceof Error ? `布局保存失败：${error.message}` : "布局保存失败"); await load(); }
      }
    });
  }, [load, projectId, view]);

  /** 「还原布局」：全部节点回到语义自动布局。 */
  const restoreLayout = () => {
    if (!graph) return;
    const positions = arrangedPositions(graph.nodes, graph.relations);
    const next = nodes.map((node) => ({ ...node, position: positions.get(node.id) ?? node.position }));
    setNodes(next);
    acceptViewportChanges.current = false;
    window.setTimeout(async () => {
      await flow.current?.fitView({ padding: .18, duration: 380 });
      const nextViewport = flow.current?.getViewport() ?? viewport.current;
      viewport.current = nextViewport;
      acceptViewportChanges.current = true;
      persistLayout(next, nextViewport);
    }, 20);
  };

  /** 「整理」：只重排没有用户位置的节点，用户摆好的布局永不被覆盖。 */
  const tidyUnplaced = () => {
    if (!graph || !layout) return;
    const persistedIds = new Set(layout.positions.map((position) => position.entityId));
    const positions = arrangedPositions(graph.nodes, graph.relations);
    const next = nodes.map((node) => persistedIds.has(node.id) ? node : { ...node, position: positions.get(node.id) ?? node.position });
    setNodes(next);
    persistLayout(next);
  };

  const selected = graph?.nodes.find((node) => node.id === selectedId);
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId);
  const relatedRelations = graph?.relations.filter((relation) => relation.sourceId === selectedId || relation.targetId === selectedId) ?? [];
  const focusedIds = useMemo(() => {
    if (!focusDepth || !selectedId) return undefined;
    const ids = new Set([selectedId]);
    let frontier = [selectedId];
    for (let depth = 0; depth < focusDepth; depth += 1) {
      const next: string[] = [];
      for (const relation of graph?.relations ?? []) {
        for (const id of frontier) {
          if (relation.sourceId === id && !ids.has(relation.targetId)) { ids.add(relation.targetId); next.push(relation.targetId); }
          if (relation.targetId === id && !ids.has(relation.sourceId)) { ids.add(relation.sourceId); next.push(relation.sourceId); }
        }
      }
      frontier = next;
    }
    return ids;
  }, [focusDepth, graph?.relations, selectedId]);

  const searchMatches = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    if (!term) return [];
    return nodes.filter((node) => `${node.data.title} ${node.data.summary} ${kindLabel[node.data.kind] ?? node.data.kind}`.toLocaleLowerCase().includes(term));
  }, [nodes, query]);

  const filteredEdges = useMemo(() => {
    const matching = query.trim() ? new Set(searchMatches.map((node) => node.id)) : undefined;
    return edges.map((edge) => {
      const relationMatches = relationFilter === "all" || edge.data?.kind === relationFilter;
      const focusMatches = !focusedIds || (focusedIds.has(edge.source) && focusedIds.has(edge.target));
      return { ...edge, hidden: !relationMatches || !focusMatches, style: { ...edge.style, opacity: matching ? matching.has(edge.source) || matching.has(edge.target) ? .8 : .09 : selectedId && (edge.source === selectedId || edge.target === selectedId) ? .9 : .42, strokeWidth: selectedId && (edge.source === selectedId || edge.target === selectedId) ? 1.8 : 1.15 } };
    });
  }, [edges, focusedIds, searchMatches, query, relationFilter, selectedId]);
  const displayedNodes = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    const compact = zoom < 0.5;
    return nodes.map((node) => {
      const matches = !term || `${node.data.title} ${node.data.summary} ${kindLabel[node.data.kind] ?? node.data.kind}`.toLocaleLowerCase().includes(term);
      const references = referenceCounts.get(node.id) ?? 0;
      const refTier = references >= 5 ? 2 : references >= 2 ? 1 : 0;
      return { ...node, hidden: Boolean(focusedIds && !focusedIds.has(node.id)), selected: node.id === selectedId, data: { ...node.data, compact, refTier }, style: { ...node.style, opacity: matches ? 1 : .18 } };
    });
  }, [focusedIds, nodes, query, referenceCounts, selectedId, zoom]);

  const jumpToNode = (id: string) => {
    const match = nodes.find((node) => node.id === id);
    if (!match || !flow.current) return;
    setSelectedId(id);
    setSelectedEdgeId("");
    void flow.current.setCenter(match.position.x + 125, match.position.y + 65, { zoom: Math.max(flow.current.getZoom(), .85), duration: 280 });
  };

  const beginDetailDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button, a, input, textarea, select")) return;
    const shell = canvasShell.current;
    const panel = detailPanel.current;
    if (!shell || !panel) return;
    const shellRect = shell.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const start = clampFloatingPanelPosition(panelRect.left - shellRect.left, panelRect.top - shellRect.top, panelRect, shellRect);
    const drag = { pointerId: event.pointerId, offsetX: event.clientX - panelRect.left, offsetY: event.clientY - panelRect.top, width: panelRect.width, height: panelRect.height };
    setDetailPosition({ ...start, height: panelRect.height });
    setDetailDragging(true);
    document.body.classList.add("dragging-canvas-detail");
    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== drag.pointerId) return;
      const currentShell = canvasShell.current;
      if (!currentShell) return;
      const currentShellRect = currentShell.getBoundingClientRect();
      const next = clampFloatingPanelPosition(pointer.clientX - currentShellRect.left - drag.offsetX, pointer.clientY - currentShellRect.top - drag.offsetY, drag, currentShellRect);
      setDetailPosition({ ...next, height: drag.height });
      pointer.preventDefault();
    };
    const stop = (pointer?: PointerEvent) => {
      if (pointer && pointer.pointerId !== drag.pointerId) return;
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", stop);
      document.removeEventListener("pointercancel", stop);
      document.body.classList.remove("dragging-canvas-detail");
      detailDragCleanup.current = undefined;
      setDetailDragging(false);
    };
    detailDragCleanup.current?.();
    detailDragCleanup.current = () => stop();
    document.addEventListener("pointermove", move, { passive: false });
    document.addEventListener("pointerup", stop);
    document.addEventListener("pointercancel", stop);
    event.preventDefault();
    event.stopPropagation();
  };

  const setChatContext = async () => {
    if (!activeSessionId || !selectedId) return;
    setStatus("正在更新 Chat 上下文…");
    try {
      await apiJson(`/api/v1/chat-sessions/${encodeURIComponent(activeSessionId)}/context`, jsonInit("PUT", { activeNodeId: selectedId, quotedNodeIds: quotedIds.filter((id) => id !== selectedId) }));
      await refreshSessions(activeSessionId);
      setStatus("已将科研实体与显式引用设为当前 Chat 上下文");
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  };

  const submitProposal = async () => {
    if (!proposalTitle.trim() || !proposalSummary.trim()) return;
    const action = selected?.kind === "Claim"
      ? { type: "revise_claim" as const, claimId: selected.id, title: proposalTitle.trim(), summary: proposalSummary.trim() }
      : { type: "create_claim" as const, title: proposalTitle.trim(), summary: proposalSummary.trim() };
    setStatus("正在创建科研图变更提案…");
    try {
      const created = await apiJson<ResearchGraphProposal>(`/api/projects/${encodeURIComponent(projectId)}/research-graph/proposals`, jsonInit("POST", action));
      setProposals((current) => [created, ...current]);
      setProposalOpen(false); setProposalTitle(""); setProposalSummary("");
      setStatus("提案已生成；接受前不会改变科研事实");
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  };

  const decideProposal = async (proposal: ResearchGraphProposal, decision: "accept" | "reject") => {
    setStatus(decision === "accept" ? "正在应用已确认的科研变更…" : "正在拒绝提案…");
    try {
      await apiJson(`/api/projects/${encodeURIComponent(projectId)}/research-graph/proposals/${proposal.id}/decision`, jsonInit("POST", { decision }));
      await load();
      setStatus(decision === "accept" ? "科研图已写入新主张版本" : "提案已拒绝；科研图未改变");
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  };

  return <div className="scientific-canvas-shell" ref={canvasShell}>
    <div className="scientific-canvas-topbar">
      <div className="scientific-canvas-views">{views.map((item) => <button key={item.id} className={view === item.id ? "active" : ""} title={item.hint} onClick={() => setView(item.id)}>{item.label}</button>)}</div>
      <div className="scientific-canvas-actions">
        <button onClick={() => { setProposalOpen(true); setProposalTitle(selected?.kind === "Claim" ? selected.title : ""); setProposalSummary(selected?.kind === "Claim" ? selected.summary : ""); }}>{selected?.kind === "Claim" ? "修订主张" : "提出主张"}</button>
        <div className="scientific-focus-switch" role="group" aria-label="邻域聚焦深度">
          <button className={focusDepth === 1 ? "active" : ""} disabled={!selectedId} onClick={() => setFocusDepth((current) => current === 1 ? 0 : 1)}>聚焦 1 跳</button>
          <button className={focusDepth === 2 ? "active" : ""} disabled={!selectedId} onClick={() => setFocusDepth((current) => current === 2 ? 0 : 2)}>2 跳</button>
        </div>
        <button onClick={tidyUnplaced} title="只整理没有手动位置的节点">整理</button>
        <button onClick={restoreLayout} title="全部节点回到自动布局（覆盖手动位置）">还原布局</button>
        <button onClick={() => void flow.current?.fitView({ padding: .18, duration: 300 })}>查看全景</button>
      </div>
    </div>
    <div className="scientific-canvas-search">
      <Search size={13} aria-hidden="true" />
      <input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && searchMatches[0]) jumpToNode(searchMatches[0].id); }} placeholder="搜索实体、摘要或类型" />
      {query ? <button aria-label="清除搜索" onClick={() => setQuery("")}><X size={12} /></button> : null}
      <span>{status}</span>
      {searchMatches.length ? (
        <div className="scientific-search-results">
          {searchMatches.slice(0, 8).map((node) => <button key={node.id} onClick={() => jumpToNode(node.id)}><span>{kindLabel[node.data.kind] ?? node.data.kind}</span>{node.data.title}</button>)}
        </div>
      ) : null}
    </div>
    <ReactFlow<ScientificNode, ScientificEdge>
      nodes={displayedNodes}
      edges={filteredEdges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={(_, node) => { setSelectedId(node.id); setSelectedEdgeId(""); }}
      onEdgeClick={(_, edge) => { setSelectedEdgeId(edge.id); setSelectedId(""); }}
      onNodeDragStop={(_, dragged) => {
        const snapshot = nodesRef.current.map((node) => node.id === dragged.id ? { ...node, position: dragged.position } : node);
        persistLayout(snapshot);
      }}
      onInit={(instance) => { flow.current = instance; }}
      onMove={(_, nextViewport) => setZoom(nextViewport.zoom)}
      onMoveEnd={(_, nextViewport) => { viewport.current = nextViewport; if (acceptViewportChanges.current) persistLayout(nodesRef.current, nextViewport); }}
      nodesDraggable
      nodesConnectable={false}
      edgesReconnectable={false}
      panOnScroll
      panOnScrollSpeed={.8}
      zoomOnScroll={false}
      zoomActivationKeyCode={["Meta", "Control"]}
      zoomOnPinch
      minZoom={.16}
      maxZoom={2.4}
      deleteKeyCode={null}
    >
      <Background gap={32} size={1} className="scientific-background" />
      <Controls position="bottom-right" />
    </ReactFlow>
    <aside
      ref={detailPanel}
      className={`scientific-canvas-detail ${selected || selectedEdge ? "open" : ""} ${detailPosition ? "is-positioned" : ""} ${detailDragging ? "is-dragging" : ""}`}
      style={detailPosition ? { left: detailPosition.x, top: detailPosition.y, right: "auto", bottom: "auto", height: detailPosition.height } : undefined}
    >
      {selected ? <>
        <header className="scientific-canvas-detail-handle" title="拖动移动详情面板" onPointerDown={beginDetailDrag}><span><GripHorizontal size={15} aria-hidden="true" />{kindLabel[selected.kind] ?? selected.kind}</span><button aria-label="关闭详情" onClick={() => setSelectedId("")}>×</button></header>
        <h2>{selected.title}</h2><p>{selected.summary || "暂无摘要"}</p>
        <dl><div><dt>状态</dt><dd>{selected.status ?? "未标记"}</dd></div><div><dt>版本</dt><dd>{selected.revision}</dd></div><div><dt>关系</dt><dd>{relatedRelations.length}</dd></div>{selected.stance ? <div><dt>立场</dt><dd>{stanceLabel[selected.stance] ?? selected.stance}</dd></div> : null}</dl>
        {selected.uri ? <code>{selected.uri}</code> : null}
        {selected.sourceLocator ? <div className="scientific-source-action">{/^https?:\/\//.test(selected.sourceLocator) ? <a href={selected.sourceLocator} target="_blank" rel="noreferrer">打开原始来源 ↗</a> : <button onClick={() => onNavigate?.(selected.kind === "Paper" || selected.kind === "SourceFragment" ? "papers" : selected.kind === "WikiRevisionRef" ? "wiki" : "chat")}>前往来源视图</button>}<small>{selected.sourceLocator}</small></div> : null}
        <section><b>直接关系</b>{relatedRelations.slice(0, 8).map((relation) => {
          const peerId = relation.sourceId === selected.id ? relation.targetId : relation.sourceId;
          const peer = graph?.nodes.find((node) => node.id === peerId);
          return <button key={relation.id} onClick={() => setSelectedId(peerId)}><span>{relationLabel[relation.kind]}</span>{peer?.title ?? peerId}</button>;
        })}{!relatedRelations.length ? <small>尚无直接关系</small> : null}</section>
        <div className="scientific-context-actions">
          <button className={quotedIds.includes(selected.id) ? "active" : ""} onClick={() => setQuotedIds((current) => current.includes(selected.id) ? current.filter((id) => id !== selected.id) : [...current, selected.id].slice(-12))}>{quotedIds.includes(selected.id) ? "移除显式引用" : "加入显式引用"}</button>
          <button className="primary" disabled={!activeSessionId} title={activeSessionId ? "当前会话只会加载该实体的有限科研邻域" : "请先在 Chat 中新建或选择一个对话"} onClick={() => void setChatContext()}>设为 Chat 上下文</button>
        </div>
        {!activeSessionId ? <small className="scientific-context-hint">先在 Chat 新建或选择对话后即可绑定上下文。</small> : null}
      </> : null}
      {selectedEdge ? <>
        <header className="scientific-canvas-detail-handle" title="拖动移动详情面板" onPointerDown={beginDetailDrag}><span><GripHorizontal size={15} aria-hidden="true" />关系详情</span><button aria-label="关闭详情" onClick={() => setSelectedEdgeId("")}>×</button></header>
        <h2>{relationLabel[selectedEdge.data?.kind ?? "REFERENCES"]}</h2>
        <dl>
          <div><dt>类型</dt><dd>{selectedEdge.data?.kind}</dd></div>
          <div><dt>起点</dt><dd>{graph?.nodes.find((node) => node.id === selectedEdge.source)?.title ?? selectedEdge.source}</dd></div>
          <div><dt>终点</dt><dd>{graph?.nodes.find((node) => node.id === selectedEdge.target)?.title ?? selectedEdge.target}</dd></div>
        </dl>
        <div className="scientific-context-actions">
          <button onClick={() => { setSelectedId(selectedEdge.source); setSelectedEdgeId(""); }}>查看起点</button>
          <button onClick={() => { setSelectedId(selectedEdge.target); setSelectedEdgeId(""); }}>查看终点</button>
        </div>
      </> : null}
    </aside>
    <div className="scientific-canvas-legend">
      <button className={relationFilter === "all" ? "active" : ""} onClick={() => setRelationFilter("all")}>全部关系</button>
      {relationKinds.map((kind) => <button key={kind} className={relationFilter === kind ? "active" : ""} onClick={() => setRelationFilter((current) => current === kind ? "all" : kind)}><i style={{ background: relationVar(kind) }} />{relationLabel[kind]}</button>)}
    </div>
    {proposalOpen ? <div className="scientific-proposal-dialog" role="dialog" aria-modal="true" aria-label="科研图变更提案"><div><header><div><small>{selected?.kind === "Claim" ? "创建不可变主张版本" : "创建新科研主张"}</small><h2>预览科研图变更</h2></div><button aria-label="关闭" onClick={() => setProposalOpen(false)}>×</button></header><label><span>主张标题</span><input autoFocus value={proposalTitle} onChange={(event) => setProposalTitle(event.target.value)} /></label><label><span>主张内容与适用边界</span><textarea value={proposalSummary} onChange={(event) => setProposalSummary(event.target.value)} placeholder="写明结论、条件、时间/区域范围和不确定性…" /></label><p>提交只生成待审提案；接受后才会写入 Claim / ClaimRevision，并保留版本关系。</p><footer><button onClick={() => setProposalOpen(false)}>取消</button><button className="primary" disabled={!proposalTitle.trim() || !proposalSummary.trim()} onClick={() => void submitProposal()}>生成提案</button></footer></div></div> : null}
    {proposals.some((proposal) => proposal.status === "pending") ? <aside className="scientific-proposal-tray"><header><b>待确认变更</b><span>{proposals.filter((proposal) => proposal.status === "pending").length}</span></header>{proposals.filter((proposal) => proposal.status === "pending").map((proposal) => <article key={proposal.id}><small>{proposal.action.type === "create_claim" ? "新建主张" : "修订主张"}</small><b>{proposal.action.title}</b><p>{proposal.action.summary}</p><footer><button onClick={() => void decideProposal(proposal, "reject")}>拒绝</button><button className="primary" onClick={() => void decideProposal(proposal, "accept")}>接受并写入</button></footer></article>)}</aside> : null}
  </div>;
}
