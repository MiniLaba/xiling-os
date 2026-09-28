import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baseline = JSON.parse(readFileSync(resolve(root, "packages/pi-runtime/pi-compatibility.json"), "utf8"));
const core = JSON.parse(readFileSync(resolve(root, "packages/pi-runtime/node_modules/@earendil-works/pi-agent-core/package.json"), "utf8"));
const ai = JSON.parse(readFileSync(resolve(root, "packages/pi-runtime/node_modules/@earendil-works/pi-ai/package.json"), "utf8"));
const codingAgent = JSON.parse(readFileSync(resolve(root, "packages/pi-runtime/node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8"));
const mcpAdapter = JSON.parse(readFileSync(resolve(root, "packages/pi-runtime/node_modules/pi-mcp-adapter/package.json"), "utf8"));
const failures = [];

if (core.version !== baseline.agentCore) failures.push(`pi-agent-core ${core.version} != reviewed baseline ${baseline.agentCore}`);
if (ai.version !== baseline.ai) failures.push(`pi-ai ${ai.version} != reviewed baseline ${baseline.ai}`);
if (codingAgent.version !== baseline.codingAgent) failures.push(`pi-coding-agent ${codingAgent.version} != reviewed baseline ${baseline.codingAgent}`);
if (mcpAdapter.version !== baseline.mcpAdapter) failures.push(`pi-mcp-adapter ${mcpAdapter.version} != reviewed baseline ${baseline.mcpAdapter}`);
if (core.version !== ai.version || core.version !== codingAgent.version) failures.push(`Pi packages must move in lockstep: core=${core.version}, ai=${ai.version}, coding-agent=${codingAgent.version}`);

function sourceFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = resolve(directory, name);
    if (statSync(path).isDirectory()) {
      if (["dist", "node_modules"].includes(name)) return [];
      return sourceFiles(path);
    }
    return /\.(?:ts|tsx|mjs)$/.test(name) ? [path] : [];
  });
}

for (const scope of [resolve(root, "apps"), resolve(root, "packages")]) {
  for (const path of sourceFiles(scope)) {
    const source = readFileSync(path, "utf8");
    if (!source.includes("@earendil-works/pi")) continue;
    const local = relative(root, path).replaceAll("\\", "/");
    if (!local.startsWith("packages/pi-runtime/")) failures.push(`${local} bypasses @xiling/pi-runtime`);
    if (/[@/]earendil-works\/pi[^"']*\/dist\//.test(source)) failures.push(`${local} imports a private Pi dist path`);
  }
}

if (failures.length) {
  console.error(`Pi compatibility boundary failed:\n${failures.map((item) => `- ${item}`).join("\n")}`);
  process.exit(1);
}

console.log(`Pi compatibility: ok (core ${core.version}, ai ${ai.version}, coding-agent ${codingAgent.version}, mcp-adapter ${mcpAdapter.version}, session v${baseline.sessionFormat})`);
