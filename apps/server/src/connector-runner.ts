import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ResourceUri } from "@xiling/contracts";
import type { ConnectorMetadataSummary, OceanConnectorId, OceanSubsetRequest } from "@xiling/domain-ocean";
import type { ConnectorDownloader, ConnectorMetadataProbe } from "@xiling/connectors";
import { dockerSandboxArgs } from "@xiling/execution";

const executeFile = promisify(execFile);
type CredentialResolver = (connectorId: OceanConnectorId) => Record<string, unknown>;
type RunnerResult = { source: "live"; outputs: Array<{ path: string; sha256: string; bytes: number }> };

function validMetadata(value: unknown, provider: OceanConnectorId): value is ConnectorMetadataSummary {
  const item = value as Partial<ConnectorMetadataSummary>;
  return item?.provider === provider && item.source === "live" && Array.isArray(item.selectedShape)
    && typeof item.bytesPerValue === "number" && Array.isArray(item.variables)
    && ["exact", "estimated", "upper_bound", "unknown"].includes(item.estimateKind ?? "")
    && typeof item.estimationMethod === "string" && /^[a-f0-9]{64}$/.test(item.sourceHash ?? "")
    && typeof item.fetchedAt === "string" && (item.estimatedBytes === undefined || (Number.isFinite(item.estimatedBytes) && item.estimatedBytes > 0));
}

function safeRelative(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.includes("\\") && !path.split("/").includes("..");
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function startWithSecretInput(containerId: string, credentials: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("docker", ["start", "--attach", "--interactive", containerId], { stdio: ["pipe", "pipe", "pipe"] });
    let outputBytes = 0; let stderr = "";
    const collect = (chunk: Buffer) => { outputBytes += chunk.byteLength; if (outputBytes > 1024 * 1024) child.kill(); };
    child.stdout.on("data", collect);
    child.stderr.on("data", (chunk: Buffer) => { collect(chunk); if (stderr.length < 8_000) stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolvePromise();
      const lines = stderr.split("\n").map((line) => line.trim()).filter(Boolean);
      const detail = (lines.at(-1) ?? `exit ${code ?? "unknown"}`).replace(/[\r\n]/g, " ").slice(0, 500);
      reject(new Error(`connector Runner failed: ${detail}`));
    });
    child.stdin.end(JSON.stringify(credentials));
    const abort = () => { void executeFile("docker", ["stop", "--time", "5", containerId], { timeout: 10_000 }).catch(() => undefined); };
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  });
}

export class DockerConnectorRunner implements ConnectorDownloader {
  constructor(
    private readonly runsRoot: string,
    private readonly credentials: CredentialResolver,
    private readonly image = "xiling-runner:research-os",
  ) {}

  async download(request: OceanSubsetRequest, _targetUri: ResourceUri, signal?: AbortSignal) {
    const runId = randomUUID(); const runRoot = resolve(this.runsRoot, runId);
    await mkdir(runRoot, { recursive: true });
    const requestPath = join(runRoot, "request.json");
    // The request is secret-free and docker cp preserves the host UID. World-read
    // is required for the non-root (uid 10001) container process; credentials stay on stdin.
    await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
    const created = await executeFile("docker", [
      "create", "--interactive", ...dockerSandboxArgs({ network: "egress", memoryBytes: 4 * 1024 ** 3, cpu: 2 }), this.image,
      "python", "run_connector.py", "--request", "/workspace/request.json", "--workspace", "/workspace", "--mode", "download",
    ], { signal, timeout: 15_000, maxBuffer: 1024 * 1024 });
    const containerId = created.stdout.trim(); if (!containerId) throw new Error("Docker did not return a container id");
    try {
      await executeFile("docker", ["cp", requestPath, `${containerId}:/workspace/request.json`], { signal, timeout: 15_000 });
      await startWithSecretInput(containerId, this.credentials(request.connectorId), signal);
      await executeFile("docker", ["cp", `${containerId}:/workspace/.`, runRoot], { signal, timeout: 20_000 });
    } finally {
      await executeFile("docker", ["rm", "--force", containerId], { timeout: 15_000 }).catch(() => undefined);
    }
    const result = JSON.parse(await readFile(join(runRoot, "connector-result.json"), "utf8")) as RunnerResult;
    if (result.source !== "live" || result.outputs.length === 0 || !result.outputs.every((item) => safeRelative(item.path) && /^[a-f0-9]{64}$/.test(item.sha256) && item.bytes > 0)) {
      throw new Error("connector Runner returned an invalid manifest");
    }
    for (const output of result.outputs) {
      const path = resolve(runRoot, "artifacts", output.path);
      if (await sha256(path) !== output.sha256) throw new Error(`connector Artifact hash mismatch: ${output.path}`);
    }
    if (result.outputs.length !== 1) throw new Error("multi-file connector results require an explicit packaging decision");
    const artifact = result.outputs[0]!;
    return { uri: `artifact://connector/${runId}/${artifact.path}` as ResourceUri, bytes: artifact.bytes, sha256: artifact.sha256 };
  }
}

export class DockerConnectorProbe implements ConnectorMetadataProbe {
  private readonly probeSchemaVersion = 2;
  constructor(
    private readonly cacheRoot: string,
    private readonly credentials: CredentialResolver,
    private readonly image = "xiling-runner:research-os",
    private readonly ttlMs = 15 * 60_000,
  ) {}

  async probe(request: OceanSubsetRequest, signal?: AbortSignal): Promise<ConnectorMetadataSummary> {
    const cacheKey = createHash("sha256").update(`probe-v${this.probeSchemaVersion}:${JSON.stringify(request)}`).digest("hex");
    const cachePath = resolve(this.cacheRoot, "cache", `${cacheKey}.json`);
    try {
      const cached = JSON.parse(await readFile(cachePath, "utf8")) as { cachedAt: number; metadata: ConnectorMetadataSummary };
      if (Date.now() - cached.cachedAt < this.ttlMs && validMetadata(cached.metadata, request.connectorId)) return { ...cached.metadata, source: "cache" };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }

    const probeId = randomUUID(); const probeRoot = resolve(this.cacheRoot, "probes", probeId);
    await mkdir(probeRoot, { recursive: true });
    const requestPath = join(probeRoot, "request.json");
    await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
    const created = await executeFile("docker", [
      "create", "--interactive", ...dockerSandboxArgs({ network: "egress", memoryBytes: 1024 ** 3, cpu: 1, pidsLimit: 128, tmpBytes: 128 * 1024 ** 2 }), this.image,
      "python", "run_connector.py", "--request", "/workspace/request.json", "--workspace", "/workspace", "--mode", "probe",
    ], { signal, timeout: 15_000, maxBuffer: 1024 * 1024 });
    const containerId = created.stdout.trim(); if (!containerId) throw new Error("Docker did not return a container id");
    try {
      await executeFile("docker", ["cp", requestPath, `${containerId}:/workspace/request.json`], { signal, timeout: 15_000 });
      await startWithSecretInput(containerId, this.credentials(request.connectorId), signal);
      await executeFile("docker", ["cp", `${containerId}:/workspace/connector-result.json`, join(probeRoot, "connector-result.json")], { signal, timeout: 15_000 });
    } finally {
      await executeFile("docker", ["rm", "--force", containerId], { timeout: 15_000 }).catch(() => undefined);
    }
    const metadata = JSON.parse(await readFile(join(probeRoot, "connector-result.json"), "utf8")) as unknown;
    if (!validMetadata(metadata, request.connectorId)) throw new Error("connector metadata Runner returned an invalid summary");
    await mkdir(resolve(this.cacheRoot, "cache"), { recursive: true });
    await writeFile(cachePath, `${JSON.stringify({ cachedAt: Date.now(), metadata }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return metadata;
  }
}
