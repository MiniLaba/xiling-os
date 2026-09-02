import assert from "node:assert/strict";
import test from "node:test";

import { BUILT_IN_APPS } from "./app-registry.js";
import { SystemStore } from "./system-store.js";

test("system store initializes the unified schema and restores desktop state", () => {
  const store = new SystemStore(":memory:");
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
  assert.equal(store.listWindows()[0]?.payload.folder, "workspace://primary/数据");
  store.close();
});
