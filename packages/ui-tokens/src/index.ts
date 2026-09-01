/**
 * 汐语灵境设计令牌 —— UI 视觉的唯一事实源。
 *
 * 设计哲学：汐语（潮汐的语言，节奏与呼吸）× 灵境（钱学森灵境系统，界面消隐、
 * 对象沉浸）。两套主题：灵境（lingjing，深色沉浸）与破晓（poxiao，浅色研究），
 * 跟随系统并可手动覆盖。
 *
 * 使用规则：
 * 1. UI 代码只允许引用 --xl-* 变量或本文件的导出常量，禁止十六进制字面量。
 * 2. 正文字号不得低于 11px；muted/faint 已按 WCAG AA 反推，勿自行调暗。
 * 3. 所有过渡使用 motion 中的潮汐缓动与三拍时长。
 */

// ─── 主题调色板 ──────────────────────────────────────────────────────

export interface StanceColors { support: string; refute: string; qualify: string; insufficient: string }

export interface ThemePalette {
  /** 页面底色（非纯黑，避免眩光与拖影） */
  bg: string;
  bgSecondary: string;
  /** 卡片与面板 */
  surface: string;
  /** 浮层、popover、活跃卡片 */
  elevated: string;
  /** hover 底色 */
  hover: string;
  border: string;
  borderStrong: string;
  text: string;
  /** 二级文字，AA 合规（≥4.5:1） */
  muted: string;
  /** 三级文字/图标，AA 合规底线 */
  faint: string;
  /** 品牌强调（汐青/汐蓝）：图标、链接、聚焦 */
  accent: string;
  /** 需要承载文字的强调填充（按钮底色） */
  accentStrong: string;
  /** 置于 accentStrong 上的文字色 */
  onAccent: string;
  /** 强调色低饱和洗底 */
  accentSoft: string;
  /** 证据金：证据链与溯源点睛 */
  evidence: string;
  evidenceSoft: string;
  success: string;
  warning: string;
  danger: string;
  info: string;
  stance: StanceColors;
  relations: Record<string, string>;
  entities: Record<string, string>;
}

/** 灵境（深色沉浸）：近黑蓝空间，汐青强调，证据金点睛。 */
export const lingjing: ThemePalette = {
  bg: "#0B1220",
  bgSecondary: "#0E1728",
  surface: "#111D31",
  elevated: "#1A2A45",
  hover: "#213554",
  border: "#263852",
  borderStrong: "#385078",
  text: "#E8EEF6",
  muted: "#A5B6CC",
  faint: "#7A8CA4",
  accent: "#38BDF8",
  accentStrong: "#0E7490",
  onAccent: "#F0FAFF",
  accentSoft: "#123043",
  evidence: "#F5B54A",
  evidenceSoft: "#3A2C14",
  success: "#34D399",
  warning: "#FBBF24",
  danger: "#F87171",
  info: "#38BDF8",
  stance: { support: "#34D399", refute: "#F87171", qualify: "#FBBF24", insufficient: "#94A3B8" },
  relations: {
    CONTAINS: "#8296AC",
    HAS_REVISION: "#9AA7B8",
    HAS_FRAGMENT: "#2DD4BF",
    CITES: "#22D3EE",
    ASSERTS: "#34D399",
    BASED_ON: "#4ADE80",
    EVALUATES: "#A3E635",
    DOCUMENTS: "#84CC16",
    SUPERSEDES: "#F59E0B",
    HAS_VERSION: "#FBBF24",
    USED: "#FB923C",
    GENERATED: "#F97316",
    DERIVED_FROM: "#F87171",
    TRANSITIONED_BY: "#E879F9",
    ASSOCIATED_WITH: "#C084FC",
    REFERENCES: "#818CF8",
  },
  entities: {
    Project: "#818CF8",
    ResearchQuestion: "#A78BFA",
    Hypothesis: "#C084FC",
    Claim: "#60A5FA",
    ClaimRevision: "#38BDF8",
    EvidenceAssertion: "#34D399",
    Paper: "#22D3EE",
    SourceFragment: "#2DD4BF",
    Dataset: "#FBBF24",
    DatasetSnapshot: "#FB923C",
    ResearchPlan: "#7C9CBF",
    Approval: "#F5B54A",
    ResearchRun: "#F472B6",
    Artifact: "#D4A373",
    ArtifactVersion: "#C99A6B",
    LifecycleEvent: "#94A3B8",
    ReviewReport: "#F87171",
    WikiRevisionRef: "#4ADE80",
    Actor: "#E879F9",
  },
};

/** 破晓（浅色研究）：纸感明亮，汐蓝强调，同构语义。 */
export const poxiao: ThemePalette = {
  bg: "#F6F8FB",
  bgSecondary: "#EDF1F7",
  surface: "#FFFFFF",
  elevated: "#FFFFFF",
  hover: "#EAF1F8",
  border: "#DCE5EF",
  borderStrong: "#BCCBDD",
  text: "#14212F",
  muted: "#53657B",
  faint: "#63748A",
  accent: "#0E87A8",
  accentStrong: "#0B6E8A",
  onAccent: "#FFFFFF",
  accentSoft: "#E0F2F8",
  evidence: "#B45309",
  evidenceSoft: "#F9EBD7",
  success: "#0F8A5F",
  warning: "#A16207",
  danger: "#C43636",
  info: "#0E87A8",
  stance: { support: "#0F8A5F", refute: "#C43636", qualify: "#A16207", insufficient: "#64748B" },
  relations: {
    CONTAINS: "#5B7288",
    HAS_REVISION: "#6B7B8C",
    HAS_FRAGMENT: "#0D9488",
    CITES: "#0891B2",
    ASSERTS: "#0F8A5F",
    BASED_ON: "#16A34A",
    EVALUATES: "#65A30D",
    DOCUMENTS: "#4D7C0F",
    SUPERSEDES: "#B45309",
    HAS_VERSION: "#A16207",
    USED: "#C2410C",
    GENERATED: "#9A3412",
    DERIVED_FROM: "#C43636",
    TRANSITIONED_BY: "#A21CAF",
    ASSOCIATED_WITH: "#7E22CE",
    REFERENCES: "#4F46E5",
  },
  entities: {
    Project: "#4F46E5",
    ResearchQuestion: "#7C3AED",
    Hypothesis: "#9333EA",
    Claim: "#2563EB",
    ClaimRevision: "#0284C7",
    EvidenceAssertion: "#0F8A5F",
    Paper: "#0891B2",
    SourceFragment: "#0D9488",
    Dataset: "#A16207",
    DatasetSnapshot: "#C2410C",
    ResearchPlan: "#5B7288",
    Approval: "#B45309",
    ResearchRun: "#DB2777",
    Artifact: "#92704A",
    ArtifactVersion: "#8A6544",
    LifecycleEvent: "#64748B",
    ReviewReport: "#C43636",
    WikiRevisionRef: "#16A34A",
    Actor: "#A21CAF",
  },
};

export const themes = { lingjing, poxiao } as const;
export type ThemeName = keyof typeof themes;

// ─── 字体与字号阶 ─────────────────────────────────────────────────────

export const fontFamily = {
  ui: '"PingFang SC", "MiSans", "HarmonyOS Sans SC", "Microsoft YaHei", "Noto Sans SC", "Source Han Sans SC", system-ui, sans-serif',
  latin: 'Inter, "SF Pro Text", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  mono: '"SF Mono", "JetBrains Mono", "Fira Code", "Cascadia Code", ui-monospace, Menlo, Consolas, monospace',
} as const;

/** 字号阶（px）：任何 UI 文字不得低于 caption（11px）。 */
export const typeScale = {
  caption: "11px",
  small: "12px",
  control: "13px",
  body: "14px",
  lead: "15px",
  section: "17px",
  title: "21px",
  page: "28px",
} as const;

export const lineHeight = { tight: "1.3", ui: "1.45", body: "1.65", cjk: "1.75" } as const;

// ─── 空间 / 圆角 / 阴影 ────────────────────────────────────────────────

/** 4px 网格间距。 */
export const space = { 0: "0", 1: "4px", 2: "8px", 3: "12px", 4: "16px", 5: "20px", 6: "24px", 8: "32px", 10: "40px", 12: "48px", 16: "64px" } as const;

export const radius = { sm: "6px", md: "10px", lg: "14px", xl: "20px", full: "999px" } as const;

export const shadow: Record<ThemeName, { sm: string; md: string; lg: string }> = {
  lingjing: {
    sm: "0 1px 2px rgba(2, 6, 14, 0.5)",
    md: "0 6px 20px -4px rgba(2, 6, 14, 0.55), 0 2px 6px rgba(2, 6, 14, 0.4)",
    lg: "0 18px 48px -8px rgba(2, 6, 14, 0.65), 0 6px 16px rgba(2, 6, 14, 0.5)",
  },
  poxiao: {
    sm: "0 1px 2px rgba(21, 33, 47, 0.07)",
    md: "0 6px 20px -4px rgba(21, 33, 47, 0.12), 0 2px 6px rgba(21, 33, 47, 0.06)",
    lg: "0 18px 48px -8px rgba(21, 33, 47, 0.18), 0 6px 16px rgba(21, 33, 47, 0.08)",
  },
};

// ─── 动效（潮汐节奏） ─────────────────────────────────────────────────

export const motion = {
  /** 三拍时长：快一拍、常一拍、慢一拍。 */
  fast: "180ms",
  normal: "320ms",
  slow: "560ms",
  /** 呼吸脉动周期（运行态潮汐呼吸）。 */
  breathe: "2600ms",
  /** 潮汐缓动：慢进缓出，如潮水进退。 */
  tide: "cubic-bezier(0.22, 0.68, 0.31, 0.99)",
  /** 通用减速缓出。 */
  easeOut: "cubic-bezier(0.16, 1, 0.3, 1)",
} as const;

// ─── 层级 ────────────────────────────────────────────────────────────

export const zIndex = { base: 0, sticky: 10, overlay: 100, palette: 200, modal: 300, toast: 400 } as const;

// ─── CSS 变量生成 ─────────────────────────────────────────────────────

const paletteVars = (theme: ThemePalette): Record<string, string> => {
  const vars: Record<string, string> = {
    "--xl-bg": theme.bg,
    "--xl-bg-secondary": theme.bgSecondary,
    "--xl-surface": theme.surface,
    "--xl-elevated": theme.elevated,
    "--xl-hover": theme.hover,
    "--xl-border": theme.border,
    "--xl-border-strong": theme.borderStrong,
    "--xl-text": theme.text,
    "--xl-muted": theme.muted,
    "--xl-faint": theme.faint,
    "--xl-accent": theme.accent,
    "--xl-accent-strong": theme.accentStrong,
    "--xl-on-accent": theme.onAccent,
    "--xl-accent-soft": theme.accentSoft,
    "--xl-evidence": theme.evidence,
    "--xl-evidence-soft": theme.evidenceSoft,
    "--xl-success": theme.success,
    "--xl-warning": theme.warning,
    "--xl-danger": theme.danger,
    "--xl-info": theme.info,
    "--xl-stance-support": theme.stance.support,
    "--xl-stance-refute": theme.stance.refute,
    "--xl-stance-qualify": theme.stance.qualify,
    "--xl-stance-insufficient": theme.stance.insufficient,
  };
  for (const [kind, color] of Object.entries(theme.relations)) vars[`--xl-rel-${kind.toLowerCase().replaceAll("_", "-")}`] = color;
  for (const [kind, color] of Object.entries(theme.entities)) vars[`--xl-entity-${kind.toLowerCase()}`] = color;
  return vars;
};

const staticVars = (): Record<string, string> => ({
  "--xl-font-ui": fontFamily.ui,
  "--xl-font-latin": fontFamily.latin,
  "--xl-font-mono": fontFamily.mono,
  "--xl-type-caption": typeScale.caption,
  "--xl-type-small": typeScale.small,
  "--xl-type-control": typeScale.control,
  "--xl-type-body": typeScale.body,
  "--xl-type-lead": typeScale.lead,
  "--xl-type-section": typeScale.section,
  "--xl-type-title": typeScale.title,
  "--xl-type-page": typeScale.page,
  "--xl-leading-tight": lineHeight.tight,
  "--xl-leading-ui": lineHeight.ui,
  "--xl-leading-body": lineHeight.body,
  "--xl-leading-cjk": lineHeight.cjk,
  ...Object.fromEntries(Object.entries(space).map(([key, value]) => [`--xl-space-${key}`, value])),
  "--xl-radius-sm": radius.sm,
  "--xl-radius-md": radius.md,
  "--xl-radius-lg": radius.lg,
  "--xl-radius-xl": radius.xl,
  "--xl-radius-full": radius.full,
  "--xl-motion-fast": motion.fast,
  "--xl-motion-normal": motion.normal,
  "--xl-motion-slow": motion.slow,
  "--xl-motion-breathe": motion.breathe,
  "--xl-ease-tide": motion.tide,
  "--xl-ease-out": motion.easeOut,
  "--xl-z-overlay": String(zIndex.overlay),
  "--xl-z-palette": String(zIndex.palette),
  "--xl-z-modal": String(zIndex.modal),
  "--xl-z-toast": String(zIndex.toast),
});

const shadowVars = (name: ThemeName): Record<string, string> => ({
  "--xl-shadow-sm": shadow[name].sm,
  "--xl-shadow-md": shadow[name].md,
  "--xl-shadow-lg": shadow[name].lg,
});

const block = (selector: string, vars: Record<string, string>): string =>
  `${selector} {\n${Object.entries(vars).map(([key, value]) => `  ${key}: ${value};`).join("\n")}\n}`;

/** 生成 apps/web 使用的 tokens.css 全文（唯一事实源，勿手改）。 */
export function buildTokensCss(): string {
  return `/* GENERATED FROM packages/ui-tokens/src/index.ts — 唯一事实源，请勿手改。 */
${block(":root", { ...staticVars(), ...paletteVars(poxiao), ...shadowVars("poxiao") })}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="poxiao"]) {
${Object.entries({ ...paletteVars(lingjing), ...shadowVars("lingjing") }).map(([key, value]) => `    ${key}: ${value};`).join("\n")}
  }
}

${block('[data-theme="lingjing"]', { ...paletteVars(lingjing), ...shadowVars("lingjing") })}
${block('[data-theme="poxiao"]', { ...paletteVars(poxiao), ...shadowVars("poxiao") })}

@keyframes xl-tide-breathe {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}

@keyframes xl-tide-rise {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
`;
}
