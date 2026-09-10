// macOS seatbelt（sandbox-exec）隔离执行后端。
//
// 为什么选它：AGENTS.md 要求不引入 Docker/WSL 依赖，也禁止用宿主裸跑替代隔离。
// seatbelt 是 macOS 自带的强制访问控制机制（与 App Sandbox 同源），隔离由内核执行，
// 不依赖被测进程自我约束，也不需要额外安装任何东西。
//
// 踩过的三个坑（都会让策略静默失效或被内核 SIGABRT，必须记住）：
// 1. seatbelt 用**解析后的真实路径**匹配。mkdtemp 给出 /var/folders/...，而内核看到的是
//    /private/var/folders/...。所有路径必须 realpath 后再写进 profile，否则放开项形同不存在。
// 2. `/dev/null`、`/dev/urandom` 是设备文件，必须用 (literal ...)；(subpath ...) 匹配的是
//    其子路径，对设备文件永远不命中。
// 3. macOS 的 `/bin/sh` 与 `/usr/bin/python3` 都是**转发桩**：前者 exec /bin/bash，后者 exec
//    CLT/Xcode 里的真实 python。只白名单桩路径会导致 SIGABRT（且没有任何 stderr）。
//    因此解释器必须探测出真实路径，桩与真实二进制一并进入 exec 白名单。
//
// 真实能力边界（不得营销化改写）：
// - 文件系统：只读「代码目录 + 输入目录 + 系统只读区」，只写 scratch 目录。
// - 网络：全部拒绝。seatbelt 无法按主机名 allowlist，故计划要求 allowlist 时**拒绝执行**。
// - 进程：exec 白名单只有 sh/bash/解释器；派生其他二进制被内核拒绝。
// - 资源：wall-clock 超时（kill）+ CPU 时间上限（RLIMIT_CPU）+ 输出字节上限。
//   seatbelt 不提供内存硬上限，RLIMIT_AS 在 Darwin 上不生效 —— 这一项不声明支持。

import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { release } from "node:os";
import path from "node:path";

export interface InterpreterResolution {
  /** 入口路径（macOS 上通常是转发桩）。 */
  launcher: string;
  /** 桩最终 exec 到的真实解释器。 */
  interpreter: string;
  version: string;
}

/** 探测解释器。转发桩的真实路径只能由解释器自己回答（sys.executable）。 */
export function resolveInterpreter(candidates: string[] = ["/usr/bin/python3"]): InterpreterResolution | undefined {
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ["-c", "import sys; print(sys.executable); print(sys.version.split()[0])"], {
      encoding: "utf8", timeout: 15_000, env: { PATH: "/usr/bin:/bin" },
    });
    if (probe.status !== 0) continue;
    const [executable, version] = (probe.stdout ?? "").trim().split("\n");
    if (!executable || !existsSync(executable)) continue;
    return { launcher: realpathFor(candidate), interpreter: realpathFor(executable), version: version ?? "unknown" };
  }
  return undefined;
}

export interface SeatbeltProbe {
  available: boolean;
  binary?: string;
  osRelease?: string;
  interpreter?: InterpreterResolution;
  reason?: string;
}

export function probeSeatbelt(binary = "/usr/bin/sandbox-exec"): SeatbeltProbe {
  if (process.platform !== "darwin") {
    return { available: false, reason: `seatbelt 是 macOS 机制，当前平台为 ${process.platform}（不做宿主裸跑回退）` };
  }
  if (!existsSync(binary)) return { available: false, reason: `未找到 ${binary}` };
  const interpreter = resolveInterpreter();
  if (!interpreter) return { available: false, reason: "未找到可用的 python3 解释器" };
  return { available: true, binary, osRelease: release(), interpreter };
}

export interface SeatbeltExecAllowance {
  kind: "literal" | "subpath";
  path: string;
}

export interface SeatbeltPolicy {
  /**
   * 显式声明的输入：代码目录 + 输入目录。它们会被**单独再放行一次**，
   * 因此即便落在下面的敏感区内也仍然可读（调用方明确声明过它们是输入）。
   */
  readPaths: string[];
  /** 唯一可写目录。 */
  writablePaths: string[];
  /** 允许被 exec 的二进制白名单。 */
  execAllowances: SeatbeltExecAllowance[];
  /** 允许脚本派生进程（默认不允许：单脚本计算不需要 fork）。 */
  allowFork: boolean;
  /** 显式拒绝读取的敏感区。 */
  deniedReadPaths: string[];
}

/**
 * 默认拒绝读取的敏感区。
 *
 * 为什么用"允许根 + 显式拒绝"而不是"枚举解释器需要的目录"：
 * 枚举法极其脆弱——解释器内部实现一变（例如桩多读一个 framework 路径）就会让整个策略
 * 变成 SIGABRT 且 stderr 全空，排查成本极高，还容易在"修好"的过程中把放开面越放越宽。
 * deny 模型下漏掉一个系统路径只会让进程启动失败得更早、更容易发现，而敏感数据始终被拒绝。
 */
export const DEFAULT_DENIED_READ_PATHS = [
  "/Users",            // 宿主家目录：口令、密钥、其他项目数据
  "/Volumes",          // 外接与网络卷
  "/Applications",     // 用户安装的应用
  "/private/etc",      // /etc：系统配置与影子口令
  "/private/tmp",      // 共享临时区：其他进程的数据
  "/private/var/root", // root 家目录
  "/cores",            // 崩溃转储
];

/** 解释器启动需要读的设备文件（必须是 literal：(subpath "/dev/null") 永远不命中）。 */
export const DEVICE_READ_LITERALS = ["/dev/null", "/dev/urandom", "/dev/random"];
/** 允许写入的设备文件。 */
export const DEVICE_WRITE_LITERALS = ["/dev/null", "/dev/stdout", "/dev/stderr"];

export function seatbeltProfile(policy: SeatbeltPolicy): string {
  const literal = (value: string) => JSON.stringify(value);
  const subpaths = (values: string[]) => values.map((value) => `(subpath ${literal(realpathFor(value))})`).join(" ");
  const literals = (values: string[]) => values.map((value) => `(literal ${literal(realpathFor(value))})`).join(" ");
  const execFilters = policy.execAllowances
    .map((allowance) => `(${allowance.kind} ${literal(realpathFor(allowance.path))})`)
    .join(" ");
  const lines = [
    "(version 1)",
    ";; 默认全部拒绝：文件、网络、进程、IPC 都必须显式放开（SBPL 后匹配规则优先）",
    "(deny default)",
    ";; 解释器启动需要读 sysctl、元数据与 Mach 服务；这三项不泄露文件内容",
    "(allow sysctl-read)",
    "(allow file-read-metadata)",
    "(allow mach-lookup)",
    `(allow process-exec ${execFilters})`,
    policy.allowFork ? "(allow process-fork)" : "(deny process-fork)",
    ";; 读取模型：允许根（解释器需要什么系统路径都不必枚举），再显式拒绝敏感区",
    `(allow file-read* ${subpaths(["/"])})`,
    policy.deniedReadPaths.length === 0 ? "" : `(deny file-read* ${subpaths(policy.deniedReadPaths)})`,
    ";; 调用方显式声明的输入放在拒绝之后：即便输入位于敏感区也仍然可读",
    `(allow file-read* ${subpaths(policy.readPaths)} ${literals(DEVICE_READ_LITERALS)})`,
    `(allow file-write* ${subpaths(policy.writablePaths)} ${literals(DEVICE_WRITE_LITERALS)})`,
    ";; 网络显式拒绝：default deny 已覆盖，这里写明意图供审计",
    "(deny network*)",
  ];
  return `${lines.filter((line) => line !== "").join("\n")}\n`;
}

/**
 * 解释器的 exec 白名单。
 *
 * 坑：`/usr/bin/python3` 是转发桩，它 posix_spawn 的不是 `sys.executable`
 * （`.../Versions/3.9/bin/python3.9`），而是
 * `.../Versions/3.9/Resources/Python.app/Contents/MacOS/Python`。
 * 只按 sys.executable 授权会得到 `posix_spawn: ... Operation not permitted`。
 * 因此除桩与 sys.executable 之外，放行整个 framework 版本目录
 * （其内只有 Python 自身的二进制，不扩大可执行面到任意宿主程序）。
 */
export function interpreterExecAllowances(resolution: InterpreterResolution): SeatbeltExecAllowance[] {
  const allowances: SeatbeltExecAllowance[] = [
    { kind: "literal", path: "/bin/sh" },
    { kind: "literal", path: "/bin/bash" },
    { kind: "literal", path: resolution.launcher },
    { kind: "literal", path: resolution.interpreter },
  ];
  const versionRoot = frameworkVersionRoot(resolution.interpreter);
  if (versionRoot !== undefined) allowances.push({ kind: "subpath", path: versionRoot });
  return allowances;
}

/** 从解释器路径推出 framework 版本目录，例如 .../Python3.framework/Versions/3.9。 */
export function frameworkVersionRoot(executable: string): string | undefined {
  const parts = executable.split("/");
  const index = parts.indexOf("Versions");
  if (index < 0 || index + 2 >= parts.length) return undefined;
  return parts.slice(0, index + 2).join("/");
}

export interface SeatbeltRunInput {
  /** 唯一可执行脚本的路径。 */
  scriptPath: string;
  /** 只读输入目录。 */
  inputsDir: string;
  /** 唯一可写目录；脚本产物写在这里。 */
  scratchDir: string;
  /** 传给脚本的计划参数（JSON 文本）。 */
  parametersJson: string;
  /** wall-clock 超时（毫秒）。 */
  timeoutMs: number;
  /** CPU 时间上限（秒），通过 RLIMIT_CPU 施加。 */
  cpuSeconds: number;
  /** 解释器解析结果（含转发桩与真实路径；两者都会进 exec 白名单）。 */
  interpreter: InterpreterResolution;
  /** 允许脚本派生进程；默认 false。 */
  allowFork?: boolean;
  /** 覆盖默认的敏感区拒绝清单（仅测试需要）。 */
  deniedReadPaths?: string[];
  signal?: AbortSignal | undefined;
  /** 单流输出上限（字节），防止 stdout 撑爆内存。 */
  maxOutputBytes?: number;
}

export interface SeatbeltArtifact {
  name: string;
  bytes: number;
  sha256: string;
}

export interface SeatbeltRunOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
  startedAt: string;
  finishedAt: string;
  /** 隔离策略指纹，随结果留档：策略变了，环境摘要必须跟着变。 */
  policyDigest: string;
  /** 环境摘要 = 平台 + 解释器 + 隔离策略。它替代容器镜像 digest。 */
  environmentDigest: string;
  artifacts: SeatbeltArtifact[];
  /** 本次执行被施加的限制，作为"隔离真的生效"的可读证据。 */
  enforced: string[];
}

/**
 * 在 seatbelt 里运行一个脚本。脚本 ABI：
 *   python3 <script> --inputs <dir> --scratch <dir> --parameters <json>
 * 脚本必须把产物写进 scratch。
 */
export async function runInSeatbelt(input: SeatbeltRunInput): Promise<SeatbeltRunOutput> {
  const probe = probeSeatbelt();
  if (probe.available !== true || probe.binary === undefined) throw new Error(`seatbelt 不可用：${probe.reason ?? "未知原因"}`);
  if (!existsSync(input.scriptPath)) throw new Error(`待执行脚本不存在：${input.scriptPath}`);
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) throw new Error("超时必须为正数");
  if (!Number.isFinite(input.cpuSeconds) || input.cpuSeconds <= 0) throw new Error("CPU 上限必须为正数");
  mkdirSync(input.scratchDir, { recursive: true });
  mkdirSync(input.inputsDir, { recursive: true });

  // 全部路径先 realpath：否则 /var → /private/var 这类 firmlink 会让放开项形同不存在
  const scriptPath = realpathFor(input.scriptPath);
  const inputsDir = realpathFor(input.inputsDir);
  const scratchDir = realpathFor(input.scratchDir);
  const { launcher, interpreter, version } = input.interpreter;

  const policy: SeatbeltPolicy = {
    // scratch 必须同时可读：脚本要能读回自己写的中间产物；否则生产布局下
    // （run root 位于 /Users 内的被拒区）getcwd 与二次读取都会失败
    readPaths: [path.dirname(scriptPath), inputsDir, scratchDir],
    writablePaths: [scratchDir],
    execAllowances: interpreterExecAllowances(input.interpreter),
    allowFork: input.allowFork === true,
    deniedReadPaths: input.deniedReadPaths ?? DEFAULT_DENIED_READ_PATHS,
  };
  const profile = seatbeltProfile(policy);
  const policyDigest = digestOf(profile);
  const policyPath = path.join(scratchDir, ".seatbelt-profile.sb");
  writeFileSync(policyPath, profile, { mode: 0o600 });

  const scriptArgs = ["--inputs", inputsDir, "--scratch", scratchDir, "--parameters", input.parametersJson];
  const command = [launcher, scriptPath, ...scriptArgs].map(quoteForShell).join(" ");
  const shellCommand = `ulimit -t ${Math.floor(input.cpuSeconds)} 2>/dev/null; exec ${command}`;

  const maxOutput = input.maxOutputBytes ?? 1024 * 1024;
  const startedAt = new Date().toISOString();
  return await new Promise<SeatbeltRunOutput>((resolve, reject) => {
    const child = spawn(probe.binary!, ["-f", policyPath, "--", "/bin/sh", "-c", shellCommand], {
      cwd: scratchDir,
      env: { PATH: "/usr/bin:/bin", HOME: scratchDir, TMPDIR: scratchDir, LC_ALL: "C", PYTHONDONTWRITEBYTECODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = ""; let stderr = ""; let overflow = false; let settled = false;
    const collect = (target: "out" | "err") => (chunk: Buffer) => {
      if (overflow) return;
      if (target === "out") stdout += chunk.toString("utf8"); else stderr += chunk.toString("utf8");
      if (stdout.length + stderr.length > maxOutput) { overflow = true; try { child.kill("SIGKILL"); } catch { /* 已退出 */ } }
    };
    child.stdout.on("data", collect("out"));
    child.stderr.on("data", collect("err"));
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* 已退出 */ } }, input.timeoutMs);
    const onAbort = () => { try { child.kill("SIGKILL"); } catch { /* 已退出 */ } };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => { clearTimeout(timer); input.signal?.removeEventListener("abort", onAbort); };
    child.on("error", (error) => { if (settled) return; settled = true; cleanup(); reject(error); });
    child.on("close", (code, signalName) => {
      if (settled) return; settled = true; cleanup();
      const finishedAt = new Date().toISOString();
      if (input.signal?.aborted === true) { reject(new Error("执行被取消")); return; }
      if (signalName === "SIGKILL") { reject(new Error(`执行超时（${input.timeoutMs}ms）已终止`)); return; }
      if (overflow) { reject(new Error(`输出超过上限 ${maxOutput} 字节，已终止`)); return; }
      if (signalName !== null) { reject(new Error(`沙箱内进程被信号 ${signalName} 终止（exitCode 不可用）`)); return; }
      resolve({
        exitCode: code ?? -1, stdout, stderr, startedAt, finishedAt, policyDigest,
        environmentDigest: digestOf([process.platform, release(), launcher, interpreter, version, statSync(interpreter).mtime.toISOString(), policyDigest].join("\n")),
        artifacts: collectArtifacts(scratchDir),
        enforced: [
          "filesystem: 写仅限 scratch 目录",
          `filesystem: 拒绝读取敏感区（${(input.deniedReadPaths ?? DEFAULT_DENIED_READ_PATHS).join("、")}）`,
          "network: 全部拒绝",
          "process: exec 白名单（sh/bash/解释器 framework）",
          `cpu: RLIMIT_CPU=${Math.floor(input.cpuSeconds)}s`,
          `wall-clock: ${input.timeoutMs}ms`,
          `output: ${maxOutput}B/流`,
        ],
      });
    });
  });
}

function collectArtifacts(scratchDir: string): SeatbeltArtifact[] {
  const found: SeatbeltArtifact[] = [];
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".seatbelt-profile.sb") continue;
      const absolute = path.join(directory, entry.name);
      const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) { walk(absolute, name); continue; }
      if (!entry.isFile()) continue;
      const bytes = readFileSync(absolute);
      found.push({ name, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
  };
  walk(scratchDir, "");
  return found;
}

/** realpath 失败时退回原值（路径可能尚不存在）。 */
function realpathFor(value: string): string {
  try { return realpathSync(value); } catch { return value; }
}

function digestOf(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function quoteForShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
