import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function pnpmKey(name) {
  return name.startsWith("@") ? name.replace("/", "+") : name;
}

function findInStore(store, name) {
  if (!existsSync(store)) return null;
  const prefix = `${pnpmKey(name)}@`;
  const match = readdirSync(store).find((dir) => dir === prefix.slice(0, -1) || dir.startsWith(prefix));
  if (!match) return null;
  const inner = join(store, match, "node_modules", ...name.split("/"));
  return existsSync(join(inner, "package.json")) ? inner : null;
}

function isResolvable(fromDir, name, stopAt) {
  let current = fromDir;
  while (current.startsWith(stopAt)) {
    if (existsSync(join(current, "node_modules", ...name.split("/"), "package.json"))) return true;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return false;
}

function listPackageJsons(root) {
  const found = [];
  const seen = new Set();
  const stack = [root];
  const enqueue = (dir) => {
    const resolved = resolve(dir);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    stack.push(resolved);
  };
  while (stack.length) {
    const current = stack.pop();
    if (existsSync(join(current, "package.json"))) found.push(join(current, "package.json"));
    const nm = join(current, "node_modules");
    if (!existsSync(nm)) continue;
    let entries;
    try { entries = readdirSync(nm, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.name === ".bin") continue;
      const path = join(nm, entry.name);
      if (entry.name === ".pnpm") {
        let pnpmEntries;
        try { pnpmEntries = readdirSync(path, { withFileTypes: true }); } catch { continue; }
        for (const pkg of pnpmEntries) {
          const innerNm = join(path, pkg.name, "node_modules");
          if (!existsSync(innerNm)) continue;
          let innerEntries;
          try { innerEntries = readdirSync(innerNm, { withFileTypes: true }); } catch { continue; }
          for (const inner of innerEntries) {
            if (inner.name === ".bin") continue;
            if (inner.name.startsWith("@")) {
              const scoped = join(innerNm, inner.name);
              let children;
              try { children = readdirSync(scoped, { withFileTypes: true }); } catch { continue; }
              for (const child of children) enqueue(join(scoped, child.name));
            } else {
              enqueue(join(innerNm, inner.name));
            }
          }
        }
        continue;
      }
      if (entry.name.startsWith("@")) {
        let children;
        try { children = readdirSync(path, { withFileTypes: true }); } catch { continue; }
        for (const child of children) enqueue(join(path, child.name));
      } else {
        enqueue(path);
      }
    }
  }
  return found;
}

export function fillStageDependencies(stageRoot, repoRoot) {
  const store = join(repoRoot, "node_modules", ".pnpm");
  const nodeModules = join(stageRoot, "node_modules");
  if (!existsSync(nodeModules)) throw new Error(`缺少 ${nodeModules}`);
  let copied = 0;
  for (let round = 0; round < 12; round += 1) {
    let added = 0;
    for (const pkgFile of listPackageJsons(stageRoot)) {
      let pkg;
      try { pkg = JSON.parse(readFileSync(pkgFile, "utf8")); } catch { continue; }
      const deps = { ...pkg.dependencies, ...pkg.optionalDependencies };
      const pkgDir = dirname(pkgFile);
      for (const name of Object.keys(deps ?? {})) {
        if (isResolvable(pkgDir, name, stageRoot)) continue;
        if (name.startsWith("@types/")) continue;
        const src = findInStore(store, name);
        if (!src) continue;
        const dest = join(stageRoot, "node_modules", ...name.split("/"));
        if (existsSync(join(dest, "package.json"))) continue;
        try {
          mkdirSync(dirname(dest), { recursive: true });
          cpSync(src, dest, { recursive: true, dereference: true });
          added += 1;
          copied += 1;
        } catch (error) {
          console.warn(`skip ${name}: ${error instanceof Error ? error.message : error}`);
        }
      }
    }
    if (added === 0) break;
  }
  return copied;
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === self) {
  const stageRoot = resolve(process.argv[2] ?? "apps/desktop/stage");
  const repoRoot = resolve(process.argv[3] ?? ".");
  console.log(`copied ${fillStageDependencies(stageRoot, repoRoot)} missing packages into ${stageRoot}`);
}
