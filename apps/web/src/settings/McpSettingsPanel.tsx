import { useState } from "react";
import type { McpConnectionTestResult, McpServerSettings, McpSettingsResponse } from "@xiling/contracts";
import { ApiError, apiJson, jsonInit } from "../lib/api-client.js";

type Props = { value: McpSettingsResponse | undefined; onChanged: (value: McpSettingsResponse) => void; onMessage: (message: string) => void };
type Draft = {
  name: string; description: string; keywords: string; transport: "stdio" | "http"; command: string; args: string;
  url: string; authentication: "none" | "bearer" | "oauth"; bearerToken: string; access: "approval-required" | "trusted"; enabled: boolean;
};

const blankDraft = (): Draft => ({ name: "", description: "", keywords: "", transport: "http", command: "", args: "", url: "", authentication: "none", bearerToken: "", access: "approval-required", enabled: true });
const editDraft = (server: McpServerSettings): Draft => ({
  name: server.name, description: server.description, keywords: server.keywords.join(", "), transport: server.transport,
  command: server.command ?? "", args: (server.args ?? []).join("\n"), url: server.url ?? "", authentication: server.authentication,
  bearerToken: "", access: server.access, enabled: server.enabled,
});

const runtimeLabel: Record<McpServerSettings["runtimeState"], string> = {
  connected: "已连接", cached: "元数据已缓存", failed: "连接失败", "needs-auth": "等待授权", "not-connected": "惰性待连接", disabled: "已停用",
};

export function McpSettingsPanel({ value, onChanged, onMessage }: Props) {
  const [draft, setDraft] = useState<Draft>();
  const [editingName, setEditingName] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [confirmRemove, setConfirmRemove] = useState<string>();
  const [tests, setTests] = useState<Record<string, McpConnectionTestResult>>({});
  const update = <K extends keyof Draft>(key: K, next: Draft[K]) => setDraft((current) => ({ ...(current ?? blankDraft()), [key]: next }));

  const save = async () => {
    if (!draft) return;
    if (!draft.name.trim() || !draft.description.trim()) { onMessage("请填写 MCP 服务器名称和用途说明。"); return; }
    if (draft.transport === "http" && !draft.url.trim()) { onMessage("HTTP MCP 需要填写 URL。"); return; }
    if (draft.transport === "stdio" && !draft.command.trim()) { onMessage("stdio MCP 需要填写可执行命令。"); return; }
    setBusy("save");
    try {
      const body = {
        name: draft.name.trim(), description: draft.description.trim(), keywords: draft.keywords.split(/[,，\n]/u).map((item) => item.trim()).filter(Boolean),
        transport: draft.transport, authentication: draft.transport === "stdio" ? "none" : draft.authentication, access: draft.access, enabled: draft.enabled,
        ...(draft.transport === "stdio" ? { command: draft.command.trim(), args: draft.args.split("\n").map((item) => item.trim()).filter(Boolean) } : { url: draft.url.trim() }),
        ...(draft.authentication === "bearer" && draft.bearerToken.trim() ? { bearerToken: draft.bearerToken.trim() } : {}),
      };
      const next = await apiJson<McpSettingsResponse>(`/api/settings/mcp/servers/${encodeURIComponent(editingName ?? body.name)}`, jsonInit("PUT", body));
      onChanged(next); setDraft(undefined); setEditingName(undefined); onMessage(`${body.name} 已保存；MCP Host 已使用新配置重载。`);
    } catch (error) { onMessage(`MCP 保存失败：${error instanceof ApiError ? "请检查地址、命令和字段" : error instanceof Error ? error.message : "未知错误"}`); }
    finally { setBusy(undefined); }
  };

  const test = async (server: McpServerSettings) => {
    setBusy(`test:${server.name}`); onMessage(`${server.name} 正在惰性连接并读取工具目录…`);
    try {
      const result = await apiJson<McpConnectionTestResult>(`/api/settings/mcp/servers/${encodeURIComponent(server.name)}/test`, jsonInit("POST", {}));
      setTests((current) => ({ ...current, [server.name]: result }));
      onMessage(`${server.name} 连接成功，发现 ${result.toolCount} 个工具；这些 schema 没有进入 Agent 上下文。`);
      const refreshed = await apiJson<McpSettingsResponse>("/api/settings/mcp"); onChanged(refreshed);
    } catch (error) {
      const detail = error instanceof ApiError ? (error.body as { error?: string; message?: string }) : undefined;
      onMessage(`${server.name} 连接失败：${detail?.error ?? detail?.message ?? (error instanceof Error ? error.message : "未知错误")}`);
    } finally { setBusy(undefined); }
  };

  const remove = async (server: McpServerSettings) => {
    if (confirmRemove !== server.name) { setConfirmRemove(server.name); onMessage(`再次点击“确认删除”将移除 ${server.name} 配置和本地 Bearer Token。`); return; }
    setBusy(`remove:${server.name}`);
    try {
      const next = await apiJson<McpSettingsResponse>(`/api/settings/mcp/servers/${encodeURIComponent(server.name)}`, { method: "DELETE" });
      onChanged(next); setConfirmRemove(undefined); onMessage(`${server.name} 已删除。`);
    } catch { onMessage("MCP 服务器删除失败。"); }
    finally { setBusy(undefined); }
  };

  return <section className="mcp-settings">
    <div className="skills-policy mcp-policy"><div><span>⌘</span><div><b>Pi MCP 惰性网关已安装</b><p>Agent 常驻 1 个代理 schema；服务器进程、工具目录和参数 schema 只在任务命中后加载，运行在独立 Host 子进程。</p></div></div><dl><div><dt>{value?.servers.length ?? "—"}</dt><dd>已配置</dd></div><div><dt>1</dt><dd>常驻 schema</dd></div><div><dt>{value?.servers.reduce((total, server) => total + server.toolCount, 0) ?? 0}</dt><dd>缓存工具</dd></div></dl></div>
    <div className="mcp-adapter-line"><span><i />{value?.adapter.package ?? "pi-mcp-adapter"} <b>v{value?.adapter.version ?? "—"}</b></span><span>MIT · CHILD PROCESS · PROXY LAZY</span><button className="secondary" onClick={() => { setEditingName(undefined); setDraft(blankDraft()); }}>添加 MCP 服务器</button></div>
    <div className="mcp-server-list">{value?.servers.map((server) => <article key={server.name} className={!server.enabled ? "disabled" : ""}>
      <header><div><span className="mcp-server-glyph">{server.transport === "http" ? "↗" : "›_"}</span><div><h3>{server.name}</h3><p>{server.description}</p></div></div><b className={`mcp-runtime-state ${server.runtimeState}`}>{runtimeLabel[server.runtimeState]}</b></header>
      <div className="mcp-server-meta"><span>{server.transport === "http" ? server.url : `${server.command} ${(server.args ?? []).join(" ")}`}</span><span>{server.authentication === "none" ? "无鉴权" : server.authentication === "bearer" ? server.credentialConfigured ? "Bearer 已加密保存" : "Bearer 待配置" : "OAuth 按需授权"}</span><span>{server.access === "trusted" ? "已显式信任工具调用" : "工具调用需审批"}</span></div>
      <div className="mcp-keywords">{server.keywords.map((keyword) => <span key={keyword}>{keyword}</span>)}</div>
      {tests[server.name] ? <div className="mcp-test-result"><b>{tests[server.name]!.ok ? "连接正常" : "连接失败"}</b><span>{tests[server.name]!.toolCount} tools · {tests[server.name]!.latencyMs} ms</span></div> : null}
      <footer><span>{server.toolCount} tools · {server.resourceCount} resources</span><div><button className="secondary" disabled={!server.enabled || Boolean(busy)} onClick={() => void test(server)}>{busy === `test:${server.name}` ? "测试中…" : "测试连接"}</button><button className="secondary" disabled={Boolean(busy)} onClick={() => { setEditingName(server.name); setDraft(editDraft(server)); }}>编辑</button><button className="clear" disabled={Boolean(busy)} onClick={() => void remove(server)}>{confirmRemove === server.name ? "确认删除" : "删除"}</button></div></footer>
    </article>)}</div>
    {!value?.servers.length ? <div className="skills-empty">尚未配置 MCP 服务器。添加后仍不会自动连接，也不会把工具 schema 塞入模型上下文。</div> : null}
    {draft ? <div className="mcp-editor"><header><div><small>MCP SERVER</small><h2>{editingName ? `编辑 ${editingName}` : "添加 MCP 服务器"}</h2></div><button className="secondary" onClick={() => { setDraft(undefined); setEditingName(undefined); }}>关闭</button></header><div className="mcp-form-grid">
      <label><span>唯一名称</span><input value={draft.name} disabled={Boolean(editingName)} placeholder="ocean-catalog" onChange={(event) => update("name", event.target.value)} /></label>
      <label><span>传输方式</span><select value={draft.transport} onChange={(event) => update("transport", event.target.value as Draft["transport"])}><option value="http">Streamable HTTP / SSE</option><option value="stdio">stdio（在本机受控 Host 中执行）</option></select></label>
      <label className="wide"><span>用途说明</span><input value={draft.description} placeholder="用于检索实验室数据目录" onChange={(event) => update("description", event.target.value)} /></label>
      <label className="wide"><span>任务匹配词 <em>仅宿主使用，不进入提示</em></span><input value={draft.keywords} placeholder="数据目录, lab catalog, cruises" onChange={(event) => update("keywords", event.target.value)} /></label>
      {draft.transport === "http" ? <><label className="wide"><span>MCP URL</span><input value={draft.url} placeholder="https://mcp.example.org/mcp" onChange={(event) => update("url", event.target.value)} /></label><label><span>鉴权</span><select value={draft.authentication} onChange={(event) => update("authentication", event.target.value as Draft["authentication"])}><option value="none">无鉴权</option><option value="bearer">Bearer Token</option><option value="oauth">OAuth 2.1</option></select></label>{draft.authentication === "bearer" ? <label><span>Bearer Token</span><input type="password" value={draft.bearerToken} placeholder="留空则保持现有密钥" onChange={(event) => update("bearerToken", event.target.value)} /></label> : null}</> : <><label><span>可执行命令</span><input value={draft.command} placeholder="node 或绝对路径" onChange={(event) => update("command", event.target.value)} /></label><label><span>参数 <em>每行一个</em></span><textarea value={draft.args} placeholder={'server.mjs\n--readonly'} onChange={(event) => update("args", event.target.value)} /></label></>}
    </div><div className="mcp-permission"><label><input type="checkbox" checked={draft.enabled} onChange={(event) => update("enabled", event.target.checked)} /><span><b>启用服务器</b><small>启用也不会在启动时连接；只允许任务命中后惰性连接。</small></span></label><label className="danger"><input type="checkbox" checked={draft.access === "trusted"} onChange={(event) => update("access", event.target.checked ? "trusted" : "approval-required")} /><span><b>信任此服务器的工具调用</b><small>关闭时 Agent 只能发现与测试连接，实际调用会被 adapter 硬性阻止并要求审批。</small></span></label></div><footer><button className="secondary" onClick={() => { setDraft(undefined); setEditingName(undefined); }}>取消</button><button disabled={busy === "save"} onClick={() => void save()}>{busy === "save" ? "保存中…" : "保存并重载 Host"}</button></footer></div> : null}
    <p className="skills-footnote">MCP 配置由汐灵宿主持久化；Bearer Token 使用现有 AES-256-GCM 凭据库。不会自动扫描或导入 Cursor、Claude、Codex 等宿主配置，避免无意启动未知命令。</p>
  </section>;
}
