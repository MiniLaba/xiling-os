import { describe, expect, it } from "vitest";
import { planWindowsImport } from "./index.js";

describe("planWindowsImport", () => {
  it.each([
    ["C:\\Users\\海洋研究\\温度 数据.nc", "C:\\Users\\海洋研究\\温度 数据.nc"],
    ["D:\\Argo\\profile.nc", "D:\\Argo\\profile.nc"],
  ])("plans a read-only native Windows source and content-addressed snapshot", (source, expected) => {
    const result = planWindowsImport(source);
    expect(result.nativeReadOnlyPath).toBe(expected);
    expect(result.importedArtifactUri).toMatch(/^artifact:\/\/[a-f0-9]{64}$/);
  });

  it.each([
    "\\\\server\\share\\data.nc",
    "C:\\data\\CON.nc",
    "C:\\data\\bad. ",
    "relative\\data.nc",
  ])("rejects unsupported or ambiguous source %s", (source) => {
    expect(() => planWindowsImport(source)).toThrow();
  });
});
