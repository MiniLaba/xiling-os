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

/** Wall-clock ceiling for one live download; slow providers are still bounded. */
export const CONNECTOR_DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
/** Wall-clock ceiling for one metadata probe. */
export const CONNECTOR_PROBE_TIMEOUT_MS = 2 * 60_000;

function redactSecrets(text: string, credentials: Record<string, unknown>): string {
  let redacted = text;
  for (const value of Object.values(credentials)) {
    if (typeof value === "string" && value.length >= 4) redacted = redacted.split(value).join("***");
  }
  return redacted;
}

/**
 * Resolves the immutable image ID behind the configured tag so a retagged
 * local image cannot silently replace the environment that was approved.
 */
async function pinnedImageId(image: string): Promise<string> {
  const inspected = await executeFile("docker", ["image", "inspect", "--format", "{{.Id}}", image], { timeout: 10_000, maxBuffer: 4096 });
  const id = inspected.stdout.trim();
  return /^sha256:[a-f0-9]{64}$/.test(id) ? id : image;
}

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

function startWithSecretInput(containerId: string, credentials: Record<string, unknown>, signal?: AbortSignal, timeoutMs = CONNECTOR_DOWNLOAD_TIMEOUT_MS): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("docker", ["start", "--attach", "--interactive", containerId], { stdio: ["pipe", "pipe", "pipe"] });
    let outputBytes = 0; let stderr = "";
    const collect = (chunk: Buffer) => { outputBytes += chunk.byteLength; if (outputBytes > 1024 * 1024) child.kill(); };
    child.stdout.on("data", collect);
    child.stderr.on("data", (chunk: Buffer) => { collect(chunk); if (stderr.length < 8_000) stderr += chunk.toString("utf8"); });
    const abort = () => { void executeFile("docker", ["stop", "--time", "5", containerId], { timeout: 10_000 }).catch(() => undefined); };
    const settle = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    const timer = setTimeout(() => { abort(); settle(); reject(new Error(`connector Runner timed out after ${Math.round(timeoutMs / 1000)}s`)); }, timeoutMs);
    timer.unref?.();
    child.on("error", (error) => { settle(); reject(error); });
    child.on("close", (code) => {
      if (code === 0) { settle(); return resolvePromise(); }
      const lines = stderr.split("\n").map((line) => line.trim()).filter(Boolean);
      const detail = (lines.at(-1) ?? `exit ${code ?? "unknown"}`).replace(/[\r\n]/g, " ").slice(0, 500);
      settle();
      reject(new Error(`connector Runner failed: ${redactSecrets(detail, credentials)}`));
    });
    child.stdin.end(JSON.stringify(credentials));
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  });
}

export class DockerConnectorRunner implements ConnectorDownloader {
  constructor(
    private readonly runsRoot: string,
    private readonly credentials: CredentialResolver,
    private readonly image = "xiling-runner:research-os",
  ) {}

  async download(request: OceanSubsetRequest, _targetUri: ResourceUri, signal?: AbortSignal, _executionMode?: "fixture" | "live", limits?: { maxBytes?: number; timeoutMs?: number }) {
    const runId = randomUUID(); const runRoot = resolve(this.runsRoot, runId);
    await mkdir(runRoot, { recursive: true });
    const requestPath = join(runRoot, "request.json");
    // The request is secret-free and docker cp preserves the host UID. World-read
    // is required for the non-root (uid 10001) container process; credentials stay on stdin.
    await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
    const image = await pinnedImageId(this.image);
    const maxBytes = limits?.maxBytes;
    const created = await executeFile("docker", [
      "create", "--interactive", ...dockerSandboxArgs({ network: "egress", memoryBytes: 4 * 1024 ** 3, cpu: 2 }), image,
      "python", "run_connector.py", "--request", "/workspace/request.json", "--workspace", "/workspace", "--mode", "download",
      ...(maxBytes === undefined ? [] : ["--max-bytes", String(Math.max(maxBytes, 1024 * 1024))]),
    ], { signal, timeout: 15_000, maxBuffer: 1024 * 1024 });
    const containerId = created.stdout.trim(); if (!containerId) throw new Error("Docker did not return a container id");
    try {
      await executeFile("docker", ["cp", requestPath, `${containerId}:/workspace/request.json`], { signal, timeout: 15_000 });
      await startWithSecretInput(containerId, this.credentials(request.connectorId), signal, limits?.timeoutMs ?? CONNECTOR_DOWNLOAD_TIMEOUT_MS);
      await executeFile("docker", ["cp", `${containerId}:/workspace/.`, runRoot], { signal, timeout: 20_000 });
    } finally {
      await executeFile("docker", ["rm", "--force", containerId], { timeout: 15_000 }).catch((error) => console.warn(`[xiling] sandbox cleanup failed for ${containerId}: ${error instanceof Error ? error.message : error}`));
    }
    const result = JSON.parse(await readFile(join(runRoot, "connector-result.json"), "utf8")) as RunnerResult;
    if (result.source !== "live" || result.outputs.length === 0 || !result.outputs.every((item) => safeRelative(item.path) && /^[a-f0-9]{64}$/.test(item.sha256) && item.bytes > 0)) {
      throw new Error("connector Runner returned an invalid manifest");
    }
    // The approval locked a volume estimate; a download past it must not survive.
    if (maxBytes !== undefined && result.outputs.some((item) => item.bytes > maxBytes)) throw new Error("connector download exceeded the approved volume estimate");
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
    const image = await pinnedImageId(this.image);
    const created = await executeFile("docker", [
      "create", "--interactive", ...dockerSandboxArgs({ network: "egress", memoryBytes: 1024 ** 3, cpu: 1, pidsLimit: 128, tmpBytes: 128 * 1024 ** 2 }), image,
      "python", "run_connector.py", "--request", "/workspace/request.json", "--workspace", "/workspace", "--mode", "probe",
    ], { signal, timeout: 15_000, maxBuffer: 1024 * 1024 });
    const containerId = created.stdout.trim(); if (!containerId) throw new Error("Docker did not return a container id");
    try {
      await executeFile("docker", ["cp", requestPath, `${containerId}:/workspace/request.json`], { signal, timeout: 15_000 });
      await startWithSecretInput(containerId, this.credentials(request.connectorId), signal, CONNECTOR_PROBE_TIMEOUT_MS);
      await executeFile("docker", ["cp", `${containerId}:/workspace/connector-result.json`, join(probeRoot, "connector-result.json")], { signal, timeout: 15_000 });
    } finally {
      await executeFile("docker", ["rm", "--force", containerId], { timeout: 15_000 }).catch((error) => console.warn(`[xiling] sandbox cleanup failed for ${containerId}: ${error instanceof Error ? error.message : error}`));
    }
    const metadata = JSON.parse(await readFile(join(probeRoot, "connector-result.json"), "utf8")) as unknown;
    if (!validMetadata(metadata, request.connectorId)) throw new Error("connector metadata Runner returned an invalid summary");
    await mkdir(resolve(this.cacheRoot, "cache"), { recursive: true });
    await writeFile(cachePath, `${JSON.stringify({ cachedAt: Date.now(), metadata }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return metadata;
  }
}
