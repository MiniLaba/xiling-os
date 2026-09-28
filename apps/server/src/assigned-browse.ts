import { ComputerExecutor, publicHttpUrl } from "./computer-executor.js";
import { deferredAssignmentReply } from "./deferred-assignment.js";

const OPEN_ACTION = /打开|访问|浏览|open\b/iu;
const OPEN_TARGET = /官网|网站|网页|首页|浏览器|网址|页面/u;

export function asksToOpenPage(prompt: string): boolean {
  if (OPEN_ACTION.test(prompt) && /https?:\/\//iu.test(prompt)) return true;
  return OPEN_ACTION.test(prompt) && OPEN_TARGET.test(prompt);
}

const KNOWN_PAGES: Array<[RegExp, string]> = [
  [/山东大学本科生院/u, "http://www.bkjx.sdu.edu.cn/"],
  [/山东大学/u, "https://www.sdu.edu.cn/"],
];

export function firstHttpUrl(text: string): string | undefined {
  const match = text.match(/https?:\/\/[^\s<>"')\]]+/iu);
  if (!match?.[0]) return undefined;
  try { return publicHttpUrl(match[0].replace(/[.,;:!?）】*]+$/u, "")); }
  catch { return undefined; }
}

export function pageUrl(prompt: string, answer: string): string | undefined {
  return firstHttpUrl(prompt) ?? firstHttpUrl(answer) ?? KNOWN_PAGES.find(([pattern]) => pattern.test(`${prompt}\n${answer}`))?.[1];
}

export async function fulfillAssignedBrowse(computer: ComputerExecutor, prompt: string, answer: string, toolNames: string[]): Promise<string> {
  if (!asksToOpenPage(prompt)) return answer;
  const waiting = deferredAssignmentReply(prompt);
  if (waiting) return waiting;
  if (toolNames.includes("computer_browse") && !/我无法|请你|你可以|点击|curl\b|方法[一二三]|powershell|自己打开|自己操作/iu.test(answer)) return answer;
  const url = pageUrl(prompt, answer);
  if (!url) return answer;
  let payload: { success?: boolean; url?: string; title?: string; message?: string; surface?: string };
  try { payload = JSON.parse(await computer.browse(url)) as typeof payload; }
  catch (error) { return `${answer}\n\n页面没有打开：${error instanceof Error ? error.message : String(error)}`; }
  if (!payload.success) return `${answer}\n\n页面没有打开 ${url}：${payload.message ?? "未知原因"}`;
  const opened = payload.url ?? url;
  const title = payload.title?.trim();
  if (payload.surface === "ssh") return `已从远程主机取回 ${opened}。`;
  if (payload.surface === "local") return `已在本机打开 ${opened}。`;
  return title ? `已在当前电脑的桌面浏览器打开 ${opened}。首页标题：${title}` : `已在当前电脑的桌面浏览器打开 ${opened}。`;
}
