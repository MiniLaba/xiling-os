import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
  type ReactFlowInstance,
} from "@xyflow/react";
import { unstable_useComposerInput } from "@assistant-ui/react";
import type { AgentExecutionGraphProjection, AgentExecutionNode, AgentExecutionGraphScope } from "@xiling/contracts";
import { RecordDetailModal } from "../components/RecordDetailModal.js";

type ConversationDisplayKind = "thread" | "prompt" | "response" | "agent-task";
type InteractionMode = "follow-up" | "quote";

export interface ConversationNodeData extends Record<string, unknown> {
  sourceNode: AgentExecutionNode;
  displayKind: ConversationDisplayKind;
  summary: string;
  hiddenDetailCount: number;
  toolNames: string[];
  active?: boolean;
  quoted?: boolean;
  dimmed?: boolean;
}

export type ConversationNode = Node<ConversationNodeData, "conversation">;
export type ConversationEdge = Edge<{ kind: "thread" | "answer" | "follow-up" | "delegation" }>;

const displayLabel: Record<ConversationDisplayKind, string> = {
  thread: "对话",
  prompt: "你",
  response: "汐灵",
  "agent-task": "子智能体",
};

const formatNodeTime = (timestamp: string) => new Date(timestamp).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
function ConversationCard({ data, selected }: NodeProps<ConversationNode>) {
  return (
    <article className={`execution-card execution-${data.displayKind} ${data.active ? "active-context" : ""} ${data.quoted ? "quoted-context" : ""} ${data.dimmed ? "dimmed" : ""} ${selected ? "selected" : ""}`}>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <header><span><i />{displayLabel[data.displayKind]}</span>{data.sourceNode.status ? <em>{data.sourceNode.status}</em> : null}</header>
      <p>{data.summary || "已记录"}</p>
      <footer>
        <time>{formatNodeTime(data.sourceNode.timestamp)}</time>
        <span>{data.toolNames.length ? `${data.toolNames.length} 工具` : data.hiddenDetailCount ? `${data.hiddenDetailCount} 细节` : data.sourceNode.metrics?.totalTokens ? `${data.sourceNode.metrics.totalTokens.toLocaleString()} tok` : ""}</span>
      </footer>
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </article>
  );
}

const nodeTypes: NodeTypes = { conversation: ConversationCard };
const compactText = (value: string, max = 220) => {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
};

const toEdge = (id: string, source: string, target: string, kind: "thread" | "answer" | "follow-up" | "delegation"): ConversationEdge => ({
  id,
  source,
  target,
  type: "bezier",
  data: { kind },
  style: {
    stroke: kind === "delegation" ? "#75a9b4" : kind === "answer" ? "#9eb7c8" : "#b6c0ca",
    strokeWidth: kind === "answer" || kind === "delegation" ? 1.5 : 1.2,
    ...(kind === "follow-up" || kind === "thread" ? { strokeDasharray: "4 5" } : {}),
  },
  focusable: false,
});

/**
 * Converts the complete Agent journal projection into a low-density
 * conversation canvas. Model calls, tools, tool results and compactions stay
 * available in the durable projection but are folded into their answer node.
 */
export function buildConversationCanvas(projection: AgentExecutionGraphProjection): { nodes: ConversationNode[]; edges: ConversationEdge[]; foldedDetails: number } {
  const rawNodes = projection.nodes;
  const sessions = rawNodes.filter((node) => node.kind === "session").sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const runs = rawNodes.filter((node) => node.kind === "run").sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const delegations = rawNodes.filter((node) => node.kind === "delegation").sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const delegatedSessionIds = new Set(delegations.flatMap((node) => typeof node.childSessionId === "string" ? [node.childSessionId] : []));
  const nodes: ConversationNode[] = [];
  const edges: ConversationEdge[] = [];
  let foldedDetails = 0;

  if (projection.scope === "project") {
    for (const session of sessions.filter((item) => !item.source.sessionId || !delegatedSessionIds.has(item.source.sessionId))) {
      nodes.push({
        id: `thread:${session.source.sessionId ?? session.id}`,
        type: "conversation",
        position: { x: 0, y: 0 },
        data: { sourceNode: session, displayKind: "thread", summary: session.title, hiddenDetailCount: 0, toolNames: [] },
      });
    }
  }

  const previousBySession = new Map<string, string>();
  const firstPromptBySession = new Map<string, string>();
  for (const run of runs) {
    const runId = run.source.runId;
    const sessionId = run.source.sessionId;
    if (!runId || !sessionId) continue;
    const runNodes = rawNodes.filter((node) => node.source.runId === runId && node.id !== run.id);
    const response = [...runNodes].reverse().find((node) => node.kind === "message" && node.title === "Agent 回答");
    const toolNames = [...new Set(runNodes.filter((node) => node.kind === "tool").map((node) => node.title))];
    const hiddenDetailCount = runNodes.filter((node) => node.id !== response?.id).length;
    foldedDetails += hiddenDetailCount;
    const promptId = `prompt:${runId}`;
    const responseId = `response:${runId}`;
    nodes.push({
      id: promptId,
      type: "conversation",
      position: { x: 0, y: 0 },
      data: { sourceNode: run, displayKind: "prompt", summary: compactText(run.title), hiddenDetailCount: 0, toolNames: [] },
    });
    if (!firstPromptBySession.has(sessionId)) firstPromptBySession.set(sessionId, promptId);
    const previous = previousBySession.get(sessionId);
    if (previous) edges.push(toEdge(`follow-up:${previous}:${promptId}`, previous, promptId, "follow-up"));
    if (response || run.status === "running" || run.status === "queued") {
      const responseSource = response ?? run;
      nodes.push({
        id: responseId,
        type: "conversation",
        position: { x: 0, y: 0 },
        data: {
          sourceNode: responseSource,
          displayKind: "response",
          summary: response ? compactText(response.summary) : run.status === "running" ? "正在处理这项研究任务…" : "等待开始…",
          hiddenDetailCount,
          toolNames,
        },
      });
      edges.push(toEdge(`answer:${promptId}:${responseId}`, promptId, responseId, "answer"));
      previousBySession.set(sessionId, responseId);
    } else {
      previousBySession.set(sessionId, promptId);
    }
  }

  if (projection.scope === "project") {
    for (const [sessionId, firstPrompt] of firstPromptBySession) {
      const threadId = `thread:${sessionId}`;
      if (nodes.some((node) => node.id === threadId)) edges.push(toEdge(`thread:${threadId}:${firstPrompt}`, threadId, firstPrompt, "thread"));
    }
  }
  for (const delegation of delegations) {
    const parentRunId = typeof delegation.parentRunId === "string" ? delegation.parentRunId : delegation.source.runId;
    const childRunId = typeof delegation.childRunId === "string" ? delegation.childRunId : undefined;
    const taskId = `agent-task:${delegation.source.delegationId ?? delegation.id}`;
    nodes.push({
      id: taskId,
      type: "conversation",
      position: { x: 0, y: 0 },
      data: { sourceNode: delegation, displayKind: "agent-task", summary: compactText(delegation.summary), hiddenDetailCount: 0, toolNames: [] },
    });
    if (parentRunId) {
      const parentResponse = nodes.some((node) => node.id === `response:${parentRunId}`) ? `response:${parentRunId}` : `prompt:${parentRunId}`;
      edges.push(toEdge(`delegation:${parentResponse}:${taskId}`, parentResponse, taskId, "delegation"));
    }
    if (childRunId && nodes.some((node) => node.id === `prompt:${childRunId}`)) edges.push(toEdge(`delegation:${taskId}:prompt:${childRunId}`, taskId, `prompt:${childRunId}`, "delegation"));
  }
  return { nodes, edges, foldedDetails };
}

export function arrangeConversationCanvas(nodes: ConversationNode[], edges: ConversationEdge[]): ConversationNode[] {
  const ids = new Set(nodes.map((node) => node.id));
  const incoming = new Map(nodes.map((node) => [node.id, 0]));
  const children = new Map(nodes.map((node) => [node.id, [] as string[]]));
  for (const item of edges) {
    if (!ids.has(item.source) || !ids.has(item.target)) continue;
    incoming.set(item.target, (incoming.get(item.target) ?? 0) + 1);
    children.get(item.source)?.push(item.target);
  }
  const ranks = new Map(nodes.map((node) => [node.id, 0]));
  const queue = nodes.filter((node) => (incoming.get(node.id) ?? 0) === 0).map((node) => node.id);
  while (queue.length) {
    const current = queue.shift()!;
    for (const child of children.get(current) ?? []) {
      ranks.set(child, Math.max(ranks.get(child) ?? 0, (ranks.get(current) ?? 0) + 1));
      incoming.set(child, (incoming.get(child) ?? 1) - 1);
      if (incoming.get(child) === 0) queue.push(child);
    }
  }
  const rows = new Map<number, ConversationNode[]>();
  for (const node of nodes) {
    const rank = ranks.get(node.id) ?? 0;
    rows.set(rank, [...(rows.get(rank) ?? []), node]);
  }
  return [...rows.entries()].sort(([a], [b]) => a - b).flatMap(([rank, row]) => {
    const ordered = [...row].sort((a, b) => a.data.sourceNode.timestamp.localeCompare(b.data.sourceNode.timestamp));
    const gap = 286;
    const start = -((ordered.length - 1) * gap) / 2;
    return ordered.map((node, index) => ({ ...node, position: { x: start + index * gap, y: 70 + rank * 174 } }));
  });
}

const formatDuration = (value?: number) => value === undefined ? "—" : value < 1_000 ? `${value} ms` : `${(value / 1_000).toFixed(1)} s`;

export function AgentExecutionGraphView({ projectId, activeSessionId, refreshKey = 0, onReturnToChat }: { projectId: string; activeSessionId: string; refreshKey?: number; onReturnToChat?: () => void }) {
  const [scope, setScope] = useState<AgentExecutionGraphScope>(() => activeSessionId ? "session" : "project");
  const [projection, setProjection] = useState<AgentExecutionGraphProjection>();
  const [foldedDetails, setFoldedDetails] = useState(0);
  const [error, setError] = useState("");
  const [interactionMode, setInteractionMode] = useState<InteractionMode>("follow-up");
  const interactionModeRef = useRef<InteractionMode>("follow-up");
  const [activeNodeId, setActiveNodeId] = useState("");
  const [quotedNodeIds, setQuotedNodeIds] = useState<string[]>([]);
  const quotedNodeIdsRef = useRef<string[]>([]);
  const [inspected, setInspected] = useState<AgentExecutionNode>();
  const [nodes, setNodes, onNodesChange] = useNodesState<ConversationNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<ConversationEdge>([]);
  const flow = useRef<ReactFlowInstance<ConversationNode, ConversationEdge> | null>(null);

  useEffect(() => { if (activeSessionId) setScope("session"); }, [activeSessionId]);
  const fit = useCallback(() => { window.setTimeout(() => void flow.current?.fitView({ padding: 0.22, duration: 260, maxZoom: 1.08 }), 40); }, []);
  const autoArrange = useCallback(() => { setNodes((current) => arrangeConversationCanvas(current, edges)); fit(); }, [edges, fit, setNodes]);

  useEffect(() => {
    let cancelled = false;
    setError("");
    const query = new URLSearchParams({ projectId, scope, ...(scope === "session" && activeSessionId ? { sessionId: activeSessionId } : {}) });
    void fetch(`/api/agent-center/graph?${query}`).then(async (response) => {
      if (!response.ok) throw new Error(response.status === 404 && scope === "session" ? "当前还没有可展示的 Agent 会话" : `运行图加载失败：${response.status}`);
      return response.json() as Promise<AgentExecutionGraphProjection>;
    }).then((graph) => {
      if (cancelled) return;
      const canvas = buildConversationCanvas(graph);
      setProjection(graph);
      setFoldedDetails(canvas.foldedDetails);
      setEdges(canvas.edges);
      setNodes(arrangeConversationCanvas(canvas.nodes, canvas.edges));
      setActiveNodeId("");
      setQuotedNodeIds([]);
      quotedNodeIdsRef.current = [];
      fit();
    }).catch((cause) => { if (!cancelled) { setProjection(undefined); setEdges([]); setNodes([]); setError(cause instanceof Error ? cause.message : String(cause)); } });
    return () => { cancelled = true; };
  }, [projectId, activeSessionId, scope, refreshKey, fit, setEdges, setNodes]);

  const ancestorIds = useCallback((selectedIds: string[]) => {
    const selected = new Set(selectedIds.filter(Boolean));
    const parents = new Map<string, string[]>();
    for (const edge of edges) parents.set(edge.target, [...(parents.get(edge.target) ?? []), edge.source]);
    const queue = [...selected];
    while (queue.length) {
      const current = queue.shift()!;
      for (const parent of parents.get(current) ?? []) if (!selected.has(parent)) { selected.add(parent); queue.push(parent); }
    }
    return selected;
  }, [edges]);
  const applyFocus = useCallback((activeId: string, quotes: string[]) => {
    const focused = ancestorIds(activeId ? [activeId] : quotes);
    setNodes((current) => current.map((node) => ({ ...node, data: { ...node.data, active: node.id === activeId, quoted: quotes.includes(node.id), dimmed: focused.size > 0 && !focused.has(node.id) } })));
    setEdges((current) => current.map((edge) => ({ ...edge, style: { ...edge.style, opacity: focused.size === 0 || (focused.has(edge.source) && focused.has(edge.target)) ? 1 : 0.16 } })));
  }, [ancestorIds, setEdges, setNodes]);
  const followUp = useCallback((id: string) => { interactionModeRef.current = "follow-up"; setInteractionMode("follow-up"); setActiveNodeId(id); setQuotedNodeIds([]); quotedNodeIdsRef.current = []; applyFocus(id, []); }, [applyFocus]);
  const quote = useCallback((id: string) => {
    const current = quotedNodeIdsRef.current;
    const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
    interactionModeRef.current = "quote";
    setInteractionMode("quote");
    setActiveNodeId("");
    setQuotedNodeIds(next);
    quotedNodeIdsRef.current = next;
    applyFocus("", next);
  }, [applyFocus]);
  const clearSelection = useCallback(() => { setActiveNodeId(""); setQuotedNodeIds([]); quotedNodeIdsRef.current = []; applyFocus("", []); }, [applyFocus]);

  const turns = nodes.filter((node) => node.data.displayKind === "prompt").length;
  return (
    <section className="agent-execution-graph" aria-label="Agent 对话运行画布">
      <header className="execution-graph-head">
        <div><small>AGENT FLOW</small><b>{scope === "project" ? "项目对话全景" : "当前对话脉络"}</b><span>默认只显示研究指令与关键回答；执行细节按需查看</span></div>
        <div className="execution-graph-actions">
          <div className="execution-scope-switch"><button className={scope === "session" ? "active" : ""} disabled={!activeSessionId} onClick={() => setScope("session")}>当前对话</button><button className={scope === "project" ? "active" : ""} onClick={() => setScope("project")}>项目全景</button></div>
          <button onClick={autoArrange}>整理</button><button onClick={fit}>居中</button>
        </div>
      </header>
      <div className="execution-graph-meta">
        <span>{projection ? `${turns} 轮 · ${nodes.length} 个可见节点` : "正在读取 Agent Store…"}</span>
        <span>{foldedDetails ? `${foldedDetails} 条执行细节已折叠` : "没有额外执行细节"}</span>
        <div className="execution-interaction-switch" aria-label="节点交互方式"><button className={interactionMode === "follow-up" ? "active" : ""} onClick={() => { interactionModeRef.current = "follow-up"; setInteractionMode("follow-up"); clearSelection(); }}>沿节点继续</button><button className={interactionMode === "quote" ? "active" : ""} onClick={() => { interactionModeRef.current = "quote"; setInteractionMode("quote"); clearSelection(); }}>组合引用</button></div>
        {projection?.truncated ? <em>当前为有界投影</em> : null}
      </div>
      <div className="execution-flow">
        {error ? <div className="execution-graph-empty"><b>暂无对话脉络</b><span>{error}</span></div> : nodes.length ? <ReactFlow<ConversationNode, ConversationEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={(_event, node) => {
            interactionModeRef.current === "follow-up" ? followUp(node.id) : quote(node.id);
          }}
          onInit={(instance) => { flow.current = instance; fit(); }}
          nodesConnectable={false}
          edgesReconnectable={false}
          edgesFocusable={false}
          deleteKeyCode={null}
          minZoom={0.2}
          maxZoom={1.8}
          panOnScroll
          panOnScrollSpeed={0.85}
          zoomOnScroll={false}
          fitView
        ><Background color="#dde3e8" gap={34} size={1} /><Controls position="bottom-left" /></ReactFlow> : <div className="execution-graph-empty"><b>这段对话还没有运行节点</b><span>回到对话发送研究问题后，这里会形成可继续和引用的脉络。</span></div>}
        <ComposerBridgeBoundary fallback={<div className="execution-canvas-composer execution-canvas-composer-degraded"><div><textarea disabled placeholder="追问输入已停用：当前视图未接入会话上下文，请返回对话页提问…" /><button aria-label="从运行画布发送" disabled>↑</button></div><footer><span>返回对话页可继续追问</span><div /></footer></div>}>
          <CanvasComposerSection projectId={projectId} activeSessionId={activeSessionId} nodes={nodes} activeNodeId={activeNodeId} quotedNodeIds={quotedNodeIds} interactionMode={interactionMode} displayLabel={displayLabel} onClearSelection={clearSelection} onQuote={quote} onInspect={(sourceNode) => setInspected(sourceNode)} onReturnToChat={onReturnToChat} />
        </ComposerBridgeBoundary>
      </div>
      {inspected ? <RecordDetailModal eyebrow="AGENT JOURNAL" title={inspected.title} onClose={() => setInspected(undefined)}><div className="execution-node-detail"><p>{inspected.summary}</p><dl><div><dt>类型</dt><dd>{inspected.kind}</dd></div><div><dt>状态</dt><dd>{inspected.status ?? "recorded"}</dd></div><div><dt>时间</dt><dd>{new Date(inspected.timestamp).toLocaleString("zh-CN", { hour12: false })}</dd></div><div><dt>耗时</dt><dd>{formatDuration(inspected.metrics?.durationMs)}</dd></div><div><dt>Tokens</dt><dd>{inspected.metrics?.totalTokens?.toLocaleString() ?? "—"}</dd></div><div><dt>Run</dt><dd>{inspected.source.runId ?? "—"}</dd></div></dl></div></RecordDetailModal> : null}
    </section>
  );
}

type ComposerBridgeBoundaryState = { unavailable: boolean; rethrow?: unknown };

/** 画布追问输入依赖 assistant-ui 的 AuiProvider；三栏布局下本视图可能渲染在 Provider 外，此时降级为禁用态而不是崩溃。 */
class ComposerBridgeBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, ComposerBridgeBoundaryState> {
  state: ComposerBridgeBoundaryState = { unavailable: false };
  static getDerivedStateFromError(error: unknown): ComposerBridgeBoundaryState | null {
    if (error instanceof Error && /AuiProvider/i.test(error.message)) return { unavailable: true };
    return { unavailable: false, rethrow: error };
  }
  render() {
    if (this.state.rethrow) throw this.state.rethrow;
    return this.state.unavailable ? <div className="execution-canvas-composer execution-canvas-composer-degraded"><div><textarea disabled placeholder="追问输入已停用：当前视图未接入会话上下文，请返回对话页提问…" /><button aria-label="从运行画布发送" disabled>↑</button></div><footer><span>返回对话页可继续追问</span><div /></footer></div> : this.props.children;
  }
}

function CanvasComposerSection({ nodes, activeNodeId, quotedNodeIds, interactionMode, displayLabel, onClearSelection, onQuote, onInspect, onReturnToChat }: {
  projectId: string;
  activeSessionId?: string;
  nodes: ConversationNode[];
  activeNodeId: string;
  quotedNodeIds: string[];
  interactionMode: InteractionMode;
  displayLabel: Record<ConversationDisplayKind, string>;
  onClearSelection: () => void;
  onQuote: (id: string) => void;
  onInspect: (sourceNode: AgentExecutionNode) => void;
  onReturnToChat: (() => void) | undefined;
}) {
  const [draft, setDraft] = useState("");
  const composer = unstable_useComposerInput();
  const references = useMemo(() => {
    const ids = interactionMode === "follow-up" ? [activeNodeId].filter(Boolean) : quotedNodeIds;
    return ids.map((id) => nodes.find((node) => node.id === id)).filter((node): node is ConversationNode => Boolean(node));
  }, [nodes, activeNodeId, quotedNodeIds, interactionMode]);
  const submitFromCanvas = () => {
    if (!draft.trim() || composer.isDisabled) return;
    const context = references.length ? `\n\n参考的 Agent 节点：\n${references.map((node, index) => `${index + 1}. [${displayLabel[node.data.displayKind]}] ${node.data.summary}`).join("\n")}` : "";
    composer.setText(`${draft.trim()}${context}`);
    queueMicrotask(() => composer.send());
    setDraft("");
  };
  return (
    <div className="execution-canvas-composer">
      {references.length ? <div className="execution-reference-tray">{references.map((node) => <button key={node.id} onClick={() => interactionMode === "follow-up" ? onClearSelection() : onQuote(node.id)}><span>{displayLabel[node.data.displayKind]}</span>{node.data.summary}<i>×</i></button>)}</div> : null}
      <div><textarea value={draft} disabled={composer.isDisabled} placeholder={interactionMode === "follow-up" ? references.length ? "从这个节点继续追问…" : "选择一个节点，或直接提出下一步…" : references.length ? "综合这些节点提出问题…" : "选择多个节点作为引用…"} onChange={(event) => { setDraft(event.target.value); composer.setText(event.target.value); }} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submitFromCanvas(); } }} /><button aria-label="从运行画布发送" disabled={!draft.trim() || composer.isDisabled} onClick={submitFromCanvas}>↑</button></div>
      <footer><span>{interactionMode === "follow-up" ? "点击节点继承该路径" : "点击多个节点组合引用"}</span><div>{references.length ? <button onClick={() => onInspect(references.at(-1)!.data.sourceNode)}>查看节点详情</button> : null}{references.length ? <button onClick={onClearSelection}>清除选择</button> : null}{onReturnToChat ? <button onClick={onReturnToChat}>返回对话</button> : null}</div></footer>
    </div>
  );
}
