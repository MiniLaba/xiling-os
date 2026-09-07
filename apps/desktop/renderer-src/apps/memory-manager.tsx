import { useEffect, useState } from "react";

export function MemoryManager() {
  const [agents, setAgents] = useState<Array<{ agentId: string; name: string }>>([]);
  const [id, setId] = useState("");
  const [records, setRecords] = useState<Array<{ id: string; content: unknown; createdAt: string; provenance: unknown }>>([]);
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const bridge = window.xilingDesktop;
  useEffect(() => { let live = true; void bridge?.models.list().then((result) => { if (live) { setAgents(result.agents); setId(result.agents[0]?.agentId ?? ""); } }).catch((error: unknown) => { if (live) setError(String(error)); }); return () => { live = false; }; }, [bridge]);
  useEffect(() => { let live = true; setRecords([]); if (id) void bridge?.manageMemories({ action: "list", agentId: id }).then((result) => { if (live) setRecords(result.records); }).catch((error: unknown) => { if (live) setError(String(error)); }); return () => { live = false; }; }, [bridge, id]);
  const manage = async (action: string, recordId?: string) => {
    if (!bridge || busy) return; setBusy(true); setError("");
    try { const result = await bridge.manageMemories({ action, agentId: id, content, id: recordId }); setRecords(result.records); setContent(""); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); }
  };
  return <section className="credential-settings"><h3>可审阅记忆</h3><p>仅将明确选定的信息长期保存。每个 Agent 独立检索；不会把完整聊天自动写入全局记忆。</p>
    <label>所属 Agent<select value={id} disabled={busy} onChange={(event) => setId(event.target.value)}>{agents.map((agent) => <option key={agent.agentId} value={agent.agentId}>{agent.name}</option>)}</select></label>
    {error && <p role="alert">{error}</p>}
    <label>希望长期记住的内容<textarea rows={2} maxLength={6000} value={content} onChange={(event) => setContent(event.target.value)} /></label><button disabled={!id || !content.trim() || busy} onClick={() => void manage("write")}>明确保存</button>
    {records.map((record) => <article key={record.id}><p>{typeof record.content === "string" ? record.content : JSON.stringify(record.content)}</p><small>{new Date(record.createdAt).toLocaleString()}</small><details><summary>来源</summary><pre>{JSON.stringify(record.provenance, null, 2)}</pre></details><button disabled={busy} onClick={() => void manage("delete", record.id)}>删除记忆</button></article>)}
  </section>;
}
