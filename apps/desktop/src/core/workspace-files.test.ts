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

test("workspace mutations and bounded search preserve the selected root", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "xiling-workspace-mutations-"));
  context.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(temporary, { recursive: true, force: true });
  });
  const workspace = path.join(temporary, "workspace");
  const external = path.join(temporary, "导入.csv");
  await mkdir(workspace);
  await writeFile(external, "time,value\n0,1\n", "utf8");
  const service = new WorkspaceFileService("primary", workspace);
  const folder = await service.createDirectory("", "观测 数据");
  await writeFile(path.join(await service.nativePathForUri(folder.uri), "温盐剖面.txt"), "fixture", "utf8");

  const matches = await service.search("温盐");
  assert.deepEqual(matches.map((entry) => entry.name), ["温盐剖面.txt"]);
  const preview = await service.preview(matches[0]!.uri, 1_024);
  assert.deepEqual({ kind: preview.kind, text: preview.text, truncated: preview.truncated }, { kind: "text", text: "fixture", truncated: false });
  await writeFile(path.join(await service.nativePathForUri(folder.uri), "长日志.txt"), "x".repeat(2_048), "utf8");
  const longPreview = await service.preview(service.toUri("观测 数据/长日志.txt"), 1_024);
  assert.equal(longPreview.text?.length, 1_024);
  assert.equal(longPreview.truncated, true);
  await writeFile(path.join(await service.nativePathForUri(folder.uri), "数组.nc"), Buffer.from([0, 1, 2, 3]));
  assert.equal((await service.preview(service.toUri("观测 数据/数组.nc"))).kind, "unsupported");
  await writeFile(path.join(await service.nativePathForUri(folder.uri), "缩略图.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const imagePreview = await service.preview(service.toUri("观测 数据/缩略图.png"));
  assert.equal(imagePreview.kind, "image");
  assert.match(imagePreview.dataUrl ?? "", /^data:image\/png;base64,/);

  const renamed = await service.rename(matches[0]!.uri, "温盐剖面 2026.txt");
  assert.equal(renamed.name, "温盐剖面 2026.txt");
  assert.equal(await readFile(await service.nativePathForUri(renamed.uri), "utf8"), "fixture");
  await writeFile(path.join(await service.nativePathForUri(folder.uri), "重复.txt"), "duplicate", "utf8");
  const target = await service.createDirectory("", "目标");
  const moved = await service.move(renamed.uri, target.uri);
  assert.equal(await readFile(await service.nativePathForUri(moved.uri), "utf8"), "fixture");
  const child = await service.createDirectory("观测 数据", "子目录");
  await assert.rejects(() => service.move(folder.uri, child.uri), /inside itself/);
  const imported = await service.importPaths([external], target.uri);
  assert.equal(imported[0]?.uri, "workspace://primary/%E7%9B%AE%E6%A0%87/%E5%AF%BC%E5%85%A5.csv");

  await assert.rejects(() => service.createDirectory("", "../越界"), /Invalid/);
  await assert.rejects(() => service.createDirectory("", "CON"), /Reserved/);
  await assert.rejects(() => service.createDirectory("", "观测 数据"), /already exists/);
  await assert.rejects(() => service.rename(imported[0]!.uri, "温盐剖面 2026.txt"), /already exists/);
});

test("workspace directory pages keep renderer payloads bounded", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "xiling-workspace-pages-"));
  context.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(temporary, { recursive: true, force: true });
  });
  await Promise.all(Array.from({ length: 47 }, (_, index) => writeFile(path.join(temporary, `样本-${String(index).padStart(2, "0")}.txt`), String(index), "utf8")));
  const service = new WorkspaceFileService("primary", temporary);
  const first = await service.page("", 0, 20);
  const second = await service.page("", first.nextOffset, 20);
  const third = await service.page("", second.nextOffset, 20);
  assert.deepEqual([first.entries.length, second.entries.length, third.entries.length], [20, 20, 7]);
  assert.deepEqual([first.hasMore, second.hasMore, third.hasMore], [true, true, false]);
  assert.equal(new Set([...first.entries, ...second.entries, ...third.entries].map((entry) => entry.uri)).size, 47);
});
