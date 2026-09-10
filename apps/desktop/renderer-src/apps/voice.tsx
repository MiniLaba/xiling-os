import { useEffect, useRef, useState } from "react";
import type { VoiceStatus, VoiceSettings as Settings } from "../../src/core/voice-types.js";
import { selectedSession, selectSession } from "./session-selection.js";

let owner: symbol | undefined;
let playback: HTMLAudioElement | undefined;
let playbackOwner: symbol | undefined;
let audioURL: string | undefined;
let analyserContext: AudioContext | undefined;
let animation = 0;
export function stopVoice() {
  playback?.pause(); playback = undefined; playbackOwner = undefined;
  if (audioURL) URL.revokeObjectURL(audioURL); audioURL = undefined;
  cancelAnimationFrame(animation); void analyserContext?.close(); analyserContext = undefined;
  window.dispatchEvent(new CustomEvent("xiling:voice-mouth", { detail: 0 }));
}
export async function playVoice(base64: string, sourceOwner?: symbol, onFinished?: () => void) {
  stopVoice(); playbackOwner = sourceOwner;
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  audioURL = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
  playback = new Audio(audioURL);
  analyserContext = new AudioContext();
  const source = analyserContext.createMediaElementSource(playback), analyser = analyserContext.createAnalyser();
  analyser.fftSize = 256; source.connect(analyser); analyser.connect(analyserContext.destination);
  const data = new Uint8Array(256);
  const update = () => { analyser.getByteTimeDomainData(data); const rms = Math.sqrt(data.reduce((sum, sample) => sum + ((sample - 128) / 128) ** 2, 0) / data.length); window.dispatchEvent(new CustomEvent("xiling:voice-mouth", { detail: Math.min(1, rms * 5) })); animation = requestAnimationFrame(update); };
  playback.onended = () => { stopVoice(); onFinished?.(); };
  try { await analyserContext.resume(); await playback.play(); update(); } catch (error) { stopVoice(); throw error; }
}
async function wavOf(blob: Blob) {
  const context = new AudioContext();
  try {
    const audio = await context.decodeAudioData(await blob.arrayBuffer());
    if (audio.duration > 65) throw new Error("一次录音最多 60 秒");
    const offline = new OfflineAudioContext(1, Math.ceil(audio.duration * 24000), 24000);
    const source = offline.createBufferSource(); source.buffer = audio; source.connect(offline.destination); source.start();
    const pcm = await offline.startRendering();
    const samples = pcm.getChannelData(0), buffer = new ArrayBuffer(44 + samples.length * 2), view = new DataView(buffer);
    const text = (offset: number, value: string) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
    text(0, "RIFF"); view.setUint32(4, buffer.byteLength - 8, true); text(8, "WAVEfmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 24000, true); view.setUint32(28, 48000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, samples.length * 2, true);
    samples.forEach((sample, index) => view.setInt16(44 + index * 2, Math.max(-1, Math.min(1, sample)) * 32767, true));
    let binary = ""; const bytes = new Uint8Array(buffer); for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192)); return btoa(binary);
  } finally { await context.close(); }
}

export function VoiceControls({ onText, response = "" }: { onText: (text: string) => void; response?: string }) {
  const [status, setStatus] = useState<VoiceStatus>();
  const [mode, setMode] = useState<"native" | "stt">("native");
  const [state, setState] = useState("待命"), [error, setError] = useState("");
  const [muted, setMuted] = useState(false);
  const recorder = useRef<MediaRecorder | undefined>(undefined);
  const release = useRef<() => void>(() => {});
  const token = useRef(Symbol("voice")), generation = useRef(0), nativeTask = useRef<string | undefined>(undefined);
  const mutedRef = useRef(false), requestId = useRef<string | undefined>(undefined);
  const subscription = useRef<() => void>(() => {});
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    const refresh = () => { void window.xilingDesktop?.voice({ action: "status" }).then((result) => { if (live.current) setStatus(result.status); }).catch((reason) => { if (live.current) setError(String(reason)); }); };
    const sessionChanged = () => { generation.current++; release.current(); subscription.current(); if (owner === token.current) owner = undefined; stopVoice(); setState("待命"); };
    window.addEventListener("xiling:main-session-change", sessionChanged);
    refresh(); window.addEventListener("xiling:voice-settings", refresh);
    return () => { live.current = false; generation.current++; release.current(); subscription.current(); if (requestId.current) void window.xilingDesktop?.voice({ action: "cancel", requestId: requestId.current }); if (owner === token.current) owner = undefined; if (playbackOwner === token.current) stopVoice(); window.removeEventListener("xiling:voice-settings", refresh); window.removeEventListener("xiling:main-session-change", sessionChanged); };
  }, []);
  async function start() {
    if (owner) { setError("另一个语音入口正在使用麦克风或处理录音"); return; }
    owner = token.current; const gen = ++generation.current; setError(""); stopVoice();
    let stream: MediaStream | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      if (!live.current || gen !== generation.current) { stream.getTracks().forEach((track) => track.stop()); return; }
      const chunks: Blob[] = [], record = new MediaRecorder(stream); recorder.current = record;
      const timer = setTimeout(() => { if (record.state === "recording") record.stop(); }, 60000);
      release.current = () => { clearTimeout(timer); if (record.state === "recording") record.stop(); stream!.getTracks().forEach((track) => track.stop()); };
      record.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      record.onstop = () => { release.current(); void finish(new Blob(chunks, { type: record.mimeType }), gen); };
      record.start(); setState("正在听 · 停止后发送");
    } catch (reason) { stream?.getTracks().forEach((track) => track.stop()); owner = undefined; setState("待命"); setError(String(reason)); }
  }
  async function finish(blob: Blob, gen: number) {
    if (gen !== generation.current || !live.current) return;
    try {
      setState(mode === "stt" ? "正在识别" : "正在思考");
      const audio = await wavOf(blob);
      const session = selectedSession();
      requestId.current = crypto.randomUUID();
      if (gen !== generation.current || !live.current) return;
      const result = await window.xilingDesktop!.voice({ action: mode === "stt" ? "transcribe" : "submit", audio, sessionId: session, requestId: requestId.current });
      if (!live.current || gen !== generation.current) { if (result.taskId) await window.xilingDesktop!.tasks.cancel(result.taskId); return; }
      if (mode === "stt") { onText(result.text ?? ""); setState("已识别 · 确认文字后发送"); return; }
      nativeTask.current = result.taskId;
      if (result.sessionId !== selectedSession()) selectSession(result.sessionId);
      setState("正在思考");
      const taskGeneration = generation.current;
      let checking = false, done = false, dirty = false;
      const check = async () => {
        if (done) return true;
        if (checking) { dirty = true; return false; }
        checking = true;
        try {
        dirty = false;
        const snapshot = await window.xilingDesktop!.getOsSnapshot();
        const task = snapshot.tasks.find((item) => item.id === result.taskId);
        if (!live.current || taskGeneration !== generation.current) return true;
        if (task?.state === "completed") {
          done = true;
          const artifact = snapshot.artifacts.find((item) => item.taskId === task.id && item.mimeType === "audio/wav");
          if (artifact && !mutedRef.current) { const reply = await window.xilingDesktop!.voice({ action: "audio", id: artifact.artifactId }); if (taskGeneration === generation.current && !mutedRef.current && reply.audio) await playVoice(reply.audio, token.current); }
          setState("回复已就绪"); return true;
        }
        if (task && (task.state.startsWith("waiting_") || ["failed", "cancelled"].includes(task.state))) { setState(task.statusReason ?? "请在任务界面继续"); return true; }
        return false;
        } finally { checking = false; if (dirty && !done && live.current && taskGeneration === generation.current) void check().then((finished) => { if (finished) subscription.current(); }).catch((error) => { subscription.current(); setError(String(error)); }); }
      };
      // Event driven with a completion catch-up; no background polling loop.
      const unsub = window.xilingDesktop!.tasks.onChanged(() => { void check().then((done) => { if (done) unsub(); }).catch((error) => { unsub(); if (live.current) setError(String(error)); }); });
      subscription.current = unsub;
      if (await check()) unsub();
    } catch (reason) { if (live.current && gen === generation.current) { setState("待命"); setError(String(reason)); } }
    finally { if (owner === token.current) owner = undefined; }
  }
  async function speakResponse() {
    if (owner) { setError("另一个语音入口正在工作"); return; }
    owner = token.current; const gen = ++generation.current; requestId.current = crypto.randomUUID();
    setState("正在合成"); setError("");
    try {
      const result = await window.xilingDesktop!.voice({ action: "speak", text: response.slice(0,4096), requestId: requestId.current });
      if (live.current && gen === generation.current && !mutedRef.current && result.audio) { await playVoice(result.audio, token.current, () => { if (live.current && gen === generation.current) setState("朗读结束"); }); setState("正在朗读"); }
    } catch (reason) { if (live.current && gen === generation.current) { setError(String(reason)); setState("待命"); } }
    finally { if (owner === token.current) owner = undefined; }
  }
  const stop = () => {
    generation.current++; release.current(); subscription.current();
    if (requestId.current) void window.xilingDesktop?.voice({ action: "cancel", requestId: requestId.current }).catch(() => {});
    if (owner === token.current) owner = undefined; stopVoice();
    if (nativeTask.current) void window.xilingDesktop!.tasks.cancel(nativeTask.current).catch(() => {});
    nativeTask.current = undefined; setState("已停止");
  };
  return <details className="voice-controls">
    <summary>语音对话 <small aria-live="polite">{state}</small></summary>
    <div><select aria-label="语音通路" value={mode} disabled={state.startsWith("正在")} onChange={(event) => setMode(event.target.value as "native" | "stt")}>
      <option value="native">原生音频对话</option><option value="stt">独立语音识别 → 文字任务</option>
    </select><button type="button" disabled={!status?.ready[mode] || ["正在思考","正在识别","正在合成"].includes(state)} onClick={() => recorder.current?.state === "recording" ? recorder.current.stop() : void start()}>{state.startsWith("正在听") ? "停止并发送" : "点击说话"}</button></div>
    {!status?.ready[mode] && <p>先在设置 → 语音与对话中配置并测试此通路。</p>}
    <div><button type="button" onClick={stop}>打断／停止</button>
      <button type="button" onClick={() => { if (playback?.paused) void playback.play().catch((error) => setError(String(error))); else playback?.pause(); }}>暂停／继续播放</button>
      <label><input type="checkbox" checked={muted} onChange={(event) => { mutedRef.current = event.target.checked; setMuted(event.target.checked); if (event.target.checked) stopVoice(); }} />静音</label>
      <button type="button" disabled={!status?.ready.tts || !response || muted || state.startsWith("正在")} onClick={() => void speakResponse()}>独立 TTS 朗读回复</button>
    </div><small>AI 生成声音。最长录音 60 秒。原生录音保存在本机会话产物；停止并发送会上传至所选服务。独立朗读最多前 4096 字符。</small>
    {error && <p role="alert">{error}</p>}
  </details>;
}

export function VoiceSettings() {
  const [status, setStatus] = useState<VoiceStatus>(), [settings, setSettings] = useState<Settings>();
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  useEffect(() => { void window.xilingDesktop?.voice({ action: "status" }).then((result) => { setStatus(result.status); setSettings(result.status?.settings); }).catch((error) => setMessage(String(error))); }, []);
  if (!settings) return <p>{message || "正在加载语音设置…"}</p>;
  return <section className="credential-settings"><h3>语音与对话</h3><p>两种通路独立配置，不自动替代。密钥复用“模型与连接”中 OpenAI／自定义兼容 API 的配置。测试会发送固定测试音频或文字并可能计费，不使用麦克风。</p>{(["native", "stt", "tts"] as const).map((kind) => <fieldset key={kind} disabled={busy}><legend>{{ native: "原生音频输入 + 音频回复", stt: "独立语音识别", tts: "独立语音合成" }[kind]} · {status?.ready[kind] && JSON.stringify(settings[kind]) === JSON.stringify(status.settings[kind]) ? "已验证" : "待测试"}</legend><label>服务<select value={settings[kind].provider} onChange={(event) => setSettings({ ...settings, [kind]: { ...settings[kind], provider: event.target.value as "openai" | "custom" } })}><option value="openai">OpenAI</option><option value="custom">自定义 OpenAI 兼容服务</option></select></label><label>模型名称<input value={settings[kind].model} onChange={(event) => setSettings({ ...settings, [kind]: { ...settings[kind], model: event.target.value } })} /></label>{kind !== "stt" && <label>音色<input value={settings[kind].voice} onChange={(event) => setSettings({ ...settings, [kind]: { ...settings[kind], voice: event.target.value } })} /></label>}<button onClick={() => { setBusy(true); setMessage(""); void window.xilingDesktop!.voice({ action: "save", settings }).then(() => window.xilingDesktop!.voice({ action: "test", kind })).then((result) => { setStatus(result.status); setMessage("此通路连通性测试通过"); window.dispatchEvent(new Event("xiling:voice-settings")); }).catch((error) => setMessage(String(error))).finally(() => { setBusy(false); window.dispatchEvent(new Event("xiling:voice-settings")); }); }}>保存并真实测试</button></fieldset>)}<p role="status">{busy ? "正在测试，请稍候…" : message}</p><p>当前为点击录音的轮次式对话，不是常开监听的实时全双工通话。麦克风在首次点击说话时请求系统授权。</p></section>;
}
