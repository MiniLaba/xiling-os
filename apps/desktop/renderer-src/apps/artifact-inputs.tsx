import { useEffect, useState } from "react";
import { playVoice, stopVoice } from "./voice.js";
import type { OsSnapshot } from "../window-runtime.js";

/** Selection is explicit task context; importing never starts an Agent. */
export function ArtifactInputs({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const [items, setItems] = useState<OsSnapshot["artifacts"]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    void window.xilingDesktop?.getOsSnapshot().then((snapshot) => { if (alive) setItems(snapshot.artifacts); }).catch(() => {});
    return () => { alive = false; };
  }, [value]);
  return <fieldset disabled={busy} className="artifact-inputs"><legend>提供给本次任务的文件</legend>
    <select aria-label="添加已有产物" value="" onChange={(event) => { if (event.target.value && value.length < 20) onChange([...new Set([...value, event.target.value])]); }}>
      <option value="">选择已有产物（可选）</option>{items.filter((item) => !value.includes(item.artifactId)).map((item) => <option key={item.artifactId} value={item.artifactId}>{item.name} · v{item.version}</option>)}
    </select>
    <button type="button" disabled={value.length >= 20} onClick={() => {
      setBusy(true); setError("");
      void window.xilingDesktop?.artifacts.importText().then(({ artifactId }) => { if (artifactId) onChange([...new Set([...value, artifactId])]); }).catch((reason: unknown) => setError(String(reason))).finally(() => setBusy(false));
    }}>从电脑导入文本</button>
    {value.map((id) => <button type="button" key={id} onClick={() => onChange(value.filter((item) => item !== id))}>{items.find((item) => item.artifactId === id)?.name ?? "已选文件"} ×</button>)}
    {error && <p role="alert">{error}</p>}
  </fieldset>;
}

export function ArtifactResult({ id }: { id: string }) {
  const [artifact, setArtifact] = useState<{ name: string; content: string; truncated: boolean; mimeType: string }>();
  const [error, setError] = useState("");
  return <section>
    <button type="button" onClick={() => { void window.xilingDesktop?.artifacts.get(id).then((result) => setArtifact(result.artifact)).catch((reason: unknown) => setError(String(reason))); }}>打开产物</button>
    {artifact && <div><strong>{artifact.name}</strong><button type="button" onClick={() => setArtifact(undefined)}>收起</button>
      <button hidden={artifact.mimeType === "audio/wav"} type="button" onClick={() => { void window.xilingDesktop?.artifacts.exportText(id).catch((reason: unknown) => setError(String(reason))); }}>导出到电脑</button>
      <>{artifact.mimeType === "audio/wav" ? <><button type="button" onClick={() => { void window.xilingDesktop?.voice({ action: "audio", id }).then(async (result) => { if (result.audio) await playVoice(result.audio); }).catch((reason) => setError(String(reason))); }}>播放语音</button><button type="button" onClick={stopVoice}>停止播放</button></> : <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{artifact.content}</pre>}</>{artifact.mimeType !== "audio/wav" && artifact.truncated && <p>当前为截断预览，不能作为完整文件导出。</p>}</div>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
