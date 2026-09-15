import { PNG } from "pngjs";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

function isPng(buffer) {
  return buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
}

function pngPayload(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buffer.subarray(0, 8).equals(signature)) throw new Error("decoded logo is not PNG");
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    offset += 12 + length;
    if (type === "IEND") return buffer.subarray(0, offset);
  }
  return buffer;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function decodeToPng(sourcePath) {
  const raw = readFileSync(sourcePath);
  if (isPng(raw)) return PNG.sync.read(pngPayload(raw));
  const generated = resolve(root, "icons/icon.png");
  if (existsSync(generated) && generated !== sourcePath && isPng(readFileSync(generated))) {
    return PNG.sync.read(pngPayload(readFileSync(generated)));
  }
  const temp = join(tmpdir(), `xiling-logo-${process.pid}.png`);
  if (process.platform === "win32") {
    const src = sourcePath.replace(/'/g, "''");
    const dest = temp.replace(/'/g, "''");
    const result = spawnSync("powershell", [
      "-NoProfile",
      "-Command",
      `Add-Type -AssemblyName System.Drawing; $img = [System.Drawing.Image]::FromFile('${src}'); $img.Save('${dest}', [System.Drawing.Imaging.ImageFormat]::Png); $img.Dispose()`,
    ], { encoding: "utf8" });
    if (result.status !== 0 || !existsSync(temp)) {
      throw new Error(`无法把桌面图标转成 PNG：${result.stderr || result.stdout || "unknown"}`);
    }
  } else {
    const result = spawnSync("sips", ["-s", "format", "png", sourcePath, "--out", temp], { encoding: "utf8" });
    if (result.status !== 0 || !existsSync(temp)) {
      throw new Error("无法把桌面图标转成 PNG。请在 Mac 上打包，或先提供 PNG 格式的 apps/desktop/icons/logo.png。");
    }
  }
  try {
    return PNG.sync.read(pngPayload(readFileSync(temp)));
  } finally {
    try { unlinkSync(temp); } catch { /* temp */ }
  }
}

const sourcePath = ["icons/logo.jpg", "icons/logo.png"]
  .map((name) => resolve(root, name))
  .find((path) => existsSync(path));
if (!sourcePath) throw new Error("缺少 apps/desktop/icons/logo.jpg 或 logo.png");

const source = decodeToPng(sourcePath);
const size = 512;
const png = new PNG({ width: size, height: size });

function sample(x, y) {
  const sx = Math.min(source.width - 1, Math.max(0, Math.round((x / (size - 1)) * (source.width - 1))));
  const sy = Math.min(source.height - 1, Math.max(0, Math.round((y / (size - 1)) * (source.height - 1))));
  const idx = (source.width * sy + sx) << 2;
  return [source.data[idx], source.data[idx + 1], source.data[idx + 2], source.data[idx + 3]];
}

for (let y = 0; y < size; y += 1) {
  for (let x = 0; x < size; x += 1) {
    const [r, g, b, a] = sample(x, y);
    const idx = (size * y + x) << 2;
    const black = r < 22 && g < 22 && b < 22;
    png.data[idx] = r;
    png.data[idx + 1] = g;
    png.data[idx + 2] = b;
    png.data[idx + 3] = black ? 0 : a;
  }
}

mkdirSync(resolve(root, "icons"), { recursive: true });
writeFileSync(resolve(root, "icons/icon.png"), PNG.sync.write(png));

function scaleTo(size) {
  const out = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const sx = Math.min(png.width - 1, Math.max(0, Math.round((x / (size - 1)) * (png.width - 1))));
      const sy = Math.min(png.height - 1, Math.max(0, Math.round((y / (size - 1)) * (png.height - 1))));
      const from = (png.width * sy + sx) << 2;
      const to = (size * y + x) << 2;
      out.data[to] = png.data[from];
      out.data[to + 1] = png.data[from + 1];
      out.data[to + 2] = png.data[from + 2];
      out.data[to + 3] = png.data[from + 3];
    }
  }
  return PNG.sync.write(out);
}

function writeIco(path, pngs) {
  const header = 6 + 16 * pngs.length;
  let offset = header;
  const entries = pngs.map((image) => {
    const entry = { bytes: image.length, offset };
    offset += image.length;
    return entry;
  });
  const buffer = Buffer.alloc(offset);
  buffer.writeUInt16LE(0, 0);
  buffer.writeUInt16LE(1, 2);
  buffer.writeUInt16LE(pngs.length, 4);
  pngs.forEach((image, index) => {
    const size = [256, 48, 32, 16][index];
    const at = 6 + index * 16;
    buffer.writeUInt8(size >= 256 ? 0 : size, at);
    buffer.writeUInt8(size >= 256 ? 0 : size, at + 1);
    buffer.writeUInt8(0, at + 2);
    buffer.writeUInt8(0, at + 3);
    buffer.writeUInt16LE(1, at + 4);
    buffer.writeUInt16LE(32, at + 6);
    buffer.writeUInt32LE(entries[index].bytes, at + 8);
    buffer.writeUInt32LE(entries[index].offset, at + 12);
    image.copy(buffer, entries[index].offset);
  });
  writeFileSync(path, buffer);
}

writeIco(resolve(root, "icons/icon.ico"), [256, 48, 32, 16].map((size) => scaleTo(size)));
console.log("wrote apps/desktop/icons/icon.png and icon.ico");
