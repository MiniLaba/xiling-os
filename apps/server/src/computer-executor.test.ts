import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ComputerExecutor, reviewComputerRequest } from "./computer-executor.js";

describe("computer execution", () => {
  it("refuses formal-conclusion writes and bulk downloads", () => {
    expect(() => reviewComputerRequest({ target: "vm", path: "/workspace/knowledge.sqlite" })).toThrow("formal_conclusion_requires_decision");
    expect(() => reviewComputerRequest({ target: "local", command: "wget https://example.com/data.nc" })).toThrow("large_data_download_requires_plan");
  });

  it("opens a page inside the VM browser instead of returning only a link", async () => {
    const calls: string[][] = [];
    const executor = new ComputerExecutor({
      localRoot: mkdtempSync(join(tmpdir(), "xiling-computer-")),
      target: () => ({ target: "vm" }),
      ensureVm: async () => undefined,
      run: async (_file, args) => {
        calls.push(args);
        return { stdout: "opened\n", stderr: "" };
      },
    });
    const result = JSON.parse(await executor.browse("http://www.bkjx.sdu.edu.cn/")) as { success: boolean; title: string };
    expect(result).toMatchObject({ success: true, url: "http://www.bkjx.sdu.edu.cn/" });
    const command = calls[0]?.join(" ") ?? "";
    expect(command).toContain("--new-window");
    expect(command).not.toContain("&;");
    expect(calls[0]).toContain("-u");
  });
});
