import assert from "node:assert/strict";
import test from "node:test";

import { fitWindowToViewport, mergeRestoredWindows, nextWindowToFocus, type WindowGeometry } from "./window-model.js";

test("restored geometry wins while an explicitly opened app becomes visible", () => {
  const current: Array<WindowGeometry & { appKey: string }> = [{ id: "managed-workspace", appKey: "workspace", x: 10, y: 10, width: 980, height: 610, zIndex: 60, state: "open" }];
  const restored: Array<WindowGeometry & { appKey: string }> = [{ id: "managed-workspace", appKey: "workspace", x: 180, y: 90, width: 760, height: 520, zIndex: 72, state: "minimized" }];
  assert.deepEqual(mergeRestoredWindows(current, restored), [
    { ...restored[0], state: "open" },
  ]);
});

test("window fitting keeps title bar and resize handle inside the desktop", () => {
  const fitted = fitWindowToViewport(
    { id: "w", x: 900, y: -80, width: 1_400, height: 900, zIndex: 2, state: "open" as const },
    { width: 1_024, height: 700, topInset: 32, bottomInset: 76 },
  );
  assert.deepEqual({ x: fitted.x, y: fitted.y, width: fitted.width, height: fitted.height }, { x: 16, y: 32, width: 1_000, height: 592 });
});

test("keyboard cycling chooses the window behind the focused one", () => {
  const windows = [
    { id: "front", x: 0, y: 0, width: 500, height: 400, zIndex: 9, state: "open" as const },
    { id: "next", x: 0, y: 0, width: 500, height: 400, zIndex: 7, state: "maximized" as const },
    { id: "hidden", x: 0, y: 0, width: 500, height: 400, zIndex: 8, state: "minimized" as const },
  ];
  assert.equal(nextWindowToFocus(windows)?.id, "next");
});
