import { watch as watchNative } from "node:fs";
import { cp, lstat, mkdir, open, opendir, readdir, rename as renameNative, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { ResourceUri, WorkspaceEntry, WorkspacePage, WorkspacePreview } from "./types.js";

const TEXT_EXTENSIONS = new Set([".csv", ".css", ".html", ".ipynb", ".js", ".json", ".log", ".md", ".py", ".r", ".rst", ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml"]);
const IMAGE_MIME = new Map([[".gif", "image/gif"], [".jpeg", "image/jpeg"], [".jpg", "image/jpeg"], [".png", "image/png"], [".webp", "image/webp"]]);

function encodeRelativePath(relativePath: string): string {
  return relativePath
    .split(path.sep)
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
}

export class WorkspaceFileService {
  readonly rootPath: string;

  constructor(
    readonly rootId: string,
    rootPath: string,
  ) {
    this.rootPath = path.resolve(rootPath);
  }

  async ensureRoot(): Promise<void> {
    await mkdir(this.rootPath, { recursive: true });
    const root = await lstat(this.rootPath);
    if (!root.isDirectory() || root.isSymbolicLink()) {
      throw new Error("Workspace root must be a real directory");
    }
  }

  async list(relativeDirectory = ""): Promise<WorkspaceEntry[]> {
    const directory = await this.#resolveExisting(relativeDirectory, true);
    const entries = await readdir(directory, { withFileTypes: true });
    const result = await Promise.all(
      entries.map(async (entry) => {
        if (entry.isSymbolicLink()) return undefined;
        const relativePath = path.join(relativeDirectory, entry.name);
        const nativePath = path.join(directory, entry.name);
        const details = await stat(nativePath);
        return {
          uri: this.toUri(relativePath),
          name: entry.name,
          kind: entry.isDirectory() ? "directory" : "file",
          size: entry.isFile() ? details.size : null,
          modifiedAt: details.mtime.toISOString(),
        } satisfies WorkspaceEntry;
      }),
    );
    return result
      .filter((entry): entry is WorkspaceEntry => Boolean(entry))
      .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1));
  }

  async page(relativeDirectory = "", requestedOffset = 0, requestedLimit = 120): Promise<WorkspacePage> {
    const directory = await this.#resolveExisting(relativeDirectory, true);
    const offset = Number.isFinite(requestedOffset) ? Math.max(0, Math.floor(requestedOffset)) : 0;
    const limit = Number.isFinite(requestedLimit) ? Math.max(20, Math.min(200, Math.floor(requestedLimit))) : 120;
    const handle = await opendir(directory);
    const entries: WorkspaceEntry[] = [];
    let visited = 0;
    let nextOffset = offset;
    let hasMore = false;
    try {
      for await (const entry of handle) {
        const index = visited;
        visited += 1;
        if (index < offset || entry.isSymbolicLink()) continue;
        if (entries.length >= limit) {
          nextOffset = index;
          hasMore = true;
          break;
        }
        entries.push(await this.#entry(path.join(relativeDirectory, entry.name)));
        nextOffset = visited;
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
    entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1));
    return { entries, nextOffset, hasMore };
  }

  async importPaths(sourcePaths: readonly string[], targetDirectoryUri?: string): Promise<WorkspaceEntry[]> {
    await this.ensureRoot();
    const targetDirectory = targetDirectoryUri ? await this.nativePathForUri(targetDirectoryUri) : this.rootPath;
    if (!(await stat(targetDirectory)).isDirectory()) throw new Error("Import destination is not a directory");
    const imported: WorkspaceEntry[] = [];
    for (const sourcePath of sourcePaths) {
      const source = path.resolve(sourcePath);
      const sourceInfo = await lstat(source);
      if (sourceInfo.isSymbolicLink()) throw new Error("Symbolic-link imports are not allowed");
      const destinationName = await this.#availableName(targetDirectory, path.basename(source));
      const temporaryName = `.xiling-import-${randomUUID()}`;
      const temporaryPath = path.join(targetDirectory, temporaryName);
      const destinationPath = path.join(targetDirectory, destinationName);
      try {
        await cp(source, temporaryPath, {
          recursive: sourceInfo.isDirectory(),
          errorOnExist: true,
          dereference: false,
          preserveTimestamps: true,
        });
        await renameNative(temporaryPath, destinationPath);
      } catch (error) {
        const { rm } = await import("node:fs/promises");
        await rm(temporaryPath, { recursive: true, force: true });
        throw error;
      }
      const details = await stat(destinationPath);
      imported.push({
        uri: this.toUri(path.relative(this.rootPath, destinationPath)),
        name: destinationName,
        kind: details.isDirectory() ? "directory" : "file",
        size: details.isFile() ? details.size : null,
        modifiedAt: details.mtime.toISOString(),
      });
    }
    return imported;
  }

  async watch(onChange: () => void): Promise<() => void> {
    await this.ensureRoot();
    let closed = false;
    let timer: NodeJS.Timeout | undefined;
    const watcher = watchNative(
      this.rootPath,
      { recursive: process.platform !== "linux" },
      () => {
        if (closed) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(onChange, 120);
        timer.unref();
      },
    );
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      watcher.close();
    };
  }

  async search(query: string, requestedLimit = 100): Promise<WorkspaceEntry[]> {
    await this.ensureRoot();
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return this.list();
    const limit = Math.max(1, Math.min(200, Math.floor(requestedLimit)));
    const pending = [""];
    const matches: WorkspaceEntry[] = [];
    let scanned = 0;
    while (pending.length && matches.length < limit && scanned < 20_000) {
      const relativeDirectory = pending.shift()!;
      const directory = await this.#resolveExisting(relativeDirectory, true);
      const handle = await opendir(directory);
      for await (const entry of handle) {
        scanned += 1;
        if (entry.isSymbolicLink()) continue;
        const relativePath = path.join(relativeDirectory, entry.name);
        if (entry.isDirectory()) pending.push(relativePath);
        if (!entry.name.toLocaleLowerCase().includes(needle)) continue;
        matches.push(await this.#entry(relativePath));
        if (matches.length >= limit) break;
        if (scanned >= 20_000) break;
      }
    }
    return matches;
  }

  async createDirectory(relativeDirectory: string, name: string): Promise<WorkspaceEntry> {
    const safeName = this.#validateLeafName(name);
    const parent = await this.#resolveExisting(relativeDirectory, true);
    const destination = path.join(parent, safeName);
    try {
      await mkdir(destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("A file or folder with this name already exists");
      throw error;
    }
    return this.#entry(path.join(relativeDirectory, safeName));
  }

  async rename(uri: string, newName: string): Promise<WorkspaceEntry> {
    const safeName = this.#validateLeafName(newName);
    const source = await this.nativePathForUri(uri);
    if (source === this.rootPath) throw new Error("The workspace root cannot be renamed");
    const destination = path.join(path.dirname(source), safeName);
    try {
      await lstat(destination);
      throw new Error("A file or folder with this name already exists");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await renameNative(source, destination);
    return this.#entry(path.relative(this.rootPath, destination));
  }

  async move(uri: string, targetDirectoryUri?: string): Promise<WorkspaceEntry> {
    const source = await this.nativePathForUri(uri);
    if (source === this.rootPath) throw new Error("The workspace root cannot be moved");
    const targetDirectory = targetDirectoryUri
      ? await this.nativePathForUri(targetDirectoryUri)
      : this.rootPath;
    if (!(await stat(targetDirectory)).isDirectory()) throw new Error("Move destination is not a directory");
    if (targetDirectory === source || targetDirectory.startsWith(`${source}${path.sep}`)) {
      throw new Error("A folder cannot be moved inside itself");
    }
    const destination = path.join(targetDirectory, path.basename(source));
    try {
      await lstat(destination);
      throw new Error("A file or folder with this name already exists");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await renameNative(source, destination);
    return this.#entry(path.relative(this.rootPath, destination));
  }

  async preview(uri: string, requestedBytes = 256 * 1024): Promise<WorkspacePreview> {
    const nativePath = await this.nativePathForUri(uri);
    const details = await stat(nativePath);
    if (!details.isFile()) throw new Error("Only files can be previewed");
    const extension = path.extname(nativePath).toLocaleLowerCase();
    const imageMime = IMAGE_MIME.get(extension);
    const resourceUri = this.toUri(path.relative(this.rootPath, nativePath));
    if (imageMime) {
      const maxImageBytes = 2 * 1024 * 1024;
      if (details.size > maxImageBytes) {
        return { uri: resourceUri, name: path.basename(nativePath), kind: "unsupported", size: details.size, modifiedAt: details.mtime.toISOString(), truncated: false };
      }
      const image = await open(nativePath, "r");
      try {
        const buffer = Buffer.alloc(details.size);
        const { bytesRead } = await image.read(buffer, 0, buffer.length, 0);
        return { uri: resourceUri, name: path.basename(nativePath), kind: "image", size: details.size, modifiedAt: details.mtime.toISOString(), dataUrl: `data:${imageMime};base64,${buffer.subarray(0, bytesRead).toString("base64")}`, truncated: false };
      } finally {
        await image.close();
      }
    }
    const maxBytes = Math.max(1_024, Math.min(512 * 1024, Math.floor(requestedBytes)));
    if (!TEXT_EXTENSIONS.has(extension)) {
      return { uri: this.toUri(path.relative(this.rootPath, nativePath)), name: path.basename(nativePath), kind: "unsupported", size: details.size, modifiedAt: details.mtime.toISOString(), truncated: false };
    }
    const handle = await open(nativePath, "r");
    try {
      const buffer = Buffer.alloc(Math.min(details.size, maxBytes + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const bytes = buffer.subarray(0, Math.min(bytesRead, maxBytes));
      if (bytes.includes(0)) {
        return { uri: resourceUri, name: path.basename(nativePath), kind: "unsupported", size: details.size, modifiedAt: details.mtime.toISOString(), truncated: false };
      }
      return {
        uri: resourceUri,
        name: path.basename(nativePath),
        kind: "text",
        size: details.size,
        modifiedAt: details.mtime.toISOString(),
        text: bytes.toString("utf8"),
        truncated: details.size > maxBytes,
      };
    } finally {
      await handle.close();
    }
  }

  toUri(relativePath: string): ResourceUri {
    const normalized = this.#resolveRelative(relativePath);
    return `workspace://${this.rootId}/${encodeRelativePath(normalized)}`;
  }

  async nativePathForUri(uri: string): Promise<string> {
    const parsed = new URL(uri);
    if (parsed.protocol !== "workspace:" || parsed.hostname !== this.rootId) {
      throw new Error("Resource does not belong to this workspace");
    }
    const relativePath = parsed.pathname
      .split("/")
      .filter(Boolean)
      .map((part) => decodeURIComponent(part))
      .join(path.sep);
    return this.#resolveExisting(relativePath, false);
  }

  async #resolveExisting(relativePath: string, requireDirectory: boolean): Promise<string> {
    const normalized = this.#resolveRelative(relativePath);
    let cursor = this.rootPath;
    if (normalized) {
      for (const part of normalized.split(path.sep)) {
        cursor = path.join(cursor, part);
        const details = await lstat(cursor);
        if (details.isSymbolicLink()) throw new Error("Workspace symbolic-link traversal is not allowed");
      }
    }
    if (requireDirectory && !(await stat(cursor)).isDirectory()) throw new Error("Not a directory");
    return cursor;
  }

  async #entry(relativePath: string): Promise<WorkspaceEntry> {
    const nativePath = await this.#resolveExisting(relativePath, false);
    const details = await stat(nativePath);
    return {
      uri: this.toUri(relativePath),
      name: path.basename(nativePath),
      kind: details.isDirectory() ? "directory" : "file",
      size: details.isFile() ? details.size : null,
      modifiedAt: details.mtime.toISOString(),
    };
  }

  #validateLeafName(name: string): string {
    if (!name || name !== name.trim() || name === "." || name === ".." || name.length > 240) {
      throw new Error("Invalid file or folder name");
    }
    if (/[\\/:*?"<>|\0]/u.test(name) || /[. ]$/u.test(name)) throw new Error("Invalid file or folder name");
    const stem = name.split(".")[0]?.toLocaleUpperCase();
    if (stem && /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(stem)) throw new Error("Reserved file or folder name");
    return name;
  }

  #resolveRelative(relativePath: string): string {
    if (path.isAbsolute(relativePath)) throw new Error("Workspace paths must be relative");
    const normalized = path.normalize(relativePath || ".");
    const candidate = path.resolve(this.rootPath, normalized);
    const relative = path.relative(this.rootPath, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Workspace path escapes the selected root");
    }
    return relative === "" ? "" : relative;
  }

  async #availableName(directory: string, originalName: string): Promise<string> {
    const parsed = path.parse(originalName);
    for (let index = 0; index < 10_000; index += 1) {
      const name = index === 0 ? originalName : `${parsed.name} (${index})${parsed.ext}`;
      try {
        await lstat(path.join(directory, name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return name;
        throw error;
      }
    }
    throw new Error("Unable to allocate an import filename");
  }
}
