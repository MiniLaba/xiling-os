import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ModelRuntimeStatus } from "@xiling/contracts";
import { apiJson, jsonInit } from "../lib/api-client.js";
import { runResearchTurn } from "../lib/research-session-client.js";
import { proposeRoutine, routineWhen, visibleReply, type RoutineProposal } from "./routine-proposal.js";

type Target = "local" | "ssh" | "vm";

interface VmDesktop {
  status: "stopped" | "starting" | "ready" | "unavailable";
  message: string;
  embedUrl?: string;
}

interface BotEntry {
  id: string;
  kind: "user" | "assistant" | "tool-call" | "tool-result";
  text: string;
}

interface Routine {
  id: string;
  instruction: string;
  schedule: "hourly" | "daily" | "weekdays" | "once";
  hour: number;
  minute: number;
  enabled: boolean;
  runOn?: string;
}

const targetLabel: Record<Target, string> = { local: "本机", ssh: "远程 SSH", vm: "虚拟机" };
const toolLabel: Record<string, string> = {
  computer_browse: "打开网页",
  computer_download: "下载到桌面",
  computer_shell: "运行命令",
  computer_read: "读取文件",
  computer_write: "写入文件",
};

function explainHandoffFailure(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (text.includes("selection_required")) return "还没有选定模型，任务没有开始。请先到 Chat 输入框左侧选择模型并保存 API Key，然后再交办。";
  if (text.includes("credential_required")) return "模型还没有可用的 API Key。请先到 Chat 输入框左侧保存连接，然后再交办。";
  if (text.includes("automatic_model_unavailable")) return "自动选模没有可用模型。请到设置里指定已配置的提供商，或放宽费用上限。";
  if (text.includes("configured tools are unavailable")) return "这一轮的工具没有接上，任务没有发出去。请再交办一次。";
  return text;
}

function embeddableDesktop(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function settledByComputer(prompt: string): string {
  const scheduled = proposeRoutine(prompt, "");
  if (scheduled) return `等到${routineWhen(scheduled)}再执行…`;
  if (/下载/u.test(prompt) && /桌面|虚拟机|论文|pdf|文件/iu.test(prompt)) return "正在下载到桌面…";
  if (/打开|访问|浏览/u.test(prompt) && (/官网|网站|网页|首页|浏览器|网址|页面/u.test(prompt) || /https?:\/\//iu.test(prompt))) return "正在打开…";
  if (/有哪些文件|哪些文件|哪些文件夹|文件或文件夹|列出|目录下|目录里/u.test(prompt) && /\/[\w.-]+/u.test(prompt)) return "正在查看目录…";
  return "";
}

function stepText(entry: BotEntry): string {
  if (entry.kind === "tool-call") return toolLabel[entry.text] ?? entry.text;
  const compact = entry.text.replace(/\s+/gu, " ").trim();
  return compact.length > 180 ? `${compact.slice(0, 180)}…` : compact;
}

export function BotView({ projectId }: { projectId: string }) {
  const [target, setTarget] = useState<Target>("vm");
  const [savedTarget, setSavedTarget] = useState<Target | null>(null);
  const [sshHost, setSshHost] = useState("");
  const [status, setStatus] = useState("");
  const [desktop, setDesktop] = useState<VmDesktop>({ status: "stopped", message: "正在连接虚拟机" });
  const [desktopHold, setDesktopHold] = useState(false);
  const [task, setTask] = useState("");
  const [handoff, setHandoff] = useState("");
  const [busy, setBusy] = useState(false);
  const [entries, setEntries] = useState<BotEntry[]>([]);
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [proposal, setProposal] = useState<RoutineProposal | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const loadConversation = async () => {
    const body = await apiJson<{ sessionId: string | null; entries: BotEntry[] }>(`/api/v1/bot/conversation?projectId=${encodeURIComponent(projectId)}`);
    setEntries(body.entries);
    return body;
  };

  useEffect(() => {
    void loadConversation().catch(() => setEntries([]));
    void apiJson<Routine[]>(`/api/v1/bot/routines?projectId=${encodeURIComponent(projectId)}`).then(setRoutines).catch(() => setRoutines([]));
    void apiJson<{ runtime: ModelRuntimeStatus }>("/api/settings/models").then((body) => {
      const saved = body.runtime.execution?.target ?? "vm";
      setTarget(saved);
      setSavedTarget(saved);
      if (body.runtime.execution?.sshHost) setSshHost(body.runtime.execution.sshHost);
    }).catch(() => undefined);
  }, [projectId]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [entries, proposal, busy]);

  useEffect(() => {
    if (savedTarget !== "vm" || desktopHold) return;
    let stopped = false;
    const refresh = async () => {
      const body = await apiJson<VmDesktop>("/api/v1/bot/desktop");
      if (!stopped) setDesktop(body);
      return body;
    };
    void refresh().then((body) => {
      if (stopped || body.status === "ready" || body.status === "starting") return;
      return apiJson<VmDesktop>("/api/v1/bot/desktop", jsonInit("POST")).then((next) => { if (!stopped) setDesktop(next); });
    }).catch(() => { if (!stopped) setDesktop({ status: "unavailable", message: "虚拟机暂时无法连接" }); });
    const timer = window.setInterval(() => { void refresh().catch(() => undefined); }, 2000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [savedTarget, desktopHold]);

  const saveTarget = async () => {
    const runtime = await apiJson<ModelRuntimeStatus>("/api/settings/workspace", jsonInit("PUT", { execution: { target, ...(sshHost.trim() ? { sshHost: sshHost.trim() } : {}) } }));
    const saved = runtime.execution?.target ?? target;
    setSavedTarget(saved);
    if (saved === "vm") setDesktopHold(false);
    setStatus(`执行目标已设为${targetLabel[saved]}。交办后会自己做完。`);
  };

  const assignTask = async (event: FormEvent) => {
    event.preventDefault();
    const prompt = task.trim();
    if (!prompt || busy) return;
    if (savedTarget !== target) { setHandoff("先保存执行目标，任务才会交到这台电脑。"); return; }
    if (target === "ssh" && !sshHost.trim()) { setHandoff("远程 SSH 需要先填写主机并保存。"); return; }
    setBusy(true);
    setProposal(null);
    setHandoff("");
    const userId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    const placeholder = settledByComputer(prompt);
    setEntries((current) => [...current, { id: userId, kind: "user", text: prompt }, { id: assistantId, kind: "assistant", text: placeholder }]);
    setTask("");
    try {
      const models = await apiJson<{ runtime: { ready: boolean; reason: string } }>("/api/settings/models");
      if (!models.runtime.ready) throw new Error(models.runtime.reason);
      const conversation = await apiJson<{ sessionId: string }>("/api/v1/bot/conversation", jsonInit("POST", { projectId }));
      let text = "";
      for await (const item of runResearchTurn({ projectId, sessionId: conversation.sessionId, prompt })) {
        if (item.type === "message.delta" && item.delta && !placeholder) {
          text += item.delta;
          const next = text;
          setEntries((current) => current.map((entry) => entry.id === assistantId ? { ...entry, text: next } : entry));
        }
        if (item.type === "entry.persisted" && item.kind === "assistant" && item.text) {
          text = item.text;
          setEntries((current) => current.map((entry) => entry.id === assistantId ? { ...entry, text } : entry));
        }
        if (item.type === "tool.started") {
          const callId = item.callId;
          const name = item.toolName;
          setEntries((current) => {
            if (current.some((entry) => entry.id === callId)) return current;
            const assistant = current.at(-1);
            const step: BotEntry = { id: callId, kind: "tool-call", text: name };
            if (assistant?.id !== assistantId) return [...current, step];
            return [...current.slice(0, -1), step, assistant];
          });
        }
        if (item.type === "session.error") throw new Error(item.message || "交办失败");
      }
      const saved = await loadConversation();
      const lastAssistant = [...saved.entries].reverse().find((entry) => entry.kind === "assistant");
      const suggested = proposeRoutine(prompt, lastAssistant?.text ?? text);
      setProposal(suggested);
    } catch (error) {
      setHandoff(explainHandoffFailure(error));
      setEntries((current) => current.map((entry) => entry.id === assistantId && (!entry.text || entry.text === placeholder) ? { ...entry, text: explainHandoffFailure(error) } : entry));
    } finally { setBusy(false); }
  };

  const acceptRoutine = async () => {
    if (!proposal) return;
    const created = await apiJson<Routine>("/api/v1/bot/routines", jsonInit("POST", { projectId, instruction: proposal.instruction, schedule: proposal.schedule, hour: proposal.hour, minute: proposal.minute, ...(proposal.runOn ? { runOn: proposal.runOn } : {}) }));
    setRoutines((current) => [...current, created]);
    setProposal(null);
    setHandoff(`已加入定时任务：${routineWhen(created)}`);
  };

  const deleteRoutine = async (id: string) => {
    await apiJson(`/api/v1/bot/routines/${id}`, jsonInit("DELETE"));
    setRoutines((current) => current.filter((routine) => routine.id !== id));
  };

  const showDesktop = savedTarget === "vm";

  return (
    <div className="bot-view">
      <header className="bot-head">
        <div>
          <small>BOT</small>
          <h1>交办</h1>
        </div>
        <form onSubmit={(event) => { event.preventDefault(); void saveTarget(); }}>
          <label>执行目标
            <select value={target} onChange={(event) => setTarget(event.target.value as Target)}>
              <option value="local">本机</option>
              <option value="ssh">远程 SSH</option>
              <option value="vm">虚拟机</option>
            </select>
          </label>
          {target === "ssh" ? <input value={sshHost} placeholder="user@host" aria-label="SSH 主机" onChange={(event) => setSshHost(event.target.value)} /> : null}
          <button type="submit">保存</button>
        </form>
      </header>
      {status ? <p className="bot-status">{status}</p> : null}
      <div className={showDesktop ? "bot-stage" : "bot-stage bot-stage-single"}>
        <section className="bot-thread" aria-label="交办对话">
          <div className="bot-log" ref={logRef}>
            {entries.length ? entries.map((entry) => {
              if (entry.kind === "tool-call" || entry.kind === "tool-result") return <p className="bot-step" key={entry.id}>{stepText(entry)}</p>;
              const text = entry.kind === "assistant" ? visibleReply(entry.text) : entry.text;
              if (!text && entry.kind === "assistant") return <p className="bot-bubble assistant" key={entry.id}>{busy ? "正在执行…" : ""}</p>;
              return <p className={`bot-bubble ${entry.kind === "user" ? "user" : "assistant"}`} key={entry.id}>{text}</p>;
            }) : <p className="bot-empty">在下面交代任务。执行过程会留在这里，不会写进 Chat。</p>}
            {proposal ? (
              <div className="bot-ask">
                <p>定时任务 <b>{routineWhen(proposal)}</b> · {proposal.instruction}</p>
                <button type="button" onClick={() => void acceptRoutine()}>加入</button>
                <button type="button" onClick={() => setProposal(null)}>先不加入</button>
              </div>
            ) : null}
          </div>
          <form className="bot-assign" onSubmit={(event) => void assignTask(event)}>
            <textarea id="bot-task" value={task} placeholder="交代要在这台电脑上完成的任务" aria-label="交办任务" onChange={(event) => setTask(event.target.value)} />
            <button type="submit" disabled={busy}>{busy ? "交办中" : "交办"}</button>
          </form>
          {handoff ? <p className="bot-handoff">{handoff}</p> : null}
        </section>
        {showDesktop ? (
          <section className="bot-vm" aria-label="虚拟机">
            <header>
              <strong>虚拟机</strong>
              <span>{desktop.message}</span>
              <button type="button" onClick={() => { setDesktopHold(false); void apiJson<VmDesktop>("/api/v1/bot/desktop", jsonInit("POST")).then(setDesktop).catch(() => setDesktop({ status: "unavailable", message: "虚拟机暂时无法连接" })); }}>重新打开</button>
              {desktop.status !== "stopped" ? <button type="button" onClick={() => { setDesktopHold(true); void apiJson<VmDesktop>("/api/v1/bot/desktop", jsonInit("DELETE")).then(setDesktop).catch(() => undefined); }}>关闭</button> : null}
            </header>
            <div className="bot-vm-screen">
              {desktop.status === "ready" && embeddableDesktop(desktop.embedUrl)
                ? <iframe title="虚拟机" src={embeddableDesktop(desktop.embedUrl)} referrerPolicy="no-referrer" allow="autoplay; clipboard-read; clipboard-write; fullscreen; pointer-lock" />
                : <p>{desktop.message}</p>}
            </div>
          </section>
        ) : null}
      </div>
      <section className="bot-routines" aria-label="定时任务列表">
        <h2>定时任务</h2>
        {routines.length ? <ul>{routines.map((routine) => (
          <li key={routine.id}>
            <b>{routineWhen(routine)}{routine.enabled ? "" : " · 已执行"}</b>
            <span>{routine.instruction}</span>
            <button type="button" onClick={() => void deleteRoutine(routine.id)}>删除</button>
          </li>
        ))}</ul> : <p>还没有定时任务。交办里如果被判断成定时任务，会先问你要不要加入。</p>}
      </section>
    </div>
  );
}
