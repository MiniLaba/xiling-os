import process from "node:process";

import { BUILT_IN_APPS } from "./core/app-registry.js";
import { CapabilityGateway } from "./core/capability-gateway.js";
import type { CoreMethod, CoreRequest, CoreResponse } from "./core/protocol.js";
import { SystemStore } from "./core/system-store.js";
import type { AppCapability, AppManifest, DesktopWindowState } from "./core/types.js";
import { WorkspaceFileService } from "./core/workspace-files.js";

const parentPort = process.parentPort;

if (!parentPort) {
  throw new Error("XiLing Core must run as an Electron utility process");
}

const databasePath = process.env.XILING_SYSTEM_DB_PATH;
if (!databasePath) throw new Error("XILING_SYSTEM_DB_PATH is required");

const store = new SystemStore(databasePath);
for (const manifest of BUILT_IN_APPS) store.upsertApp(manifest);
const capabilityGateway = new CapabilityGateway(store);

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid request parameters");
  return value as Record<string, unknown>;
}

function stringField(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || !value) throw new Error(`Missing ${key}`);
  return value;
}

function caller(params: Record<string, unknown>, capability: AppCapability): AppManifest {
  const appId = stringField(params, "appId");
  return capabilityGateway.authorize(appId, capability);
}

function workspaceService(): WorkspaceFileService {
  const root = store.getWorkspaceRoot("primary");
  if (!root) throw new Error("No desktop folder has been selected");
  return new WorkspaceFileService(root.id, root.nativePath);
}

async function dispatch(method: CoreMethod, rawParams: unknown): Promise<unknown> {
  const params = record(rawParams ?? {});
  if (method === "system.ping") return { schemaVersion: store.getSchemaVersion() };
  if (method === "apps.list") return store.listApps();
  if (method === "workspace.get") {
    const root = store.getWorkspaceRoot("primary");
    return root ? { id: root.id, label: root.label } : null;
  }
  if (method === "workspace.set") {
    const nativePath = stringField(params, "nativePath");
    const root = store.setWorkspaceRoot({
      id: "primary",
      label: stringField(params, "label"),
      nativePath,
    });
    await new WorkspaceFileService(root.id, root.nativePath).ensureRoot();
    return { id: root.id, label: root.label };
  }
  if (method === "workspace.list") {
    caller(params, "workspace.read");
    const relativeDirectory = typeof params.relativeDirectory === "string" ? params.relativeDirectory : "";
    return workspaceService().list(relativeDirectory);
  }
  if (method === "workspace.import") {
    caller(params, "workspace.write");
    const sourcePaths = params.sourcePaths;
    if (!Array.isArray(sourcePaths) || sourcePaths.some((item) => typeof item !== "string")) {
      throw new Error("sourcePaths must be a string array");
    }
    return workspaceService().importPaths(sourcePaths as string[]);
  }
  if (method === "windows.list") return store.listWindows();
  if (method === "windows.save") {
    store.saveWindow(params.state as unknown as DesktopWindowState);
    return { saved: true };
  }
  const exhaustive: never = method;
  throw new Error(`Unsupported method: ${String(exhaustive)}`);
}

parentPort.postMessage({
  type: "core-ready",
  protocolVersion: 1,
  startedAt: new Date().toISOString(),
});

parentPort.on("message", (event) => {
  const message = event.data as CoreRequest | { type?: string } | undefined;
  if (message?.type === "shutdown") {
    store.close();
    parentPort.postMessage({ type: "core-stopped" });
    process.exit(0);
  }
  if (message?.type !== "core-request") return;
  const request = message as CoreRequest;
  void dispatch(request.method, request.params)
    .then((result) => {
      parentPort.postMessage({ type: "core-response", id: request.id, ok: true, result } satisfies CoreResponse);
    })
    .catch((error: unknown) => {
      parentPort.postMessage({
        type: "core-response",
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : "Unknown Core error",
      } satisfies CoreResponse);
    });
});
