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
  assert.equal(store.getSchemaVersion(), 2);
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
  assert.deepEqual(store.getDesktopPreferences(), { dockScale: 1 });
  assert.deepEqual(store.setDockScale(1.17), { dockScale: 1.15 });
  store.close();

  const restored = new SystemStore(databasePath);
  assert.equal(restored.getWorkspaceRoot("primary")?.label, "研究桌面");
  assert.deepEqual(
    restored.listApps().map((app) => app.id).sort(),
    BUILT_IN_APPS.map((app) => app.id).sort(),
  );
  assert.equal(restored.listWindows()[0]?.payload.folder, "workspace://primary/数据");
  assert.deepEqual(restored.getDesktopPreferences(), { dockScale: 1.15 });
  restored.close();
});

test("内置 App 行随声明迁移，用户安装的 App 不被删除", (context) => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "xiling-app-prune-"));
  context.after(() => rmSync(temporary, { recursive: true, force: true }));
  const store = new SystemStore(path.join(temporary, "system.sqlite"));

  for (const app of BUILT_IN_APPS) store.upsertApp(app);
  // 历史遗留的内置行（上一版声明过、现在不再声明）
  store.upsertApp({ id: "system.data", name: "数据", version: "1.0.0", entry: "builtin://data", capabilities: ["workspace.read"], builtIn: true });
  store.upsertApp({ id: "system.research", name: "研究", version: "1.0.0", entry: "builtin://research", capabilities: [], builtIn: true });
  // 用户自己装的 App 必须留下
  store.upsertApp({ id: "local.abc", name: "我的应用", version: "1.0.0", entry: "builtin://chat", capabilities: [], builtIn: false });

  const removed = store.pruneUndeclaredSystemApps(BUILT_IN_APPS.map((app) => app.id)).sort();
  assert.deepEqual(removed, ["system.data", "system.research"]);
  assert.deepEqual(
    store.listApps().map((app) => app.id).sort(),
    [...BUILT_IN_APPS.map((app) => app.id), "local.abc"].sort(),
  );
  // 幂等：再跑一次没有可删的
  assert.deepEqual(store.pruneUndeclaredSystemApps(BUILT_IN_APPS.map((app) => app.id)), []);
  store.close();
});
