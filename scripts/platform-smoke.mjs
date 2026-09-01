import { readFileSync } from "node:fs";

const required = [
  "scripts/smoke.ps1",
  "scripts/windows/install.ps1",
  "scripts/windows/xiling-doctor.ps1",
  "scripts/windows/xiling-import.ps1",
  "scripts/windows/xiling-start.ps1",
  "scripts/windows/xiling-stop.ps1",
  "scripts/start.mjs",
  "scripts/smoke.sh",
  "scripts/xiling-start.sh",
];

for (const path of required) {
  const content = readFileSync(path, "utf8");
  if (content.includes("\r\n")) throw new Error(`${path} must use LF line endings`);
  if (content.includes("\uFFFD")) throw new Error(`${path} is not valid UTF-8`);
}

const doctor = readFileSync("scripts/windows/xiling-doctor.ps1", "utf8");
for (const check of ["node.exe", "pnpm.cmd", "docker.exe", "Get-NetTCPConnection", "Get-PSDrive", "VirtualizationFirmwareEnabled", "docker-linux", "data-root", "network-config"]) {
  if (!doctor.includes(check)) throw new Error(`Windows Doctor is missing ${check}`);
}
for (const path of required.filter((path) => path.startsWith("scripts/windows/"))) {
  if (/\bwsl(?:\.exe)?\b/i.test(readFileSync(path, "utf8"))) throw new Error(`${path} must not depend on WSL`);
}

const launcher = readFileSync("scripts/start.mjs", "utf8");
for (const behavior of ["waitUntilHealthy", "browserCommand", "XILING_NO_BROWSER", "xiling-server.pid"]) {
  if (!launcher.includes(behavior)) throw new Error(`Cross-platform launcher is missing ${behavior}`);
}

const readme = readFileSync("README.md", "utf8");
const quickStart = "git clone --depth 1 https://github.com/MiniLaba/xiling-os.git && cd xiling-os && corepack pnpm install --frozen-lockfile && corepack pnpm start";
if (!readme.includes(quickStart)) throw new Error("README must keep the verified one-line clone/install/start command");
const packageManifest = JSON.parse(readFileSync("package.json", "utf8"));
if (packageManifest.scripts?.start !== "pnpm build && node scripts/start.mjs") throw new Error("One-line quick start must terminate in the health-checked cross-platform launcher");

for (const path of ["apps/server/src/research-runner.ts", "apps/server/src/connector-runner.ts"]) {
  const source = readFileSync(path, "utf8");
  if (!source.includes("dockerSandboxArgs")) throw new Error(`${path} must use the shared scientific sandbox policy`);
  if (source.includes('"--cap-drop"') || source.includes('"--security-opt"')) throw new Error(`${path} must not duplicate sandbox flags`);
}

console.log("Cross-platform entrypoint smoke: ok");
