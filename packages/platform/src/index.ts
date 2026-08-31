import { createHash } from "node:crypto";
import path from "node:path";
import type { ResourceUri } from "@xiling/contracts";

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const INVALID = /[<>:"|?*\u0000-\u001f]/;

export interface WindowsImportPlan {
  platform: "windows";
  originalPath: string;
  displayName: string;
  nativeReadOnlyPath: string;
  snapshotObjectName: string;
  importedArtifactUri: ResourceUri;
}

export function planWindowsImport(originalPath: string): WindowsImportPlan {
  if (originalPath.startsWith("\\\\")) {
    throw new Error("UNC/SMB paths must be copied locally before import");
  }
  const match = /^([A-Za-z]):\\(.+)$/.exec(originalPath);
  if (!match?.[1] || !match[2]) throw new Error("Expected an absolute Windows drive path");

  const segments = match[2].split("\\");
  for (const segment of segments) {
    if (!segment || segment.endsWith(".") || segment.endsWith(" ") || RESERVED.test(segment) || INVALID.test(segment)) {
      throw new Error(`Unsafe Windows path segment: ${segment}`);
    }
  }
  if (originalPath.length > 260) throw new Error("Windows path exceeds the safe import length");

  const displayName = path.win32.basename(originalPath);
  const digest = createHash("sha256").update(originalPath.normalize("NFC")).digest("hex");
  return {
    platform: "windows",
    originalPath,
    displayName,
    nativeReadOnlyPath: path.win32.normalize(originalPath),
    snapshotObjectName: digest,
    importedArtifactUri: `artifact://${digest}`,
  };
}
