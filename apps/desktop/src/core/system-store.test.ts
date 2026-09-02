import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BUILT_IN_APPS } from "./app-registry.js";
import { SystemStore } from "./system-store.js";

test("system store initializes the unified schema and restores desktop state", (context) => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "xiling-system-store-"));
  context.after(() => rmSync(temporary, { recursive: true, force: true }));
  const databasePath = path.join(temporary, "system.sqlite");
  const store = new SystemStore(databasePath);
  assert.equal(store.getSchemaVersion(), 1);
  const root = store.setWorkspaceRoot({ id: "primary", label: "研究桌面", nativePath: "/tmp/研究 桌面" });
  assert.equal(root.label, "研究桌面");

  for (const app of BUILT_IN_APPS) store.upsertApp(app);
  assert.deepEqual(
    store.listApps().map((app) => app.id).sort(),
    BUILT_IN_APPS.map((app) => app.id).sort(),
  );

  store.saveWindow({
    id: "window-1",
    appId: "system.files",
    x: 80,
    y: 64,
    width: 720,
    height: 480,
    zIndex: 3,
    state: "open",
    payload: { folder: "workspace://primary/数据" },
    updatedAt: new Date().toISOString(),
  });
  store.close();

  const restored = new SystemStore(databasePath);
  assert.equal(restored.getWorkspaceRoot("primary")?.label, "研究桌面");
  assert.deepEqual(
    restored.listApps().map((app) => app.id).sort(),
    BUILT_IN_APPS.map((app) => app.id).sort(),
  );
  assert.equal(restored.listWindows()[0]?.payload.folder, "workspace://primary/数据");
  restored.close();
});
