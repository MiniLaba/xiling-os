const { cpSync, existsSync, mkdirSync, readdirSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { createRequire } = require("node:module");
const { dirname, join } = require("node:path");

function findRcedit() {
  const roots = [join(__dirname, "../../../node_modules"), join(__dirname, "../node_modules")];
  for (const root of roots) {
    const nested = join(root, ".pnpm/node_modules/electron-winstaller/vendor/rcedit.exe");
    if (existsSync(nested)) return nested;
    const hoisted = join(root, "electron-winstaller/vendor/rcedit.exe");
    if (existsSync(hoisted)) return hoisted;
    const pnpm = join(root, ".pnpm");
    if (!existsSync(pnpm)) continue;
    for (const dir of readdirSync(pnpm)) {
      if (!dir.startsWith("electron-winstaller@")) continue;
      const candidate = join(pnpm, dir, "node_modules/electron-winstaller/vendor/rcedit.exe");
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

async function stampWithResedit(exe, icon) {
  const desktopReq = createRequire(join(__dirname, "../package.json"));
  const builderPkg = desktopReq.resolve("electron-builder/package.json");
  const builderReq = createRequire(builderPkg);
  let libPkg;
  try {
    libPkg = builderReq.resolve("app-builder-lib/package.json");
  } catch {
    libPkg = require.resolve("app-builder-lib/package.json", { paths: [dirname(builderPkg), join(__dirname, "../../../node_modules")] });
  }
  const resedit = createRequire(libPkg)("resedit");
  const { readFile, writeFile } = require("node:fs/promises");
  const buffer = await readFile(exe);
  const executable = resedit.NtExecutable.from(buffer);
  const res = resedit.NtExecutableResource.from(executable);
  const iconFile = resedit.Data.IconFile.from(await readFile(icon));
  const viList = resedit.Resource.VersionInfo.fromEntries(res.entries);
  const languages = viList[0]?.getAllLanguagesForStringValues?.() ?? [];
  const lang = languages[0]?.lang ?? 0x0409;
  resedit.Resource.IconGroupEntry.replaceIconsForResource(
    res.entries,
    1,
    lang,
    iconFile.icons.map((item) => item.data),
  );
  res.outputResource(executable);
  await writeFile(exe, Buffer.from(executable.generate()));
}

function stampWithRceditExe(exe, icon) {
  const rcedit = findRcedit();
  if (!rcedit) throw new Error("rcedit.exe not found");
  const result = spawnSync(rcedit, [exe, "--set-icon", icon], { stdio: "inherit", windowsHide: true });
  if (result.status !== 0) throw new Error(`rcedit exited ${result.status ?? "unknown"}`);
}

async function stampWindowsIcon(exe, icon) {
  try {
    await stampWithResedit(exe, icon);
    return;
  } catch (error) {
    console.warn(`afterPack: resedit failed (${error instanceof Error ? error.message : error}), trying rcedit.exe`);
  }
  stampWithRceditExe(exe, icon);
}

/** electron-builder skips node_modules in extraResources; copy them after pack. */
exports.default = async function afterPack(context) {
  const src = join(context.packager.projectDir, "stage", "node_modules");
  const dest = join(context.appOutDir, "resources", "xiling", "node_modules");
  if (!existsSync(src)) throw new Error(`打包失败：找不到 ${src}`);
  if (!existsSync(join(dest, "fastify", "package.json"))) {
    console.log(`afterPack: copying server node_modules from ${src}`);
    mkdirSync(join(context.appOutDir, "resources", "xiling"), { recursive: true });
    cpSync(src, dest, { recursive: true });
    console.log("afterPack: server node_modules copied");
  } else {
    console.log("afterPack: server node_modules already present");
  }

  if (context.electronPlatformName !== "win32") return;
  const icon = join(context.packager.projectDir, "icons", "icon.ico");
  if (!existsSync(icon)) {
    console.warn("afterPack: missing icons/icon.ico, desktop shortcut will keep the Electron atom");
    return;
  }
  const productExe = `${context.packager.appInfo.productFilename}.exe`;
  const named = join(context.appOutDir, productExe);
  const fallback = readdirSync(context.appOutDir).find((name) => name.endsWith(".exe") && name !== "elevate.exe");
  const exe = existsSync(named) ? named : fallback ? join(context.appOutDir, fallback) : "";
  if (!exe) return;
  await stampWindowsIcon(exe, icon);
  console.log(`afterPack: stamped windows icon onto ${exe}`);
};

exports.stampWindowsIcon = stampWindowsIcon;
exports.findRcedit = findRcedit;

if (require.main === module) {
  const exe = process.argv[2];
  const icon = process.argv[3] || join(__dirname, "../icons/icon.ico");
  if (!exe || !existsSync(exe) || !existsSync(icon)) {
    console.error("usage: node after-pack.cjs <app.exe> [icon.ico]");
    process.exit(1);
  }
  stampWindowsIcon(exe, icon)
    .then(() => console.log(`stamped ${exe}`))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
