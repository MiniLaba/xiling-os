import { ComputerExecutor, desktopFileName, publicHttpUrl } from "./computer-executor.js";
import { deferredAssignmentReply } from "./deferred-assignment.js";

const DOWNLOAD_ACTION = /下载/u;
const DOWNLOAD_TARGET = /桌面|虚拟机|论文|pdf|文件/iu;

export function asksToDownload(prompt: string): boolean {
  return DOWNLOAD_ACTION.test(prompt) && DOWNLOAD_TARGET.test(prompt);
}

export function paperQuery(prompt: string): string {
  const match = prompt.match(/把\s*(.+?)\s*(?:这篇|这本)?论文?\s*下载/u) ?? prompt.match(/下载\s*(.+?)\s*(?:到|至)/u);
  return (match?.[1] ?? "").replace(/[《》"'“”]/gu, "").trim();
}

export function firstPdfUrl(text: string): string | undefined {
  const matches = [...text.matchAll(/https?:\/\/[^\s<>"')\]]+/giu)].map((match) => match[0].replace(/[.,;:!?）】*]+$/u, ""));
  const chosen = matches.find((url) => /\/pdf\/|\.pdf(?:$|\?)/iu.test(url)) ?? matches.find((url) => /arxiv\.org\/abs\//iu.test(url));
  if (!chosen) return undefined;
  const pdf = chosen.replace(/arxiv\.org\/abs\//iu, "arxiv.org/pdf/").replace(/v\d+$/u, "");
  try { return publicHttpUrl(pdf); }
  catch { return undefined; }
}

export async function lookupArxivPdf(query: string): Promise<string | undefined> {
  const normalized = query.trim();
  if (normalized.length < 2) return undefined;
  const response = await fetch(`https://export.arxiv.org/api/query?search_query=${encodeURIComponent(`ti:"${normalized}"`)}&max_results=1`, { signal: AbortSignal.timeout(12_000) });
  if (!response.ok) return undefined;
  const entry = (await response.text()).match(/<entry>[\s\S]*?<\/entry>/u)?.[0];
  if (!entry) return undefined;
  const title = entry.match(/<title>([\s\S]*?)<\/title>/u)?.[1]?.replace(/\s+/gu, " ").trim() ?? "";
  const id = entry.match(/<id>\s*(https?:\/\/arxiv\.org\/abs\/[^<\s]+)\s*<\/id>/u)?.[1];
  if (!title || !id) return undefined;
  const compact = (value: string) => value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/giu, "");
  const wanted = compact(normalized);
  const found = compact(title);
  if (!found.includes(wanted) && !wanted.includes(found)) return undefined;
  return firstPdfUrl(id);
}

export async function fulfillAssignedDownload(computer: ComputerExecutor, prompt: string, answer: string, toolNames: string[], lookup: (query: string) => Promise<string | undefined> = lookupArxivPdf): Promise<string> {
  if (!asksToDownload(prompt)) return answer;
  const waiting = deferredAssignmentReply(prompt);
  if (waiting) return waiting;
  if (toolNames.includes("computer_download") && !/我无法|请你|你可以|点击|curl\b|Invoke-WebRequest|方法[一二三]|powershell|Ctrl\s*\+\s*S|自己保存|自己下载|浏览器下载/iu.test(answer)) return answer;
  const query = paperQuery(prompt);
  const url = firstPdfUrl(prompt) ?? firstPdfUrl(answer) ?? (query ? await lookup(query).catch(() => undefined) : undefined);
  if (!url) return query ? `没有找到「${query}」的论文 PDF，所以没有下载到桌面。请给出论文标题或 PDF 链接。` : answer;
  let payload: { success?: boolean; path?: string; message?: string };
  try { payload = JSON.parse(await computer.downloadToDesktop(url, desktopFileName(query || "paper", url).replace(/\.pdf$/iu, ""))) as typeof payload; }
  catch (error) { return `论文没有下载到桌面：${error instanceof Error ? error.message : String(error)}`; }
  if (!payload.success || !payload.path) return `论文没有下载到桌面：${payload.message ?? "未知原因"}`;
  return `已把论文下载到当前电脑桌面：${payload.path}`;
}
