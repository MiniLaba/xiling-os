// Wiki 窗口：科研知识阅读入口（不是 Agent memory）。
// 读写都限定在本窗口绑定的项目内；跨项目页面会被核心进程拒绝。

import { useCallback, useEffect, useState } from "react";
import type { WikiPageDetail, WikiPageSummary } from "@xiling/contracts";
import { ResearchScopeGate, useResearchScope } from "./scope.js";

interface PageList { wiki?: WikiPageSummary[] }
interface SearchResult { search?: Array<{ pageId: string; slug: string; title: string; excerpt: string; version: number }> }

export function WikiWindow() {
  const scope = useResearchScope("system.wiki");
  const [pages, setPages] = useState<WikiPageSummary[]>([]);
  const [hits, setHits] = useState<SearchResult["search"]>();
  const [query, setQuery] = useState("");
  const [detail, setDetail] = useState<WikiPageDetail>();
  const [draft, setDraft] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!scope.projectId) { setPages([]); return; }
    try {
      const listed = await scope.run<PageList>("wiki.list");
      setPages(listed.wiki ?? []);
      setStatus("");
    } catch (reason) { setStatus(scope.describeError(reason)); }
  }, [scope.projectId, scope.run, scope.describeError]);

  useEffect(() => { void refresh(); }, [refresh]);

  // 切换项目时先绑作用域，然后重新读取
  useEffect(() => { setDetail(undefined); setHits(undefined); setQuery(""); }, [scope.projectId]);

  const openPage = async (pageId: string) => {
    setBusy(true);
    try {
      const result = await scope.run<{ page?: WikiPageDetail }>("wiki.get", { pageId });
      if (result.page) { setDetail(result.page); setDraft(result.page.currentRevision.markdown); }
      setStatus("");
    } catch (reason) { setStatus(scope.describeError(reason)); }
    finally { setBusy(false); }
  };

  const search = async () => {
    const normalized = query.trim();
    if (normalized.length < 2) { setHits(undefined); setStatus("检索需要至少 2 个字符"); return; }
    setBusy(true);
    try {
      const result = await scope.run<SearchResult>("wiki.search", { query: normalized });
      setHits(result.search ?? []);
      setStatus("");
    } catch (reason) { setStatus(scope.describeError(reason)); }
    finally { setBusy(false); }
  };

  const createPage = async () => {
    if (!newTitle.trim()) return;
    setBusy(true);
    try {
      const result = await scope.run<{ created?: WikiPageDetail; wiki?: WikiPageSummary[] }>("wiki.create", { title: newTitle.trim(), markdown: `# ${newTitle.trim()}\n\n` });
      setPages(result.wiki ?? []);
      setNewTitle("");
      if (result.created) { setDetail(result.created); setDraft(result.created.currentRevision.markdown); }
    } catch (reason) { setStatus(scope.describeError(reason)); }
    finally { setBusy(false); }
  };

  const saveRevision = async () => {
    if (!detail) return;
    setBusy(true);
    try {
      const result = await scope.run<{ created?: WikiPageDetail; wiki?: WikiPageSummary[] }>("wiki.revise", { pageId: detail.id, markdown: draft });
      if (result.created) { setDetail(result.created); setDraft(result.created.currentRevision.markdown); }
      setPages(result.wiki ?? []);
      setStatus("已保存为新版本；旧版本保留在修订历史里。");
    } catch (reason) { setStatus(scope.describeError(reason)); }
    finally { setBusy(false); }
  };

  return <section className="research-window wiki-window">
    <ResearchScopeGate api={scope}>
      <div className="wiki-layout">
        <aside className="wiki-list">
          <header><p className="eyebrow">科研知识</p><h2>Wiki</h2></header>
          <div className="wiki-search">
            <input aria-label="检索 Wiki" placeholder="检索本项目的 Wiki…" maxLength={200} value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") void search(); }} />
            <button type="button" disabled={busy} onClick={() => void search()}>检索</button>
          </div>
          {hits ? <ul className="wiki-hits">{hits.map((hit) => <li key={hit.pageId}>
            <button type="button" onClick={() => void openPage(hit.pageId)}><b>{hit.title}</b><small>v{hit.version} · {hit.excerpt}</small></button>
          </li>)}</ul> : null}
          <ul className="wiki-pages">{pages.map((page) => <li key={page.id}>
            <button type="button" className={detail?.id === page.id ? "active" : ""} onClick={() => void openPage(page.id)}>
              <b>{page.title}</b><small>{page.revisionCount} 个版本 · {new Date(page.updatedAt).toLocaleString()}</small>
            </button>
          </li>)}</ul>
          {pages.length === 0 && !hits ? <p className="research-window-empty">这个项目还没有 Wiki 页面。</p> : null}
          <form className="wiki-create" onSubmit={(event) => { event.preventDefault(); void createPage(); }}>
            <input aria-label="新建 Wiki 标题" placeholder="新页面标题" maxLength={200} value={newTitle} onChange={(event) => setNewTitle(event.target.value)} />
            <button type="submit" disabled={busy || !newTitle.trim()}>新建页面</button>
          </form>
        </aside>

        <section className="wiki-detail">
          {detail ? <>
            <header>
              <div><p className="eyebrow">当前版本 v{detail.currentRevision.version}</p><h2>{detail.title}</h2></div>
              <span>{detail.revisions.length} 个版本</span>
            </header>
            <label className="wiki-editor">正文（Markdown）
              <textarea aria-label="Wiki 正文" value={draft} rows={16} onChange={(event) => setDraft(event.target.value)} />
            </label>
            <div className="wiki-actions">
              <button type="button" disabled={busy || draft === detail.currentRevision.markdown} onClick={() => void saveRevision()}>保存为新版本</button>
              <button type="button" disabled={busy || draft === detail.currentRevision.markdown} onClick={() => setDraft(detail.currentRevision.markdown)}>放弃改动</button>
            </div>
            {detail.currentRevision.artifactUris.length ? <p className="wiki-artifacts">引用产物：{detail.currentRevision.artifactUris.join("、")}</p> : null}
            <details className="wiki-history">
              <summary>修订历史（{detail.revisions.length}）</summary>
              <ol>{[...detail.revisions].reverse().map((revision) => <li key={revision.id}>
                <b>v{revision.version}</b><span>{new Date(revision.createdAt).toLocaleString()}</span>
                <button type="button" disabled={busy} onClick={() => setDraft(revision.markdown)}>载入此版本查看</button>
              </li>)}</ol>
            </details>
            {detail.backlinks.length ? <p className="wiki-artifacts">被引用：{detail.backlinks.map((link) => link.title).join("、")}</p> : null}
          </> : <p className="research-window-empty">从左侧选择一个页面，或新建一个。Wiki 是阅读与引用入口；证据与结论版本仍由证据库和科研图谱负责。</p>}
          {status ? <p role="status" className="research-window-status">{status}</p> : null}
        </section>
      </div>
    </ResearchScopeGate>
  </section>;
}
