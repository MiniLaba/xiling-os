import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const designPath = resolve(root, "DESIGN.md");
const readmePath = resolve(root, "README.md");
const docsIndexPath = resolve(root, "docs/README.md");
const adrIndexPath = resolve(root, "docs/adr/README.md");

if (!existsSync(designPath)) throw new Error("DESIGN.md is required at the repository root");
if (!existsSync(docsIndexPath)) throw new Error("docs/README.md is required as the documentation index");
if (!existsSync(adrIndexPath)) throw new Error("docs/adr/README.md is required as the ADR index");
const design = readFileSync(designPath, "utf8");
const readme = readFileSync(readmePath, "utf8");
if (!readme.includes("[活设计文档](DESIGN.md)")) throw new Error("README.md must link to DESIGN.md as the living design entrypoint");

const requiredSections = [
  "## 1. 产品目标",
  "## 3. 总体架构",
  "## 4. 仓库结构与所有权",
  "## 5. 核心领域对象与数据所有权",
  "## 6. 关键运行流程",
  "## 11. 持久化、一致性与恢复",
  "## 14. 已知风险与后续边界",
  "## 15. 文档维护规则",
  "## 17. 变更记录",
];
for (const section of requiredSections) if (!design.includes(section)) throw new Error(`DESIGN.md is missing required section: ${section}`);

function validateMarkdownLinks(filePath) {
  const markdown = readFileSync(filePath, "utf8");
  const links = [...markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => match[1]);
  for (const target of links) {
    if (!target || target.startsWith("http://") || target.startsWith("https://") || target.startsWith("#")) continue;
    const path = target.split("#", 1)[0];
    if (path && !existsSync(resolve(dirname(filePath), decodeURIComponent(path)))) {
      throw new Error(`${basename(filePath)} contains a broken local link: ${target}`);
    }
  }
  return links.length;
}

const indexedDocuments = [readmePath, designPath, docsIndexPath, adrIndexPath];
const checkedLinks = indexedDocuments.reduce((sum, filePath) => sum + validateMarkdownLinks(filePath), 0);

const adrFiles = readdirSync(resolve(root, "docs/adr")).filter((name) => /^\d{4}-.*\.md$/.test(name));
const adrNumbers = new Map();
for (const filename of adrFiles) {
  const number = filename.slice(0, 4);
  const existing = adrNumbers.get(number);
  if (existing) throw new Error(`ADR number ${number} is duplicated by ${existing} and ${filename}`);
  adrNumbers.set(number, filename);
}

console.log(
  `Living design documents: ok (${requiredSections.length} required sections, ${indexedDocuments.length} indexes, ${checkedLinks} links, ${adrFiles.length} unique ADRs)`,
);
