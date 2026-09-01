import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const expected = new Map([
  ["apps/web/src/papers/PaperGraphView.tsx", "f0db600ee302a22702fec045fa6b13d01ab206ab75b95179e8c1e8f074665a9f"],
  ["apps/web/src/project/ProjectView.tsx", "2da7f23578f5fa9d0acc9d8c2530f5ac72a454c902fd4f9b16eed24f1153ae14"],
  ["apps/web/src/wiki/WikiView.tsx", "144240aebc4b5b5577a4cdabc107ebde810fa344f838b277608437bac31ba62d"],
]);

const failures = [];
for (const [path, expectedHash] of expected) {
  const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (hash !== expectedHash) failures.push(`${path} no longer matches 27ebdf7`);
}

const main = readFileSync("apps/web/src/main.tsx", "utf8");
const styles = readFileSync("apps/web/src/styles/legacy-27ebdf7-workspaces.css", "utf8");
if (!main.includes('import "./styles/legacy-27ebdf7-workspaces.css"')) failures.push("legacy workspace compatibility CSS is not loaded");
for (const marker of ["workspace-papers", "workspace-project", "workspace-wiki", "GENERATED from 27ebdf7"]) {
  if (!styles.includes(marker)) failures.push(`legacy workspace CSS is missing ${marker}`);
}

if (failures.length) {
  console.error(`27ebdf7 workspace compatibility check failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  process.exit(1);
}
console.log("27ebdf7 Literature, Project and Wiki compatibility: ok");
