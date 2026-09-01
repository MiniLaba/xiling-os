import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const pnpmStore = resolve(root, "node_modules/.pnpm");
const postcssPackage = readdirSync(pnpmStore).find((name) => name.startsWith("postcss@"));
if (!postcssPackage) throw new Error("postcss is required to restore the 27ebdf7 workspace styles");
const { default: postcss } = await import(pathToFileURL(resolve(pnpmStore, postcssPackage, "node_modules/postcss/lib/postcss.mjs")).href);

const targetSelector = /(?:literature-start|paper-[\w-]+|graph-utility|year-legend|algorithm-note|project-[\w-]+|board-column|inline-create|item-create|record-[\w-]+|research-workflow-card|workflow-[\w-]+|knowledge-wiki|wiki-[\w-]+)/;
const workspaceScope = ":where(.workspace-papers, .workspace-project, .workspace-wiki)";

function filterContainer(source) {
  const output = postcss.root();
  for (const node of source.nodes ?? []) {
    if (node.type === "rule") {
      const selectors = node.selectors
        .filter((selector) => targetSelector.test(selector) && !selector.includes("project-switcher"))
        .map((selector) => `${workspaceScope} ${selector}`);
      if (selectors.length) {
        const clone = node.clone();
        clone.selectors = selectors;
        output.append(clone);
      }
      continue;
    }
    if (node.type === "atrule" && node.nodes) {
      const children = filterContainer(node);
      if (children.nodes.length) {
        const clone = node.clone({ nodes: [] });
        clone.append(children.nodes);
        output.append(clone);
      }
    }
  }
  return output;
}

const sources = ["apps/web/src/styles.css", "apps/web/src/styles-workbench.css"];
const restored = sources.map((path) => {
  const css = execFileSync("git", ["show", `27ebdf7:${path}`], { cwd: root, encoding: "utf8" });
  return filterContainer(postcss.parse(css, { from: `${path}@27ebdf7` })).toString();
});

const header = `/* GENERATED from 27ebdf7 by scripts/restore-27ebdf7-workspace-styles.mjs.
   This compatibility layer intentionally applies only to Literature, Project and Wiki. */
:is(.literature-start, .paper-graph-view, .project-management, .project-composite, .project-workflow-dashboard, .knowledge-wiki) {
  --ink: #131b2b;
  --line: #e2e7ef;
  --line-strong: #cfd7e3;
  --wash: #f6f8fb;
  --hf-caption: 12px;
  --hf-control: 13px;
  --hf-body: 14px;
  --hf-section: 18px;
  --hf-title: 26px;
  --hf-hit: 38px;
  --hf-line: #dde3e6;
  --hf-muted: #667681;
  --hf-accent: #3478c7;
  --type-caption: 11px;
  --type-meta: 12px;
  --type-control: 13px;
  --type-body: 14px;
  --type-section: 20px;
}

`;

const currentStyles = postcss.parse(readFileSync(resolve(root, "apps/web/src/styles/views.css"), "utf8"));
const resetSelectors = new Set();
currentStyles.walkRules((rule) => {
  for (const selector of rule.selectors) {
    if (targetSelector.test(selector) && !selector.includes("project-switcher")) resetSelectors.add(`${workspaceScope} ${selector}`);
  }
});
const resets = `/* Remove properties introduced after 27ebdf7 before replaying the preserved cascade. */\n${[...resetSelectors].map((selector) => `${selector} { all: revert; box-sizing: border-box; }`).join("\n")}\n\n/* The old views were grid-row children; this is the only adapter to the current flex workspace shell. */\n${workspaceScope} .workspace-body > :is(.literature-start, .paper-graph-view, .project-management, .project-composite, .project-workflow-dashboard, .knowledge-wiki) { flex: 1; width: 100%; min-height: 0; }\n${workspaceScope} :is(.literature-start, .paper-graph-view, .project-management, .project-composite, .project-workflow-dashboard, .knowledge-wiki) { font-family: Inter, "PingFang SC", "Microsoft YaHei", sans-serif; color: #102b35; }\n${workspaceScope} :is(.literature-start, .paper-graph-view, .project-management, .project-composite, .project-workflow-dashboard, .knowledge-wiki) :is(button, input, textarea, select) { font: inherit; }\n${workspaceScope} :is(.literature-start, .paper-graph-view, .project-management, .project-composite, .project-workflow-dashboard, .knowledge-wiki) button { cursor: pointer; }\n\n`;

writeFileSync(resolve(root, "apps/web/src/styles/legacy-27ebdf7-workspaces.css"), `${header}${resets}${restored.join("\n\n")}\n`);
console.log("Restored isolated 27ebdf7 styles for Literature, Project and Wiki");
