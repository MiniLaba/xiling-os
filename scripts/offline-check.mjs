import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";

const root = resolve(import.meta.dirname, "..");
const node = process.execPath;
const rootRequire = createRequire(resolve(root, "package.json"));
const webRequire = createRequire(resolve(root, "apps/web/package.json"));
const tsc = rootRequire.resolve("typescript/bin/tsc");
const vitest = resolve(dirname(rootRequire.resolve("vitest/package.json")), "vitest.mjs");
const vite = resolve(dirname(webRequire.resolve("vite/package.json")), "bin/vite.js");

for (const dependency of [tsc, vitest, vite]) {
  if (!existsSync(dependency)) {
    console.error(`Offline check requires an existing frozen install: missing ${dependency}`);
    process.exit(2);
  }
}

function run(label, executable, args, options = {}) {
  console.log(`\n[offline-check] ${label}`);
  const result = spawnSync(executable, args, {
    cwd: options.cwd ?? root,
    stdio: "inherit",
    shell: false,
    env: { ...process.env, XILING_OFFLINE_CHECK: "1", NO_UPDATE_NOTIFIER: "1" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const nodeChecks = [
  "scripts/architecture-check.mjs",
  "scripts/design-doc-check.mjs",
  "scripts/pi-compatibility-check.mjs",
  "scripts/compliance.mjs",
];
for (const script of nodeChecks) run(script, node, [script]);

// Build the dependency-free contract first. All other domain packages may then
// resolve their public @xiling/contracts export without invoking pnpm or a registry.
run("build packages/contracts", node, [tsc, "-p", "packages/contracts/tsconfig.json"]);
const packages = [
  "agent-harness",
  "artifacts",
  "execution",
  "science-domains",
  "domain-ocean",
  "domain-tabular",
  "api-contracts",
  "connectors",
  "context",
  "credentials",
  "knowledge",
  "literature",
  "multi-agent",
  "pi-runtime",
  "platform",
  "research-graph",
];
for (const name of packages) run(`build packages/${name}`, node, [tsc, "-p", `packages/${name}/tsconfig.json`]);

run("typecheck apps/server", node, [tsc, "-p", "apps/server/tsconfig.json", "--noEmit", "--pretty", "false"]);
run("typecheck apps/web", node, [tsc, "-b", "apps/web/tsconfig.json", "--pretty", "false"]);
run("tests", node, [vitest, "run"]);
run("build apps/server", node, [tsc, "-p", "apps/server/tsconfig.json"]);
run("build apps/web", node, [vite, "build"], { cwd: resolve(root, "apps/web") });

const smokes = [
  "scripts/gate-4.5-b-agent-center-smoke.mjs",
  "scripts/gate-4.5-d-main-path-smoke.mjs",
  "scripts/mcp-adapter-smoke.mjs",
  "scripts/research-graph-smoke.mjs",
  "scripts/platform-smoke.mjs",
  "scripts/web-human-factors-check.mjs",
];
for (const script of smokes) run(script, node, [script]);

console.log("\nXiLing deterministic offline check: ok");
console.log("Runner container and real Windows + Docker checks remain separate release gates.");
