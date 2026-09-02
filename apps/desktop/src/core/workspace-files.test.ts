import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { WorkspaceFileService } from "./workspace-files.js";

test("workspace service lists real files, hides symlinks and imports without overwriting", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "xiling-workspace-"));
  context.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(temporary, { recursive: true, force: true });
  });
  const workspace = path.join(temporary, "桌面 空间");
  const external = path.join(temporary, "外部 数据.csv");
  await mkdir(workspace);
  await writeFile(path.join(workspace, "论文.md"), "existing", "utf8");
  await writeFile(external, "a,b\n1,2\n", "utf8");
  await symlink(external, path.join(workspace, "outside-link"));

  const service = new WorkspaceFileService("primary", workspace);
  const listed = await service.list();
  assert.deepEqual(listed.map((entry) => entry.name), ["论文.md"]);
  assert.equal(listed[0]?.uri, "workspace://primary/%E8%AE%BA%E6%96%87.md");
  assert.equal(await service.nativePathForUri(listed[0]!.uri), path.join(workspace, "论文.md"));
  await assert.rejects(
    () => service.nativePathForUri("workspace://other/%E8%AE%BA%E6%96%87.md"),
    /does not belong/,
  );

  const firstImport = await service.importPaths([external]);
  const secondImport = await service.importPaths([external]);
  assert.equal(firstImport[0]?.name, "外部 数据.csv");
  assert.equal(secondImport[0]?.name, "外部 数据 (1).csv");
  assert.equal(await readFile(path.join(workspace, "外部 数据.csv"), "utf8"), "a,b\n1,2\n");
  await assert.rejects(() => service.list("../"), /escapes/);
});

test("workspace watcher emits a debounced change and releases cleanly", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "xiling-watch-"));
  context.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(temporary, { recursive: true, force: true });
  });
  const service = new WorkspaceFileService("primary", temporary);
  let changes = 0;
  const stop = await service.watch(() => {
    changes += 1;
  });
  await writeFile(path.join(temporary, "change.txt"), "changed", "utf8");
  for (let attempt = 0; attempt < 100 && changes === 0; attempt += 1) {
    await delay(25);
    if (attempt > 0 && attempt % 20 === 0) await appendFile(path.join(temporary, "change.txt"), ".", "utf8");
  }
  stop();
  assert.equal(changes, 1);
});
