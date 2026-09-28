import { describe, expect, it } from "vitest";
import { assertOpenManusStep } from "./openmanus-boundary.js";

describe("OpenManus execution boundary", () => {
  it("allows an approved local, ssh, or vm step", () => {
    expect(() => assertOpenManusStep({ target: "vm", approved: true, changesFormalConclusion: false, largeDataDownload: false })).not.toThrow();
  });

  it("refuses unapproved work, formal conclusions, and large downloads", () => {
    expect(() => assertOpenManusStep({ target: "local", approved: false, changesFormalConclusion: false, largeDataDownload: false })).toThrow("execution_requires_approval");
    expect(() => assertOpenManusStep({ target: "ssh", approved: true, changesFormalConclusion: true, largeDataDownload: false })).toThrow("formal_conclusion_requires_decision");
    expect(() => assertOpenManusStep({ target: "vm", approved: true, changesFormalConclusion: false, largeDataDownload: true })).toThrow("large_data_download_requires_plan");
  });
});
