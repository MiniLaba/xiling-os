import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { asksToListDirectory, fulfillAssignedInspect } from "./assigned-inspect.js";
import { ComputerExecutor } from "./computer-executor.js";

function computer(run: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>) {
  return new ComputerExecutor({
    localRoot: mkdtempSync(join(tmpdir(), "xiling-inspect-")),
    target: () => ({ target: "ssh", sshHost: "drm@10.102.32.223" }),
    run: async (file, args) => run(file, args),
  });
}

const essay = "我无法直接访问您本地计算机的文件系统。可以在终端中运行：\n```bash\nls /home/drm\n```";

describe("assigned remote directory listing", () => {
  it("lists the directory on the saved SSH host instead of keeping the manual steps", async () => {
    const calls: string[] = [];
    const text = await fulfillAssignedInspect(computer(async (file, args) => {
      calls.push([file, ...args].join(" "));
      return { stdout: "./\n../\nDesktop/\nnotes.txt\n", stderr: "" };
    }), "告诉我/home/drm下有哪些文件或文件夹", essay, []);
    expect(text).toBe("/home/drm 下有这些文件和文件夹：\nDesktop/\nnotes.txt");
    expect(calls[0]).toContain("drm@10.102.32.223");
    expect(calls[0]).toContain("ls -1ap -- '/home/drm'");
    expect(asksToListDirectory("你好")).toBe(false);
  });

  it("still lists when the model both called the shell and wrote a guide", async () => {
    const text = await fulfillAssignedInspect(computer(async () => ({ stdout: "paper.pdf\n", stderr: "" })), "告诉我/home/drm下有哪些文件或文件夹", essay, ["computer_shell"]);
    expect(text).toBe("/home/drm 下有这些文件和文件夹：\npaper.pdf");
  });

  it("keeps a reply that already came from the shell", async () => {
    const answer = "/home/drm 下有 Desktop 和 notes.txt。";
    await expect(fulfillAssignedInspect(computer(async () => { throw new Error("不应再次列出"); }), "告诉我/home/drm下有哪些文件或文件夹", answer, ["computer_shell"])).resolves.toBe(answer);
  });

  it("reports a missing SSH key without running a second interpretation of the guide", async () => {
    const text = await fulfillAssignedInspect(computer(async () => ({ stdout: "", stderr: "drm@10.102.32.223: Permission denied (publickey)." })), "告诉我/home/drm下有哪些文件或文件夹", essay, []);
    expect(text).toContain("免密登录");
    expect(text).toContain("publickey");
  });
});
