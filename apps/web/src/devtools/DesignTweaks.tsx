import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Clipboard, Copy, Crosshair, Eraser, MousePointerClick, Paintbrush, Type, X } from "lucide-react";
import { themes } from "@xiling/ui-tokens";
import {
  applyTweaks, buildCssExport, buildSelector, elementSummary, hintStyleFile, isTextOnlyElement, loadStore, matchColorToken, saveStore,
  type StyleOverrides, type TextOverrides, type TweaksStore,
} from "./tweaks.js";

const hotkeyHint = "Ctrl/⌘ + ⇧ + D";

type Tab = "layout" | "text" | "export";

/** 汐语灵境 · 局部布局/元素/文字调整工具（本机预览，导出后落到对应样式文件）。 */
export function DesignTweaks() {
  const [enabled, setEnabled] = useState(false);
  const [picking, setPicking] = useState(false);
  const [selected, setSelected] = useState<Element | null>(null);
  const [tab, setTab] = useState<Tab>("layout");
  const [store, setStore] = useState<TweaksStore>(() => loadStore());
  const [selector, setSelector] = useState("");
  const [textDraft, setTextDraft] = useState("");
  const [copied, setCopied] = useState(false);
  const [fontSize, setFontSize] = useState("");
  const [padding, setPadding] = useState("");
  const [margin, setMargin] = useState("");
  const [radius, setRadius] = useState("");
  const highlightRef = useRef<HTMLDivElement>(null);
  const editRef = useRef<HTMLElement | null>(null);

  // 启动时回放已保存的改动；热键开关工具
  useEffect(() => { applyTweaks(loadStore()); }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLocaleLowerCase() === "d") {
        event.preventDefault();
        setEnabled((current) => !current);
        setPicking(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const persist = useCallback((next: TweaksStore) => {
    setStore(next);
    saveStore(next);
    applyTweaks(next);
  }, []);

  const selectElement = useCallback((el: Element) => {
    setSelected(el);
    const nextSelector = buildSelector(el);
    setSelector(nextSelector);
    setFontSize(store.styles[nextSelector]?.["font-size"] ?? getComputedStyle(el).fontSize.replace(/px$/, ""));
    setPadding(store.styles[nextSelector]?.padding ?? "");
    setMargin(store.styles[nextSelector]?.margin ?? "");
    setRadius(store.styles[nextSelector]?.["border-radius"] ?? "");
    setTextDraft(store.texts[nextSelector] ?? (isTextOnlyElement(el) ? el.textContent ?? "" : ""));
  }, [store.styles, store.texts]);

  // 点选模式：捕获阶段的 mousemove 高亮 + click 选中，阻止应用自身响应
  useEffect(() => {
    if (!picking) { highlightRef.current?.remove(); highlightRef.current = null; return; }
    const onMove = (event: MouseEvent) => {
      const target = document.elementFromPoint(event.clientX, event.clientY);
      if (!target || target.closest(".xl-tweaks") || target === highlightRef.current) return;
      const rect = target.getBoundingClientRect();
      const highlight = highlightRef.current ?? document.createElement("div");
      highlight.id = "xl-tweaks-highlight";
      highlight.style.cssText = `position:fixed;z-index:2147483646;pointer-events:none;border:2px solid var(--xl-accent);background:color-mix(in srgb, var(--xl-accent) 10%, transparent);border-radius:4px;left:${rect.x - 2}px;top:${rect.y - 2}px;width:${rect.width + 4}px;height:${rect.height + 4}px;`;
      if (!highlight.isConnected) document.body.appendChild(highlight);
      highlightRef.current = highlight;
    };
    const onClick = (event: MouseEvent) => {
      const target = document.elementFromPoint(event.clientX, event.clientY);
      if (!target || target.closest(".xl-tweaks")) return;
      event.preventDefault();
      event.stopPropagation();
      setPicking(false);
      selectElement(target);
    };
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    return () => {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("click", onClick, true);
    };
  }, [picking, selectElement]);

  const setProp = useCallback((prop: string, value: string) => {
    if (!selector) return;
    const nextStyles: StyleOverrides = { ...store.styles };
    const props = { ...nextStyles[selector] };
    if (value.trim()) props[prop] = value.trim();
    else delete props[prop];
    if (!Object.keys(props).length) delete nextStyles[selector];
    else nextStyles[selector] = props;
    persist({ ...store, styles: nextStyles });
  }, [persist, selector, store]);

  const currentProps = selector ? store.styles[selector] ?? {} : {};
  const currentText = selector ? store.texts[selector] ?? "" : "";
  const editableText = selected ? isTextOnlyElement(selected) : false;
  const summary = useMemo(() => selected ? elementSummary(selected) : null, [selected, store]);
  const cssExport = useMemo(() => buildCssExport(store.styles, store.texts), [store]);

  const commitText = useCallback(() => {
    if (!selector || !editableText) return;
    const nextTexts: TextOverrides = { ...store.texts };
    const original = selected?.textContent ?? "";
    if (textDraft.trim() && textDraft !== original) nextTexts[selector] = textDraft;
    else delete nextTexts[selector];
    persist({ ...store, texts: nextTexts });
    editRef.current = null;
  }, [editableText, persist, selector, selected, store, textDraft]);

  if (!enabled) {
    return (
      <button
        className="xl-tweaks xl-tweaks-launcher"
        title={`布局调整工具（${hotkeyHint}）`}
        onClick={() => setEnabled(true)}
      >
        <Paintbrush size={14} aria-hidden="true" />
      </button>
    );
  }

  const colorSwatches = Object.entries(themes[document.documentElement.dataset.theme === "poxiao" ? "poxiao" : "lingjing"]).filter(([key]) => ["text", "muted", "faint", "accent", "accentStrong", "evidence", "success", "warning", "danger", "info", "border", "borderStrong", "surface", "elevated"].includes(key));

  return (
    <div className="xl-tweaks xl-tweaks-panel" role="dialog" aria-label="布局调整辅助工具">
      <header className="xl-tweaks-head">
        <b>布局调整</b>
        <small>本机预览 · 导出后需落到对应样式文件</small>
        <button className="xl-icon-btn" aria-label="关闭工具" onClick={() => { setEnabled(false); setPicking(false); }}><X size={14} /></button>
      </header>

      <div className="xl-tweaks-toolbar">
        <button className={`xl-tweaks-pick ${picking ? "on" : ""}`} onClick={() => setPicking((current) => !current)}>
          <Crosshair size={14} aria-hidden="true" />{picking ? "点击页面元素…" : "选择元素"}
        </button>
        <button className="xl-tweaks-clear" onClick={() => { persist({ styles: {}, texts: {} }); setTextDraft(""); }} title="清除本机全部改动">
          <Eraser size={13} aria-hidden="true" />重置
        </button>
      </div>
      {!picking ? <p className="xl-tweaks-hint">开启「选择元素」后点击页面任意元素；或再次按 {hotkeyHint} 关闭工具。</p> : null}

      {selected && summary ? (
        <>
          <section className="xl-tweaks-element">
            <div className="xl-tweaks-path" title={summary.path}>{summary.tag} · {summary.rect.width}×{summary.rect.height}</div>
            <code>{selector}</code>
            <small>导出落点：{hintStyleFile(selector)}</small>
            {Object.keys(currentProps).length || currentText ? <button className="xl-tweaks-remove" onClick={() => {
              const styles = { ...store.styles }; delete styles[selector];
              const texts = { ...store.texts }; delete texts[selector];
              persist({ styles, texts });
            }}><X size={12} aria-hidden="true" />清除该元素改动</button> : null}
          </section>

          <nav className="xl-tweaks-tabs" role="tablist">
            {([["layout", "排版与盒模型", <Paintbrush key="l" size={13} aria-hidden="true" />], ["text", "文字", <Type key="t" size={13} aria-hidden="true" />], ["export", "导出", <Copy key="e" size={13} aria-hidden="true" />]] as Array<[Tab, string, React.ReactNode]>).map(([id, label, icon]) => (
              <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{icon}{label}</button>
            ))}
          </nav>

          {tab === "layout" ? (
            <div className="xl-tweaks-body">
              <label>字号 <small>设计规范下限 11px</small>
                <div className="xl-tweaks-row">
                  <input type="number" min={11} max={64} value={fontSize} onChange={(event) => setFontSize(event.target.value)} />
                  <button onClick={() => { const value = Math.max(11, Number(fontSize) || 14); setFontSize(String(value)); setProp("font-size", `${value}px`); }}>应用</button>
                  {Number(fontSize) < 11 ? <em className="xl-tweaks-warn">低于 11px 会被钳制</em> : null}
                </div>
              </label>
              <label>内边距 padding
                <div className="xl-tweaks-row">
                  <input placeholder="如 16px 或 12px 16px" value={padding} onChange={(event) => setPadding(event.target.value)} />
                  <button onClick={() => setProp("padding", padding)}>应用</button>
                </div>
              </label>
              <label>外边距 margin
                <div className="xl-tweaks-row">
                  <input placeholder="如 0 auto 或 24px 0" value={margin} onChange={(event) => setMargin(event.target.value)} />
                  <button onClick={() => setProp("margin", margin)}>应用</button>
                </div>
              </label>
              <label>圆角 radius
                <div className="xl-tweaks-row">
                  <input placeholder="如 10px 或 999px" value={radius} onChange={(event) => setRadius(event.target.value)} />
                  <button onClick={() => setProp("border-radius", radius)}>应用</button>
                </div>
              </label>
              <label>文字颜色
                <div className="xl-tweaks-swatches">
                  {colorSwatches.map(([key, value]) => (
                    <button key={key} title={`${key}: ${value}`} style={{ background: value }} onClick={() => setProp("color", matchColorToken(value) ?? value)} />
                  ))}
                </div>
              </label>
              <label>背景颜色
                <div className="xl-tweaks-swatches">
                  {colorSwatches.map(([key, value]) => (
                    <button key={key} title={`背景 ${key}: ${value}`} style={{ background: value }} onClick={() => setProp("background", matchColorToken(value) ?? value)} />
                  ))}
                  <input type="color" aria-label="自定义背景颜色" onChange={(event) => setProp("background", matchColorToken(event.target.value) ?? event.target.value)} />
                </div>
              </label>
              {Object.keys(currentProps).length ? (
                <div className="xl-tweaks-applied">
                  <b>已应用的改动</b>
                  {Object.entries(currentProps).map(([prop, value]) => (
                    <div key={prop} className="xl-tweaks-applied-row">
                      <code>{prop}</code><span>{value}</span>
                      <button aria-label={`移除 ${prop}`} onClick={() => setProp(prop, "")}><X size={11} aria-hidden="true" /></button>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {tab === "text" ? (
            <div className="xl-tweaks-body">
              {editableText ? (
                <>
                  <label>节点文字（预览即时生效；正式修改请到对应 TSX 组件替换文案）
                    <textarea value={textDraft} rows={4} onChange={(event) => setTextDraft(event.target.value)} onBlur={commitText} />
                  </label>
                  <button className="xl-tweaks-apply" onClick={commitText}><MousePointerClick size={13} aria-hidden="true" />应用到本机预览</button>
                  {currentText ? <p className="xl-tweaks-note">当前预览文字：{currentText.slice(0, 120)}{currentText.length > 120 ? "…" : ""}</p> : null}
                </>
              ) : (
                <p className="xl-tweaks-note">该元素包含子组件（图标/嵌套结构），不能整体替换文字。请选择最内层的纯文本元素，或直接修改对应 TSX。</p>
              )}
            </div>
          ) : null}

          {tab === "export" ? (
            <div className="xl-tweaks-body">
              <button className="xl-tweaks-apply" onClick={() => { void navigator.clipboard.writeText(cssExport); setCopied(true); window.setTimeout(() => setCopied(false), 1800); }}>
                <Clipboard size={13} aria-hidden="true" />{copied ? "已复制" : "复制全部导出 CSS"}
              </button>
              <pre className="xl-tweaks-export">{cssExport}</pre>
              <p className="xl-tweaks-note">把导出的规则粘到上面对应的样式文件后，点「重置」清掉本机预览改动。</p>
            </div>
          ) : null}
        </>
      ) : (
        <p className="xl-tweaks-note">先开启「选择元素」并点击页面元素，即可调整它的字号、间距、圆角、颜色，或原地修改文字。</p>
      )}
    </div>
  );
}
