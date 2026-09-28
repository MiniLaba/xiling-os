import { Type } from "typebox";
import type { RuntimeTool } from "@xiling/pi-runtime";
import type { ComputerExecutor } from "./computer-executor.js";

const done = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }], details: value });

export function createComputerTools(computer: ComputerExecutor): RuntimeTool<any>[] {
  return [
    {
      name: "computer_browse",
      label: "在当前电脑打开网页",
      description: "在用户选定的执行目标上打开一个 http(s) 网址。虚拟机里会在桌面浏览器中打开，Bot 窗口能看到；本机会在这台 Windows 上打开；SSH 会取回页面正文。用户要求打开网站时必须调用本工具，不要只回复链接。",
      parameters: Type.Object({ url: Type.String({ minLength: 8, maxLength: 2_000 }) }, { additionalProperties: false }),
      execute: async (_callId, params) => done(await computer.browse((params as { url: string }).url)),
    },
    {
      name: "computer_download",
      label: "下载文件到桌面",
      description: "把用户点名的单个 http(s) 文件下载到当前电脑桌面。论文请传 PDF 直链。单个文件不超过 40MB。用户要求下载到桌面时必须调用本工具，不要写成操作步骤。",
      parameters: Type.Object({ url: Type.String({ minLength: 8, maxLength: 2_000 }) }, { additionalProperties: false }),
      execute: async (_callId, params) => done(await computer.downloadToDesktop((params as { url: string }).url, "paper")),
    },
    {
      name: "computer_shell",
      label: "在当前电脑运行命令",
      description: "在当前执行目标上运行一条命令。虚拟机和 SSH 使用 bash；本机使用 PowerShell。用户询问远程或本机某个目录里有哪些文件时，用 ls 列出后直接回答，不要写成终端步骤。正式结论数据库和大规模下载会被拒绝。",
      parameters: Type.Object({ command: Type.String({ minLength: 1, maxLength: 4_000 }) }, { additionalProperties: false }),
      execute: async (_callId, params) => done(await computer.shell((params as { command: string }).command)),
    },
    {
      name: "computer_read",
      label: "读取当前电脑上的文件",
      description: "读取当前执行目标工作目录中的文本文件。虚拟机路径在 /workspace 下，本机路径在 Bot 工作目录下。",
      parameters: Type.Object({ path: Type.String({ minLength: 1, maxLength: 300 }) }, { additionalProperties: false }),
      execute: async (_callId, params) => done(await computer.readFile((params as { path: string }).path)),
    },
    {
      name: "computer_write",
      label: "写入当前电脑上的文件",
      description: "把文本写入当前执行目标的工作目录。虚拟机写入 /workspace，本机写入 Bot 工作目录。不要用它修改正式科研结论。",
      parameters: Type.Object({ path: Type.String({ minLength: 1, maxLength: 300 }), content: Type.String({ maxLength: 100_000 }) }, { additionalProperties: false }),
      execute: async (_callId, params) => {
        const input = params as { path: string; content: string };
        return done(await computer.writeFile(input.path, input.content));
      },
    },
  ];
}
