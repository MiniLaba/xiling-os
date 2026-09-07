import { useState } from "react";
import { ArtifactResult } from "./artifact-inputs.js";

export function SaveAnswer({ messageId }: { messageId: string }) {
  const [busy, setBusy] = useState(false);
  const [content, setContent] = useState<string>();
  const [artifactId, setArtifactId] = useState<string>();
  const [error, setError] = useState("");
  return <div>
    <button type="button" disabled={busy || !window.xilingDesktop} onClick={() => {
      setBusy(true); setError("");
      void window.xilingDesktop!.artifacts.saveAnswer(messageId)
        .then(({ artifactId }) => { setArtifactId(artifactId); return window.xilingDesktop!.artifacts.get(artifactId); })
        .then(({ artifact }) => setContent(artifact.content))
        .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
        .finally(() => setBusy(false));
    }}>{busy ? "保存中…" : "保存回答为产物 / 查看"}</button>
    {error && <p role="alert">{error}</p>}
    {content !== undefined && <section aria-label="已保存的回答">
      <p>由你保存的回答快照，已关联原任务。可在任务中心再次打开；不是经过验证的研究结论。</p>
      <button type="button" onClick={() => setContent(undefined)}>收起</button>
      {artifactId && <ArtifactResult id={artifactId} />}
      <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{content}</pre>
    </section>}
  </div>;
}
