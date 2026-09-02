import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const repositoryRoot = path.resolve(process.cwd(), "../..");
const activeFiles = [
  "package.json",
  "pnpm-workspace.yaml",
  ".github/workflows/ci.yml",
  "apps/desktop/package.json",
  "apps/desktop/src/main.ts",
  "apps/desktop/src/preload.ts",
  "apps/desktop/src/core-entry.ts",
];

for (const file of activeFiles) {
  const content = await readFile(path.join(repositoryRoot, file), "utf8");
  if (/docker/i.test(content)) throw new Error(`Active Desktop V2 path references a removed container dependency: ${file}`);
}

console.log("Desktop V2 active runtime is container-independent");
