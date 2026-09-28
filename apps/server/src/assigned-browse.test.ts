import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { asksToOpenPage, fulfillAssignedBrowse } from "./assigned-browse.js";
import { ComputerExecutor } from "./computer-executor.js";

describe("assigned desktop browse", () => {
  it("opens the URL from a link-only reply on the desktop", async () => {
    const calls: string[][] = [];
    const computer = new ComputerExecutor({
      localRoot: mkdtempSync(join(tmpdir(), "xiling-assigned-")),
      target: () => ({ target: "vm" }),
      ensureVm: async () => undefined,
      run: async (_file, args) => {
        calls.push(args);
        return { stdout: "opened\ntitle:山东大学本科生院\n", stderr: "" };
      },
    });
    const text = await fulfillAssignedBrowse(computer, "打开山东大学本科生院官网，记下首页标题", "你可以点击 http://www.bkjx.sdu.edu.cn/ 自己打开。", []);
    expect(text).toBe("已在当前电脑的桌面浏览器打开 http://www.bkjx.sdu.edu.cn/。首页标题：山东大学本科生院");
    expect(calls[0]?.join(" ")).toContain("http://www.bkjx.sdu.edu.cn/");
    expect(asksToOpenPage("你好")).toBe(false);
  });

  it("leaves the reply unchanged after computer_browse already succeeded", async () => {
    const computer = new ComputerExecutor({
      localRoot: mkdtempSync(join(tmpdir(), "xiling-assigned-")),
      target: () => ({ target: "vm" }),
      run: async () => { throw new Error("不应再次打开"); },
    });
    const answer = "已在桌面打开。";
    await expect(fulfillAssignedBrowse(computer, "打开山东大学官网首页", answer, ["computer_browse"])).resolves.toBe(answer);
  });

  it("opens a known campus site when the model never returns a URL", async () => {
    const calls: string[][] = [];
    const computer = new ComputerExecutor({
      localRoot: mkdtempSync(join(tmpdir(), "xiling-assigned-")),
      target: () => ({ target: "vm" }),
      ensureVm: async () => undefined,
      run: async (_file, args) => {
        calls.push(args);
        return { stdout: "opened\ntitle:山东大学\n", stderr: "" };
      },
    });
    const text = await fulfillAssignedBrowse(computer, "打开山东大学官网", "", []);
    expect(text).toContain("https://www.sdu.edu.cn/");
    expect(calls[0]?.join(" ")).toContain("https://www.sdu.edu.cn/");
  });

  it("waits for a named clock instead of opening the page now", async () => {
    const computer = new ComputerExecutor({
      localRoot: mkdtempSync(join(tmpdir(), "xiling-assigned-")),
      target: () => ({ target: "vm" }),
      run: async () => { throw new Error("不到点不应打开"); },
    });
    const text = await fulfillAssignedBrowse(computer, "早上11点6分打开山东大学官网", "", []);
    expect(text).toBe("到每天 11:06 再执行：打开山东大学官网。点「加入」后才会到点开始。");
  });

  it("reports a remote fetch instead of a desktop browser when the target is SSH", async () => {
    const computer = new ComputerExecutor({
      localRoot: mkdtempSync(join(tmpdir(), "xiling-assigned-")),
      target: () => ({ target: "ssh", sshHost: "drm@10.102.32.223" }),
      run: async () => ({ stdout: "<html><title>山东大学</title></html>", stderr: "" }),
    });
    const text = await fulfillAssignedBrowse(computer, "打开 https://www.sdu.edu.cn/", "请你自己打开。", []);
    expect(text).toBe("已从远程主机取回 https://www.sdu.edu.cn/。");
  });
});
