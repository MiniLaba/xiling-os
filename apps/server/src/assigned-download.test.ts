import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { asksToDownload, firstPdfUrl, fulfillAssignedDownload, paperQuery } from "./assigned-download.js";
import { ComputerExecutor } from "./computer-executor.js";

describe("assigned desktop download", () => {
  it("saves the PDF from the reply onto the VM desktop", async () => {
    const calls: string[][] = [];
    const computer = new ComputerExecutor({
      localRoot: mkdtempSync(join(tmpdir(), "xiling-download-")),
      target: () => ({ target: "vm" }),
      ensureVm: async () => undefined,
      run: async (_file, args) => {
        calls.push(args);
        return { stdout: "saved:/headless/Desktop/attention_is_all_you_need.pdf\n", stderr: "" };
      },
    });
    const prompt = "把attention is all you need这篇论文下载到虚拟机桌面";
    const answer = "我无法直接操作虚拟机。PDF 链接：https://arxiv.org/pdf/1706.03762";
    const text = await fulfillAssignedDownload(computer, prompt, answer, [], async () => { throw new Error("不应再检索"); });
    expect(paperQuery(prompt)).toBe("attention is all you need");
    expect(firstPdfUrl(answer)).toBe("https://arxiv.org/pdf/1706.03762");
    expect(text).toBe("已把论文下载到当前电脑桌面：/headless/Desktop/attention_is_all_you_need.pdf");
    const command = calls[0]?.join(" ") ?? "";
    expect(command).toContain("https://arxiv.org/pdf/1706.03762");
    expect(command).toContain("python3");
    expect(command).toContain("XILING_MAX_BYTES=41943040");
    expect(command).toContain("Desktop");
    expect(command).not.toContain("&;");
    expect(asksToDownload("你好")).toBe(false);
  });

  it("does not download when the request names a later clock", async () => {
    const computer = new ComputerExecutor({
      localRoot: mkdtempSync(join(tmpdir(), "xiling-download-")),
      target: () => ({ target: "vm" }),
      run: async () => { throw new Error("不到点不应下载"); },
    });
    const text = await fulfillAssignedDownload(computer, "今天16：42帮我把attention is all you need这篇论文下载到桌面", "PDF：https://arxiv.org/pdf/1706.03762", []);
    expect(text).toBe("到今天 16:42 再执行：把attention is all you need这篇论文下载到桌面。点「加入」后才会到点开始。");
  });

  it("replaces a manual download guide even after the tool name was recorded", async () => {
    const computer = new ComputerExecutor({
      localRoot: mkdtempSync(join(tmpdir(), "xiling-download-")),
      target: () => ({ target: "vm" }),
      ensureVm: async () => undefined,
      run: async () => ({ stdout: "saved:/headless/Desktop/attention_is_all_you_need.pdf\n", stderr: "" }),
    });
    const answer = "我无法直接操作你的电脑。\n```bash\ncurl -L -o ~/Desktop/attention_is_all_you_need.pdf https://arxiv.org/pdf/1706.03762.pdf\n```";
    const text = await fulfillAssignedDownload(computer, "把attention is all you need这篇论文下载到桌面", answer, ["computer_download"], async () => { throw new Error("不应再检索"); });
    expect(text).toBe("已把论文下载到当前电脑桌面：/headless/Desktop/attention_is_all_you_need.pdf");
  });

  it("says the paper was not found when neither the reply nor the lookup has a PDF", async () => {
    const computer = new ComputerExecutor({
      localRoot: mkdtempSync(join(tmpdir(), "xiling-download-")),
      target: () => ({ target: "vm" }),
      run: async () => { throw new Error("不应下载"); },
    });
    const text = await fulfillAssignedDownload(computer, "把dytok这篇论文下载到桌面", "请提供论文标题。", [], async () => undefined);
    expect(text).toBe("没有找到「dytok」的论文 PDF，所以没有下载到桌面。请给出论文标题或 PDF 链接。");
  });
});
