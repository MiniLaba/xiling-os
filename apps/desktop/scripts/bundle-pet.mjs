import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
spawnSync(process.execPath, [resolve(root, "scripts/generate-icon.mjs")], { cwd: root, stdio: "inherit" });
mkdirSync(resolve(root, "pet/dist"), { recursive: true });

await build({
  absWorkingDir: root,
  entryPoints: [resolve(root, "pet/src/main.ts")],
  outfile: resolve(root, "pet/dist/pet.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["chrome120"],
  sourcemap: true,
  logLevel: "info",
});
