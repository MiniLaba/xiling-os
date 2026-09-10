import { useEffect, useState } from "react";
import type { AppInstance } from "@xiling/os-domain";

type Command = (payload: Record<string, unknown>) => Promise<unknown>;
interface Props { command: Command }
interface Opened { app: AppInstance; session: { id: string }; sessions?: Array<{ id: string; title?: string; startedAt: string }> }

/** Native trusted UI only: App instructions are text, never executable renderer code. */
export function AgentApps({ command }: Props) {
  const [apps, setApps] = useState<AppInstance[]>([]);
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [allowArtifacts, setAllowArtifacts] = useState(true);
  const [allowDelegation, setAllowDelegation] = useState(false);
  const [allowQuestions, setAllowQuestions] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [opened, setOpened] = useState<Opened>();
  const [notice, setNotice] = useState("");
  const refresh = async () => setApps(((await command({ action: "list" })) as { apps: AppInstance[] }).apps);
  useEffect(() => { void refresh().catch((error: unknown) => setError(String(error))); }, [command]);
  const perform = async (work: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await work(); await refresh(); } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return <section className="credential-settings agent-app-manager" aria-label="Agent 应用管理">
    <h3>我的 Agent 应用</h3>
    <p>每个应用保留独立身份与会话。支持文本、受限产物交付与已授权的 App 协作。安装后请为它选择模型。</p>
    {error && <p role="alert">{error}</p>}
    <form onSubmit={(event) => { event.preventDefault(); void perform(async () => {
      const actions = [...(allowArtifacts ? ["artifact.create", "artifact.read"] : []), ...(allowDelegation ? ["task.delegate"] : []), ...(allowQuestions ? ["ui.present"] : [])];
      await command({ action: "install", approvedActions: actions, manifest: {
        id: `local.${crypto.randomUUID()}`, version: "1.0.0", name: name.trim(), description: name.trim(),
        runtimeName: "pi-research", instructions: instructions.trim(), capabilities: [], requestedActions: actions,
        defaultModel: {}, ui: { kind: "agent-chat" },
      } }); setName(""); setInstructions("");
    }); }}>
      <label>应用名称<input value={name} maxLength={80} required onChange={(event) => setName(event.target.value)} /></label>
      <label>默认工作说明<textarea value={instructions} rows={3} maxLength={6000} required onChange={(event) => setInstructions(event.target.value)} /></label>
      <label><input type="checkbox" checked={allowArtifacts} onChange={(event) => setAllowArtifacts(event.target.checked)} />允许创建内部产物、读取显式提供的产物</label>
      <label><input type="checkbox" checked={allowDelegation} onChange={(event) => setAllowDelegation(event.target.checked)} />允许委托已安装的 App（可能增加模型用量）</label>
      <label><input type="checkbox" checked={allowQuestions} onChange={(event) => setAllowQuestions(event.target.checked)} />允许通过可信表单向你追问</label>
      <p>不申请任意本机文件、网络工具或代码执行权限。已有应用不会自动增加权限。</p>
      <button type="submit" disabled={busy || !name.trim() || !instructions.trim()}>创建个人应用</button>
    </form>
    {apps.length === 0 && <p>还没有安装个人应用。</p>}
    <ul>{apps.map((app) => <li key={app.id}>
      <strong>{app.package.name}</strong> <span>{app.package.version} · {app.state === "enabled" ? "已启用" : "已停用"}</span>
      <button disabled={busy || app.state !== "enabled"} onClick={() => void perform(async () => {
        const opened = await command({ action: "open", id: app.id }) as Opened;
        setOpened(opened); setNotice("");
        window.dispatchEvent(new CustomEvent("xiling:open-agent-app", { detail: { instanceId: app.id, sessionId: opened.session.id, title: app.package.name } }));
      })}>打开新会话</button>
      <button disabled={busy} onClick={() => void perform(async () => {
        await command({ action: app.state === "enabled" ? "disable" : "enable", id: app.id });
        if (opened?.app.id === app.id) setOpened(undefined);
      })}>{app.state === "enabled" ? "停用" : "启用"}</button>
      {app.state === "disabled" && <button disabled={busy} onClick={() => void perform(async () => { await command({ action: "remove", id: app.id }); })}>卸载（保留数据）</button>}
    </li>)}</ul>
    {opened && <section aria-label={`${opened.app.package.name} 独立会话`}>
      <h4>{opened.app.package.name}</h4>
      <button disabled={busy} onClick={() => window.dispatchEvent(new CustomEvent("xiling:open-agent-app", { detail: { instanceId: opened.app.id, sessionId: opened.session.id, title: opened.app.package.name } }))}>在独立窗口打开当前会话</button>
      <label>工作会话<select value={opened.session.id} disabled={busy} onChange={(event) => { const sessionId = event.target.value; void perform(async () => { setOpened(await command({ action: "open", id: opened.app.id, sessionId }) as Opened); setNotice(""); }); }}>{opened.sessions?.map((session) => <option key={session.id} value={session.id}>{session.title || "会话"} · {new Date(session.startedAt).toLocaleString()}</option>)}</select></label>
      <p>选择会话后在独立窗口中继续工作。任务与结果也可在任务中心查看。</p>
      <p role="status">{notice}</p>
    </section>}
  </section>;
}
