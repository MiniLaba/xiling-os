import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const product = JSON.parse(readFileSync(path.join(root, "xiling.product.json"), "utf8"));
const workspace = readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8");
const failures = [];

if (product.activeProduct !== "ai-native-virtual-os") failures.push("活动产品不再是 AI Native Virtual OS");
for (const documentPath of product.canonicalDocs ?? []) {
  try { readFileSync(path.join(root, documentPath), "utf8"); }
  catch { failures.push(`缺少当前产品文档：${documentPath}`); }
}

for (const activePath of product.activeWorkspacePaths) {
  if (!workspace.includes(`- "${activePath}"`)) failures.push(`活动目录未进入 pnpm 白名单：${activePath}`);
}
for (const legacyPath of product.frozenLegacyPaths) {
  if (workspace.includes(`- "${legacyPath}"`)) failures.push(`冻结旧版仍在 pnpm 工作区：${legacyPath}`);
}

const legacyPackages = new Set(product.frozenLegacyPaths.flatMap((item) => {
  const packageFile = path.join(root, item, "package.json");
  try { return [JSON.parse(readFileSync(packageFile, "utf8")).name].filter(Boolean); } catch { return []; }
}));

function filesBelow(directory) {
  const absolute = path.join(root, directory);
  try {
    return readdirSync(absolute).flatMap((name) => {
      const child = path.join(absolute, name);
      if (["node_modules", "dist", "generated"].includes(name)) return [];
      return statSync(child).isDirectory() ? filesBelow(path.relative(root, child)) : [child];
    });
  } catch { return []; }
}

for (const file of product.activeWorkspacePaths.flatMap(filesBelow).filter((item) => /\.[cm]?[jt]sx?$/.test(item))) {
  const content = readFileSync(file, "utf8");
  for (const packageName of legacyPackages) {
    if (content.includes(`from "${packageName}`) || content.includes(`from '${packageName}`) || content.includes(`import("${packageName}`)) {
      failures.push(`${path.relative(root, file)} 导入冻结旧包 ${packageName}`);
    }
  }
}

const registry = readFileSync(path.join(root, "apps/desktop/src/core/app-registry.ts"), "utf8");
if (registry.includes("system.research")) failures.push("通用任务中心仍使用科研专属 system.research ID");
if (!readFileSync(path.join(root, "package.json"), "utf8").includes('"start": "pnpm --filter @xiling/desktop start"')) failures.push("根启动入口不再唯一指向 Desktop V2");

if (failures.length) {
  console.error(`AI Native Virtual OS 产品边界检查失败：\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("AI Native Virtual OS product boundary passed");
