import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");
const chat = read("apps/web/src/chat/ChatView.tsx");
const agentFlow = read("apps/web/src/chat/AgentExecutionGraphView.tsx");
const canvas = read("apps/web/src/canvas/ScientificCanvasView.tsx");
const papers = read("apps/web/src/papers/PaperGraphView.tsx");
const app = read("apps/web/src/App.tsx");
// 汐语灵境样式层：tokens（生成）+ base + shell + chat + canvas + views。
const styles = ["tokens", "base", "shell", "chat", "canvas", "views"].map((name) => read(`apps/web/src/styles/${name}.css`)).join("\n");

const checks = [
  [chat.includes("ResizeObserver") && chat.includes("ArtifactViewer"), "Chat must resize with the real Artifact viewer"],
  [!app.includes("OutputPanel") && styles.includes("grid-template-columns: 220px minmax(0, 1fr)") && app.includes("sidebarCollapsed"), "application shell must retain the two-column pre-junzezhi layout contract"],
  [chat.includes("artifact-overlay") && styles.includes(".artifact-overlay .artifact-panel"), "narrow Chat must use an Artifact drawer"],
  [chat.includes("workbenchWidth >= 1_040") && chat.includes("artifact-overlay"), "narrow Chat must not start behind the Artifact drawer"],
  [!chat.includes('setArtifactOpen(project.id ==='), "project selection must not force the Artifact drawer over narrow Chat"],
  [agentFlow.includes("buildConversationCanvas") && agentFlow.includes("hiddenDetailCount"), "Agent flow must fold execution details into conversational nodes"],
  [agentFlow.includes("沿节点继续") && agentFlow.includes("组合引用") && agentFlow.includes("unstable_useComposerInput"), "Agent flow must support follow-up and multi-node quote interaction through the shared Composer"],
  [canvas.includes("nodesDraggable") && canvas.includes("panOnScroll") && canvas.includes("聚焦 1 跳"), "Scientific Canvas must support drag, vertical panning and one-hop focus"],
  [canvas.includes("relationFilter") && canvas.includes("全部关系"), "Scientific Canvas relation legend must be interactive"],
  [!papers.includes("/api/v1/literature/demo"), "Literature workbench must not auto-load the fixture graph"],
  [app.includes("command-palette") && styles.includes(":focus-visible"), "global navigation must retain keyboard command and focus affordances"],
  [!app.includes("ResearchView") && !chat.includes("mhw_mld"), "retired demo UI must not return"],
  [styles.includes("@media (max-width: 900px)") && styles.includes("prefers-reduced-motion"), "responsive and reduced-motion rules are required"],
  // 汐语灵境设计系统不变量（docs/design-system.md）
  [styles.includes("--xl-accent") && styles.includes("--xl-stance-support") && styles.includes("--xl-rel-contains"), "design tokens must provide accent, stance and relation variables"],
  [!/\bfont-size:\s*(?:[6-9]|10)(?:\.\d+)?px\b/.test(styles), "no text below the 11px readability floor"],
  [styles.includes("--xl-ease-tide") && styles.includes("--xl-motion-normal") && styles.includes("xl-tide-breathe"), "tidal motion tokens must be wired"],
  [styles.includes('data-theme="lingjing"') && styles.includes('data-theme="poxiao"'), "both Lingjing and Poxiao themes must be defined"],
];

const failures = checks.filter(([passed]) => !passed).map(([, message]) => message);
if (failures.length) {
  console.error(`Human-factors source check failed:\n${failures.map((item) => `- ${item}`).join("\n")}`);
  process.exit(1);
}
console.log(`Human-factors source check: ok (${checks.length} invariants)`);
