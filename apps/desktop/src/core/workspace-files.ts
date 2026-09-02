import { cp, lstat, mkdir, readdir, rename, stat, watch } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { ResourceUri, WorkspaceEntry } from "./types.js";

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

  async importPaths(sourcePaths: readonly string[]): Promise<WorkspaceEntry[]> {
    await this.ensureRoot();
    const imported: WorkspaceEntry[] = [];
    for (const sourcePath of sourcePaths) {
      const source = path.resolve(sourcePath);
      const sourceInfo = await lstat(source);
      if (sourceInfo.isSymbolicLink()) throw new Error("Symbolic-link imports are not allowed");
      const destinationName = await this.#availableName(path.basename(source));
      const temporaryName = `.xiling-import-${randomUUID()}`;
      const temporaryPath = path.join(this.rootPath, temporaryName);
      const destinationPath = path.join(this.rootPath, destinationName);
      try {
        await cp(source, temporaryPath, {
          recursive: sourceInfo.isDirectory(),
          errorOnExist: true,
          dereference: false,
          preserveTimestamps: true,
        });
        await rename(temporaryPath, destinationPath);
      } catch (error) {
        const { rm } = await import("node:fs/promises");
        await rm(temporaryPath, { recursive: true, force: true });
        throw error;
      }
      const details = await stat(destinationPath);
      imported.push({
        uri: this.toUri(destinationName),
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
    const watcher = watch(this.rootPath, { recursive: process.platform !== "linux" });
    let closed = false;
    let timer: NodeJS.Timeout | undefined;
    void (async () => {
      try {
        for await (const _event of watcher) {
          if (closed) break;
          if (timer) clearTimeout(timer);
          timer = setTimeout(onChange, 120);
          timer.unref();
        }
      } catch {
        // A watcher can terminate while the app is shutting down.
      }
    })();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      void watcher.return?.();
    };
  }

  toUri(relativePath: string): ResourceUri {
    const normalized = this.#resolveRelative(relativePath);
    return `workspace://${this.rootId}/${encodeRelativePath(normalized)}`;
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

  async #availableName(originalName: string): Promise<string> {
    const parsed = path.parse(originalName);
    for (let index = 0; index < 10_000; index += 1) {
      const name = index === 0 ? originalName : `${parsed.name} (${index})${parsed.ext}`;
      try {
        await lstat(path.join(this.rootPath, name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return name;
        throw error;
      }
    }
    throw new Error("Unable to allocate an import filename");
  }
}
