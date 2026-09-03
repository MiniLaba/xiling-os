import process from "node:process";

import { BUILT_IN_APPS } from "./core/app-registry.js";
import { CapabilityGateway } from "./core/capability-gateway.js";
import type { CoreEvent, CoreMethod, CoreRequest, CoreResponse } from "./core/protocol.js";
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
let stopWorkspaceWatcher: (() => void) | undefined;
let watchedWorkspacePath: string | undefined;

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

async function ensureWorkspaceWatcher(): Promise<void> {
  const root = store.getWorkspaceRoot("primary");
  if (!root || watchedWorkspacePath === root.nativePath) return;
  stopWorkspaceWatcher?.();
  const service = new WorkspaceFileService(root.id, root.nativePath);
  stopWorkspaceWatcher = await service.watch(() => {
    parentPort.postMessage({
      type: "core-event",
      topic: "workspace.changed",
      payload: { rootId: root.id },
    } satisfies CoreEvent);
  });
  watchedWorkspacePath = root.nativePath;
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
    watchedWorkspacePath = undefined;
    await ensureWorkspaceWatcher();
    return { id: root.id, label: root.label };
  }
  if (method === "workspace.list") {
    caller(params, "workspace.read");
    await ensureWorkspaceWatcher();
    const relativeDirectory = typeof params.relativeDirectory === "string" ? params.relativeDirectory : "";
    return workspaceService().list(relativeDirectory);
  }
  if (method === "workspace.page") {
    caller(params, "workspace.read");
    await ensureWorkspaceWatcher();
    const relativeDirectory = typeof params.relativeDirectory === "string" ? params.relativeDirectory : "";
    const offset = typeof params.offset === "number" ? params.offset : 0;
    const limit = typeof params.limit === "number" ? params.limit : 120;
    return workspaceService().page(relativeDirectory, offset, limit);
  }
  if (method === "workspace.search") {
    caller(params, "workspace.read");
    const limit = typeof params.limit === "number" ? params.limit : 100;
    return workspaceService().search(stringField(params, "query"), limit);
  }
  if (method === "workspace.mkdir") {
    caller(params, "workspace.write");
    const relativeDirectory = typeof params.relativeDirectory === "string" ? params.relativeDirectory : "";
    return workspaceService().createDirectory(relativeDirectory, stringField(params, "name"));
  }
  if (method === "workspace.rename") {
    caller(params, "workspace.write");
    return workspaceService().rename(stringField(params, "uri"), stringField(params, "name"));
  }
  if (method === "workspace.move") {
    caller(params, "workspace.write");
    const targetDirectoryUri = typeof params.targetDirectoryUri === "string" ? params.targetDirectoryUri : undefined;
    return workspaceService().move(stringField(params, "uri"), targetDirectoryUri);
  }
  if (method === "workspace.preview") {
    caller(params, "workspace.read");
    return workspaceService().preview(stringField(params, "uri"));
  }
  if (method === "workspace.import") {
    caller(params, "workspace.write");
    const sourcePaths = params.sourcePaths;
    if (!Array.isArray(sourcePaths) || sourcePaths.some((item) => typeof item !== "string")) {
      throw new Error("sourcePaths must be a string array");
    }
    const targetDirectoryUri = typeof params.targetDirectoryUri === "string" ? params.targetDirectoryUri : undefined;
    return workspaceService().importPaths(sourcePaths as string[], targetDirectoryUri);
  }
  if (method === "workspace.resolve") {
    caller(params, "workspace.read");
    return { nativePath: await workspaceService().nativePathForUri(stringField(params, "uri")) };
  }
  if (method === "workspace.resolveWrite") {
    caller(params, "workspace.write");
    const service = workspaceService();
    const nativePath = await service.nativePathForUri(stringField(params, "uri"));
    if (nativePath === service.rootPath) throw new Error("The workspace root cannot be moved to trash");
    return { nativePath };
  }
  if (method === "windows.list") return store.listWindows();
  if (method === "windows.save") {
    store.saveWindow(params.state as unknown as DesktopWindowState);
    return { saved: true };
  }
  if (method === "preferences.get") return store.getDesktopPreferences();
  if (method === "preferences.set") {
    const dockScale = Number(params.dockScale);
    if (!Number.isFinite(dockScale)) throw new Error("dockScale must be a finite number");
    return store.setDockScale(dockScale);
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
    stopWorkspaceWatcher?.();
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
