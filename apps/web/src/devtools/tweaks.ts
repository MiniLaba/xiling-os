/**
 * 布局调整辅助工具的核心逻辑：选择器生成、覆盖记录存储、令牌映射与样式文件定位。
 * 工具本身只做本机预览（localStorage + 注入 <style>），正式修改仍需把导出的 CSS
 * 落到对应样式文件（见 docs/design-system.md §9）。
 */

export type StyleOverrides = Record<string, Record<string, string>>;
export type TextOverrides = Record<string, string>;

export interface TweaksStore {
  styles: StyleOverrides;
  texts: TextOverrides;
}

const STORAGE_KEY = "xiling.design-tweaks:v1";

export function loadStore(): TweaksStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { styles: {}, texts: {} };
    const parsed = JSON.parse(raw) as Partial<TweaksStore>;
    return { styles: parsed.styles ?? {}, texts: parsed.texts ?? {} };
  } catch { return { styles: {}, texts: {} }; }
}

export function saveStore(store: TweaksStore): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); } catch { /* storage unavailable */ }
}

/** 应用状态类不进入选择器：它们随交互出现/消失，会让选择器失效。 */
const volatileClasses = new Set([
  "active", "selected", "open", "dimmed", "expanded", "collapsed", "hidden", "visible", "hover", "focus",
  "active-context", "quoted-context", "is-running", "is-failed", "selected-context", "resizing-split",
  "artifact-expanded", "artifact-overlay", "settings-mode", "ready", "blocked", "compact", "loading",
]);

export function buildSelector(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node !== document.body && node.tagName !== "HTML") {
    if (node.id) { parts.unshift(`#${CSS.escape(node.id)}`); break; }
    const classes = [...node.classList].filter((name) => !volatileClasses.has(name));
    if (classes.length) {
      const local = `.${classes.map((name) => CSS.escape(name)).join(".")}`;
      const candidate = parts.length ? `${local} ${parts.join(" ")}` : local;
      parts.unshift(local);
      if (document.querySelectorAll(candidate).length === 1) break;
    } else {
      const parent = node.parentElement;
      if (parent && node) {
        const tag = node.tagName;
        const siblings = [...parent.children].filter((child) => child.tagName === tag);
        const index = siblings.indexOf(node) + 1;
        parts.unshift(`${tag.toLowerCase()}:nth-of-type(${index})`);
      }
    }
    node = node.parentElement;
  }
  const selector = parts.join(" ").trim();
  return selector || el.tagName.toLowerCase();
}

/** 类名前缀 → 维护文件映射：告诉用户导出的 CSS 应该落到哪里。 */
const fileHints: Array<[RegExp, string]> = [
  [/^(shell|sidebar|brand|workspace|command-palette|project-switcher|nav-|recent-work|session-|new-conversation|settings-btn|placeholder|view-loading|save-state|settings-top)/, "apps/web/src/styles/shell.css"],
  [/^(chat|aui|composer|native-attachment|adapter-note|artifact-overlay|split-resizer|chat-publish|chat-running|chat-choice|chat-tool|chat-save|chat-context|chat-model|chat-primary|chat-workflows|agent-activity|execution-|scientific-markdown)/, "apps/web/src/styles/chat.css"],
  [/^(scientific)/, "apps/web/src/styles/canvas.css"],
  [/^(knowledge-wiki|wiki-|paper-|literature|year-legend|graph-utility|algorithm-note)/, "apps/web/src/styles/views.css"],
  [/^(project-|board-column|inline-create|item-create|record-expand|record-full|record-modal|attention-)/, "apps/web/src/styles/views.css"],
  [/^(settings|provider|credential|model-runtime|model-id|model-native|role-route|agent-role|skills|skill-|mcp-|security)/, "apps/web/src/styles/views.css"],
  [/^(artifact-panel|artifact-)/, "apps/web/src/styles/views.css"],
  [/^(workflow-)/, "apps/web/src/styles/views.css"],
  [/^(xl-)/, "apps/web/src/styles/base.css"],
];

export function hintStyleFile(selector: string): string {
  const first = selector.split(/[\s>]+/)[0]?.replace(/^[.#]/, "").split(/\.|:/)[0] ?? "";
  for (const [pattern, file] of fileHints) if (pattern.test(first)) return file;
  return "apps/web/src/styles/views.css（或按类名全文检索）";
}

export function buildCssExport(styles: StyleOverrides, texts: TextOverrides): string {
  const blocks: string[] = [];
  for (const [selector, props] of Object.entries(styles)) {
    if (!Object.keys(props).length) continue;
    const lines = Object.entries(props).map(([prop, value]) => `  ${prop}: ${value};`);
    blocks.push(`${selector} {\n${lines.join("\n")}\n}`);
  }
  const textNotes = Object.entries(texts)
    .filter(([, text]) => text.trim())
    .map(([selector, text]) => `/* 文字修改：${selector}\n   在对应 TSX 组件里把该节点文本替换为：${JSON.stringify(text)} */`);
  return [...textNotes, ...blocks].join("\n\n") || "（暂无改动）";
}

/** 从 :root 解析 --xl-* 变量的实际颜色，用于把拾取色反向映射为设计令牌。 */
export function tokenColorMap(): Map<string, string> {
  const root = getComputedStyle(document.documentElement);
  const map = new Map<string, string>();
  const preferred = [
    "--xl-text", "--xl-muted", "--xl-faint", "--xl-accent", "--xl-accent-strong", "--xl-accent-soft",
    "--xl-evidence", "--xl-success", "--xl-warning", "--xl-danger", "--xl-info",
    "--xl-stance-support", "--xl-stance-refute", "--xl-stance-qualify", "--xl-stance-insufficient",
    "--xl-bg", "--xl-bg-secondary", "--xl-surface", "--xl-elevated", "--xl-hover", "--xl-border", "--xl-border-strong",
  ];
  for (const name of preferred) {
    const value = root.getPropertyValue(name).trim();
    if (value) map.set(value.toLowerCase(), name);
  }
  return map;
}

const normalizeColor = (value: string): string => {
  const canvas = document.createElement("canvas").getContext("2d");
  if (!canvas) return value;
  canvas.fillStyle = "#000000";
  canvas.fillStyle = value;
  const first = canvas.fillStyle;
  canvas.fillStyle = "#ffffff";
  canvas.fillStyle = value;
  return String(first) === String(canvas.fillStyle) ? String(first).toLowerCase() : value.toLowerCase();
};

/** 若颜色与设计令牌一致，返回变量名（导出为 var(--xl-*)）；否则返回 undefined。 */
export function matchColorToken(value: string): string | undefined {
  return tokenColorMap().get(normalizeColor(value));
}

export function applyTweaks(store: TweaksStore): void {
  document.getElementById("xl-design-tweaks-style")?.remove();
  const style = document.createElement("style");
  style.id = "xl-design-tweaks-style";
  style.textContent = Object.entries(store.styles)
    .filter(([, props]) => Object.keys(props).length)
    .map(([selector, props]) => `${selector} {\n${Object.entries(props).map(([prop, value]) => `  ${prop}: ${value} !important;`).join("\n")}\n}`)
    .join("\n\n");
  document.head.appendChild(style);
  for (const [selector, text] of Object.entries(store.texts)) {
    try {
      for (const node of document.querySelectorAll(selector)) if (isTextOnlyElement(node)) node.textContent = text;
    } catch { /* 无效选择器跳过 */ }
  }
}

/** 只有纯文本节点（不含任何子元素）才能做文字替换，避免破坏子组件结构。 */
export function isTextOnlyElement(el: Element): boolean {
  return ![...el.childNodes].some((node) => node.nodeType !== Node.TEXT_NODE);
}

export function elementSummary(el: Element): { tag: string; classes: string[]; rect: { width: number; height: number }; path: string } {
  const chain: string[] = [];
  let node: Element | null = el;
  let depth = 0;
  while (node && node !== document.body && depth < 6) {
    const label = node.id ? `#${node.id}` : node.classList.length ? `${node.tagName.toLowerCase()}.${[...node.classList].slice(0, 2).join(".")}` : node.tagName.toLowerCase();
    chain.unshift(label);
    node = node.parentElement;
    depth += 1;
  }
  const rect = el.getBoundingClientRect();
  return { tag: el.tagName.toLowerCase(), classes: [...el.classList], rect: { width: Math.round(rect.width), height: Math.round(rect.height) }, path: chain.join(" › ") };
}
