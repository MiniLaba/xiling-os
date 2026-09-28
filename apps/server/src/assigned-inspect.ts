import { ComputerExecutor } from "./computer-executor.js";
import { deferredAssignmentReply } from "./deferred-assignment.js";

const LIST_INTENT = /有哪些文件|哪些文件|哪些文件夹|文件或文件夹|列出|目录下|目录里|文件夹里|看看这个目录/u;
const MANUAL_GUIDE = /我无法|请你|你可以|终端中|```|自己查看|自己运行|自己执行|bash/iu;

export function asksToListDirectory(prompt: string): boolean {
  return LIST_INTENT.test(prompt) && directoryPath(prompt) !== undefined;
}

export function directoryPath(prompt: string): string | undefined {
  const match = prompt.match(/(\/(?:[\w.-]+\/)*[\w.-]+)/u);
  const path = match?.[1];
  if (!path) return undefined;
  if (path.split("/").some((part) => part === "." || part === "..")) return undefined;
  return path;
}

function listingCommand(path: string): string {
  return `ls -1ap -- '${path.replaceAll("'", `'\\''`)}'`;
}

function visibleNames(stdout: string): string[] {
  return stdout.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line && line !== "./" && line !== "../");
}

function remoteFailure(stderr: string, path: string): string {
  const detail = stderr.replace(/\s+/gu, " ").trim().slice(0, 400);
  if (/publickey|permission denied/iu.test(detail)) return `没有连上远程主机，所以没有列出 ${path}。这台电脑还没有对该主机免密登录，请先配置 SSH 密钥后再交办。${detail}`;
  if (/timed out|connection refused|could not resolve|no route to host/iu.test(detail)) return `没有连上远程主机，所以没有列出 ${path}。${detail}`;
  return `没有列出 ${path}：${detail || "未知原因"}`;
}

export async function fulfillAssignedInspect(computer: ComputerExecutor, prompt: string, answer: string, toolNames: string[]): Promise<string> {
  const path = directoryPath(prompt);
  if (!path || !asksToListDirectory(prompt)) return answer;
  const waiting = deferredAssignmentReply(prompt);
  if (waiting) return waiting;
  if (toolNames.includes("computer_shell") && !MANUAL_GUIDE.test(answer)) return answer;
  let payload: { stdout?: string; stderr?: string };
  try { payload = JSON.parse(await computer.shell(listingCommand(path))) as typeof payload; }
  catch (error) { return `没有列出 ${path}：${error instanceof Error ? error.message : String(error)}`; }
  const names = visibleNames(payload.stdout ?? "");
  if (!names.length) {
    const stderr = (payload.stderr ?? "").trim();
    if (stderr) return remoteFailure(stderr, path);
    return `${path} 下没有文件或文件夹。`;
  }
  return `${path} 下有这些文件和文件夹：\n${names.join("\n")}`;
}
