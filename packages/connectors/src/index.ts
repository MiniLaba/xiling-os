import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ResourceUri } from "@xiling/contracts";
import type { ConnectorDescriptor, ConnectorDownloadJob, ConnectorMetadataSummary, ConnectorPreflight, OceanConnectorId, OceanSubsetRequest } from "@xiling/domain-ocean";

const descriptors: Record<OceanConnectorId, ConnectorDescriptor> = {
  erddap: {
    id: "erddap",
    title: "ERDDAP / OPeNDAP",
    officialClient: "ERDDAP REST griddap/tabledap",
    authentication: "none",
    capabilities: ["metadata", "variable", "bbox", "depth", "time", "NetCDF", "CSV"],
    documentationUrl: "https://coastwatch.noaa.gov/erddap/griddap/documentation.html",
  },
  "argo-gdac": {
    id: "argo-gdac",
    title: "Argo Global Data Assembly Centres",
    officialClient: "Argo GDAC index + HTTPS NetCDF",
    authentication: "none",
    capabilities: ["profile-index", "bbox", "time", "quality-mode", "NetCDF"],
    documentationUrl: "https://argo.ucsd.edu/data/data-from-gdacs/",
  },
  "copernicus-marine": {
    id: "copernicus-marine",
    title: "Copernicus Marine Data Store",
    officialClient: "copernicusmarine subset",
    authentication: "account",
    capabilities: ["metadata", "variable", "bbox", "depth", "time", "NetCDF", "Zarr"],
    documentationUrl: "https://toolbox-docs.marine.copernicus.eu/en/stable/command-line-interface.html",
  },
  "nasa-harmony": {
    id: "nasa-harmony",
    title: "NASA Earthdata Harmony",
    officialClient: "Harmony-Py / OGC API EDR",
    authentication: "earthdata",
    capabilities: ["capabilities", "variable", "bbox", "depth", "time", "reprojection", "NetCDF"],
    documentationUrl: "https://harmony.earthdata.nasa.gov/docs",
  },
};

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function validate(request: OceanSubsetRequest): void {
  if (!request.datasetId.trim()) throw new Error("datasetId is required");
  if (request.variables.length === 0 || request.variables.some((item) => !item.trim())) throw new Error("at least one variable is required");
  const { west, east, south, north } = request.region;
  if (west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north) throw new Error("invalid geographic bounds");
  if (request.time.start > request.time.end) throw new Error("invalid time range");
  if (request.depth && (request.depth.min < 0 || request.depth.min > request.depth.max)) throw new Error("invalid depth range");
  if (request.expectedShape?.some((size) => !Number.isInteger(size) || size <= 0)) throw new Error("invalid expected shape");
  // Magnitude caps keep a hostile or broken shape from producing Infinity-style
  // estimates that would flow into the approval disclosure unchanged.
  if (request.expectedShape?.some((size) => size > 1e9) || (request.bytesPerValue !== undefined && (request.bytesPerValue <= 0 || request.bytesPerValue > 1024))) throw new Error("expected shape or byte scale is out of range");
}

function estimate(request: OceanSubsetRequest): number | undefined {
  if (!request.expectedShape || !request.bytesPerValue) return undefined;
  const total = request.expectedShape.reduce((total, size) => total * Math.min(size, 1e9), request.variables.length * request.bytesPerValue);
  return Number.isFinite(total) && total <= Number.MAX_SAFE_INTEGER ? total : undefined;
}

export function listConnectors(): ConnectorDescriptor[] {
  return Object.values(descriptors).map((descriptor) => structuredClone(descriptor));
}

/** Single canonical request hasher shared by the connector jobs and the
 * project workflow so an approved hash is reproducible across both layers. */
export function canonicalRequestHash(request: OceanSubsetRequest): string {
  return createHash("sha256").update(canonical(request)).digest("hex");
}

export function preflightConnector(request: OceanSubsetRequest): ConnectorPreflight {
  validate(request);
  const connector = descriptors[request.connectorId];
  const requestHash = createHash("sha256").update(canonical(request)).digest("hex");
  const estimatedBytes = estimate(request);
  const targetUri = `artifact://downloads/${requestHash}` as ResourceUri;
  const encodedId = encodeURIComponent(request.datasetId);
  let metadataProbe: ConnectorPreflight["metadataProbe"];
  if (request.connectorId === "erddap") {
    metadataProbe = { method: "GET", endpoint: `https://coastwatch.noaa.gov/erddap/info/${encodedId}/index.json` };
  } else if (request.connectorId === "argo-gdac") {
    metadataProbe = { method: "GET", endpoint: "https://data-argo.ifremer.fr/ar_index_global_prof.txt.gz" };
  } else if (request.connectorId === "copernicus-marine") {
    metadataProbe = { method: "CLI", endpoint: "copernicusmarine", argv: ["describe", "--dataset-id", request.datasetId, "--return-fields", "all"] };
  } else {
    metadataProbe = { method: "GET", endpoint: `https://harmony.earthdata.nasa.gov/capabilities?collectionId=${encodedId}&version=2` };
  }
  const status = connector.authentication === "none"
    ? estimatedBytes === undefined ? "metadata_required" : "ready"
    : "credentials_required";
  return {
    requestHash,
    connector: structuredClone(connector),
    status,
    metadataProbe,
    ...(estimatedBytes === undefined ? {} : { estimatedBytes }),
    targetUri,
    approvalRisks: ["network", "write"],
    disclosure: [
      `${request.variables.length} variables; ${request.time.start} to ${request.time.end}`,
      `${request.region.west},${request.region.south} → ${request.region.east},${request.region.north}`,
      estimatedBytes === undefined ? "volume pending remote metadata" : `estimated ${estimatedBytes} bytes`,
      `destination ${targetUri}`,
    ],
  };
}

export function resolveConnectorMetadata(request: OceanSubsetRequest, metadata: ConnectorMetadataSummary, credentialsAvailable = false): ConnectorPreflight {
  if (!/^[a-f0-9]{64}$/.test(metadata.sourceHash)) throw new Error("invalid metadata source hash");
  const resolved = preflightConnector(request);
  const ready = resolved.connector.authentication === "none" || credentialsAvailable;
  const estimatedBytes = metadata.estimatedBytes;
  const status = !ready ? "credentials_required" : estimatedBytes === undefined || metadata.estimateKind === "unknown" ? "metadata_required" : "ready";
  return {
    ...resolved,
    status,
    ...(estimatedBytes === undefined ? {} : { estimatedBytes }),
    disclosure: [
      ...resolved.disclosure.filter((item) => !item.startsWith("volume ")),
      estimatedBytes === undefined ? "volume unavailable; approval is blocked" : `${metadata.estimateKind} volume ${estimatedBytes} bytes via ${metadata.estimationMethod}`,
      `metadata ${metadata.sourceHash.slice(0, 12)} at ${metadata.fetchedAt}`,
    ],
  };
}

export interface ConnectorDownloadLimits {
  /** Hard ceiling from the approved volume estimate; downloads past it must fail. */
  maxBytes?: number;
  /** Wall-clock ceiling for the whole download. */
  timeoutMs?: number;
}

export interface ConnectorDownloader {
  download(request: OceanSubsetRequest, targetUri: ResourceUri, signal?: AbortSignal, executionMode?: "fixture" | "live", limits?: ConnectorDownloadLimits): Promise<{ uri: ResourceUri; bytes: number; sha256: string }>;
}

export interface ConnectorMetadataProbe {
  probe(request: OceanSubsetRequest, signal?: AbortSignal): Promise<ConnectorMetadataSummary>;
}

/** Offline-only boundary used by smoke tests and the development UI. It never claims
 * to have contacted a scientific data provider. Production adapters implement the
 * same two narrow interfaces inside the controlled Runner container. */
export class FixtureConnectorAdapter implements ConnectorMetadataProbe, ConnectorDownloader {
  constructor(private readonly artifactRoot: string, private readonly now = () => new Date().toISOString()) {}

  async probe(request: OceanSubsetRequest, signal?: AbortSignal): Promise<ConnectorMetadataSummary> {
    validate(request);
    if (signal?.aborted) throw signal.reason ?? new Error("metadata probe cancelled");
    const selectedShape = request.connectorId === "argo-gdac" ? [2, 8, 21] : [1, 21, 21];
    const bytesPerValue = 4;
    const payload = { connectorId: request.connectorId, datasetId: request.datasetId, variables: request.variables, selectedShape, bytesPerValue };
    return {
      selectedShape,
      bytesPerValue,
      variables: request.variables.map((name) => ({ name, units: name.toUpperCase().includes("TEMP") || name.includes("sst") ? "degree_Celsius" : "unknown" })),
      estimateKind: "exact",
      estimatedBytes: selectedShape.reduce((total, size) => total * size, request.variables.length * bytesPerValue),
      estimationMethod: "fixed offline fixture shape",
      sourceHash: createHash("sha256").update(canonical(payload)).digest("hex"),
      fetchedAt: this.now(),
      source: "fixture",
      provider: request.connectorId,
    };
  }

  async download(request: OceanSubsetRequest, _targetUri: ResourceUri, signal?: AbortSignal) {
    validate(request);
    if (signal?.aborted) throw signal.reason ?? new Error("download cancelled");
    const content = Buffer.from(`${JSON.stringify({ fixture: true, warning: "Not scientific data", request }, null, 2)}\n`);
    const digest = createHash("sha256").update(content).digest("hex");
    await mkdir(this.artifactRoot, { recursive: true });
    await writeFile(resolve(this.artifactRoot, `${digest}.json`), content);
    return { uri: `artifact://connector-fixture/${digest}` as ResourceUri, bytes: content.byteLength, sha256: digest };
  }
}

export class JsonConnectorJobRepository {
  constructor(private readonly path: string) {}
  async load(): Promise<ConnectorDownloadJob[]> {
    try { return JSON.parse(await readFile(this.path, "utf8")) as ConnectorDownloadJob[]; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  async save(jobs: ConnectorDownloadJob[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(jobs, null, 2)}\n`, "utf8");
    await rename(temporary, this.path);
  }
}

export class ConnectorWorkflowService {
  private jobs: ConnectorDownloadJob[] = [];
  private active = new Set<string>();
  constructor(private readonly repository: JsonConnectorJobRepository, private readonly downloader: ConnectorDownloader, private readonly now = () => new Date().toISOString()) {}
  async initialize() {
    this.jobs = await this.repository.load();
    this.jobs = this.jobs.map((job) => job.status === "downloading" ? { ...job, status: "failed", failure: "interrupted during previous server session" } : job);
    await this.repository.save(this.jobs);
    return this.list();
  }
  list() { return structuredClone(this.jobs); }
  async prepare(request: OceanSubsetRequest, metadata: ConnectorMetadataSummary, credentialsAvailable = false) {
    // The stored request is finalized (probe-selected shape attached) BEFORE the
    // approval hash is computed, so preflight.requestHash stays reproducible
    // from the persisted job rather than covering a stale subset.
    const finalized: OceanSubsetRequest = { ...request, expectedShape: metadata.selectedShape, bytesPerValue: metadata.bytesPerValue };
    const preflight = resolveConnectorMetadata(finalized, metadata, credentialsAvailable);
    if (preflight.status !== "ready" || preflight.estimatedBytes === undefined) throw new Error(`connector is not ready: ${preflight.status}; a disclosed volume is required`);
    const job: ConnectorDownloadJob = { id: `connector-${randomUUID()}`, request: finalized, preflight, status: "pending_approval", createdAt: this.now(), executionMode: metadata.source === "fixture" ? "fixture" : "live" };
    this.jobs = [...this.jobs, job];
    await this.repository.save(this.jobs);
    return structuredClone(job);
  }
  async approve(id: string) {
    const job = this.require(id);
    if (job.status !== "pending_approval") throw new Error("connector approval is not pending");
    Object.assign(job, { status: "approved", decidedAt: this.now() } satisfies Partial<ConnectorDownloadJob>);
    await this.repository.save(this.jobs);
    return structuredClone(job);
  }
  async reject(id: string) {
    const job = this.require(id);
    if (job.status !== "pending_approval") throw new Error("connector approval is not pending");
    Object.assign(job, { status: "rejected", decidedAt: this.now() } satisfies Partial<ConnectorDownloadJob>);
    await this.repository.save(this.jobs);
    return structuredClone(job);
  }
  async download(id: string, signal?: AbortSignal) {
    const job = this.require(id);
    if (job.status !== "approved") throw new Error("connector download requires approval");
    if (this.active.has(id)) throw new Error("connector download is already active");
    this.active.add(id);
    job.status = "downloading";
    await this.repository.save(this.jobs);
    try {
      const artifact = await this.downloader.download(job.request, job.preflight.targetUri, signal, job.executionMode ?? "fixture", { ...(job.preflight.estimatedBytes === undefined ? {} : { maxBytes: job.preflight.estimatedBytes }), timeoutMs: 30 * 60_000 });
      if (!/^[a-f0-9]{64}$/.test(artifact.sha256) || artifact.bytes <= 0) throw new Error("downloader returned an invalid artifact");
      job.artifact = artifact;
      job.status = "completed";
      delete job.failure;
      await this.repository.save(this.jobs);
      return structuredClone(job);
    } catch (error) {
      job.status = signal?.aborted ? "cancelled" : "failed";
      job.failure = signal?.aborted ? "cancelled by user" : error instanceof Error ? error.message : String(error);
      await this.repository.save(this.jobs);
      throw error;
    } finally {
      this.active.delete(id);
    }
  }
  private require(id: string) {
    const job = this.jobs.find((item) => item.id === id);
    if (!job) throw new Error("connector job not found");
    return job;
  }
}
