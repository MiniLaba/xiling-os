import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const commands = [
  ["pnpm", ["typecheck"]],
  ["pnpm", ["test"]],
  ["pnpm", ["--filter", "@xiling/web", "build"]],
  ["pnpm", ["--filter", "@xiling/server", "build"]],
  ["node", ["scripts/gate-4.5-b-agent-center-smoke.mjs"]],
  ["node", ["scripts/gate-4.5-d-main-path-smoke.mjs"]],
  ["node", ["scripts/mcp-adapter-smoke.mjs"]],
  ["node", ["scripts/research-graph-smoke.mjs"]],
  ["node", ["scripts/platform-smoke.mjs"]],
  ["node", ["scripts/ui-dom-smoke.mjs"]],
  ["node", ["scripts/web-human-factors-check.mjs"]],
  ["node", ["scripts/desktop-smoke.mjs"]],
];

for (const [command, args] of commands) {
  const useCurrentPnpm = command === "pnpm" && process.env.npm_execpath;
  const executable = useCurrentPnpm ? process.execPath : command;
  const executableArgs = useCurrentPnpm ? [process.env.npm_execpath, ...args] : args;
  const result = spawnSync(executable, executableArgs, { stdio: "inherit", shell: false });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const webIndex = readFileSync(resolve("apps/web/dist/index.html"), "utf8");
const builtAssets = [...webIndex.matchAll(/(?:src|href)="\/(assets\/[^"]+)"/g)].map((match) => match[1]);
if (builtAssets.length === 0 || builtAssets.some((asset) => !existsSync(resolve("apps/web/dist", asset)))) {
  console.error("Web asset smoke failed: index.html references a missing hashed asset.");
  process.exit(1);
}
console.log(`Web asset manifest smoke: ok (${builtAssets.length} entry assets)`);

const image = spawnSync("docker", ["image", "inspect", "xiling-runner:research-os"], { stdio: "ignore", shell: false });
if (image.status === 0) {
  const runner = spawnSync("docker", ["run", "--rm", "--network", "none", "xiling-runner:research-os", "python", "smoke.py"], {
    stdio: "inherit",
    shell: false,
  });
  if (runner.status !== 0) process.exit(runner.status ?? 1);
  const ocean = spawnSync("docker", ["run", "--rm", "--network", "none", "xiling-runner:research-os", "python", "ocean_smoke.py"], {
    stdio: "inherit",
    shell: false,
  });
  if (ocean.status !== 0) process.exit(ocean.status ?? 1);
} else {
  console.log("Runner image unavailable; offline TypeScript smoke continues. Build xiling-runner:research-os for container checks.");
}

const connectorImage = spawnSync("docker", ["image", "inspect", "xiling-runner:research-os"], { stdio: "ignore", shell: false });
if (connectorImage.status === 0) {
  const connector = spawnSync("docker", ["run", "--rm", "--network", "none", "xiling-runner:research-os", "python", "connector_smoke.py"], { stdio: "inherit", shell: false });
  if (connector.status !== 0) process.exit(connector.status ?? 1);
} else {
  console.log("Research OS Runner image unavailable; connector smoke remains host-offline. Build xiling-runner:research-os for official-client import checks.");
}

console.log("XiLing unified smoke: ok");
