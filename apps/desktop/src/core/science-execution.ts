// 科研执行端口：把 macOS seatbelt 沙箱接到 ScienceService 的契约上。
//
// 分层理由：ScienceService 在 os-kernel 里定义端口，具体隔离后端由宿主装配
// （OSKernel 的 scienceExecution 选项）。@xiling/execution 是通用的 OS 级隔离包，
// 不依赖 Electron，也不依赖科研领域类型。
//
// 三条不许打折的规则（来自 AGENTS.md）：
// - 没有通过验收的沙箱就如实报不可用，绝不用 fixture 成功或宿主裸跑顶替。
// - 计划要求的能力（这里是网络 allowlist）如果做不到，必须**拒绝执行**，
//   不能"忽略网络要求照跑"。
// - 代码与输入都必须校验哈希后才执行：批准过的东西和实际执行的东西必须一致。

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { probeSeatbelt, runInSeatbelt, type InterpreterResolution, type SeatbeltRunOutput } from "@xiling/execution";
import type {
  ScienceExecutionAdapterDeclaration,
  ScienceExecutionOutput,
  ScienceExecutionPort,
  ScienceExecutionResult,
  ScienceExecutionSpec,
} from "@xiling/os-kernel";

export const SEATBELT_ADAPTER_ID = "macos-seatbelt";

export interface ScienceExecutionPortOptions {
  /** 运行根目录：每次执行的 code/inputs/scratch 落在它下面，便于审计与留证。 */
  runRoot: string;
  /** 回收上一进程遗留的执行记录条数（由宿主基于执行仓库提供）。 */
  recoverInterrupted?: (() => number) | undefined;
  /** 允许读取的敏感区覆盖（仅测试用）。 */
  deniedReadPaths?: string[] | undefined;
}

/** 适配器不可用时的声明：与内核默认一致地如实说明"不可执行"。 */
function unavailableDeclaration(reason: string): ScienceExecutionAdapterDeclaration {
  return {
    id: "unavailable",
    label: "安全执行后端未安装",
    available: false,
    reason,
    isolation: {
      filesystem: "none",
      network: "none",
      resourceLimits: false,
      processLimit: false,
      enforced: [],
      notEnforced: ["文件系统隔离", "网络隔离", "资源上限", "进程限制", "可执行文件白名单"],
    },
    implementationVersion: "0.0.0",
  };
}

export function createScienceExecutionPort(options: ScienceExecutionPortOptions): ScienceExecutionPort {
  const declarations = (): ScienceExecutionAdapterDeclaration[] => {
    const probe = probeSeatbelt();
    if (probe.available !== true || probe.interpreter === undefined) {
      return [unavailableDeclaration(probe.reason ?? "seatbelt 不可用")];
    }
    const interpreter = probe.interpreter;
    return [{
      id: SEATBELT_ADAPTER_ID,
      label: `macOS seatbelt 沙箱（Python ${interpreter.version}）`,
      available: true,
      isolation: {
        // 写只落在 scratch；读取允许系统区但显式拒绝敏感区（家目录、外接卷、/etc 等）
        filesystem: "workspace",
        network: "none",
        resourceLimits: true,
        processLimit: true,
        enforced: [
          "写入：仅允许 scratch 目录，scratch 之外一律拒绝",
          "读取：拒绝 /Users、/Volumes、/Applications、/private/etc、/private/tmp、/private/var/root、/cores",
          "网络：全部拒绝（network* 显式 deny）",
          "进程：exec 白名单只含 /bin/sh、/bin/bash 与解释器自身 framework",
          "进程：默认禁止 fork（脚本无法派生其他进程）",
          "资源：wall-clock 超时 + RLIMIT_CPU + 每流输出字节上限",
        ],
        notEnforced: [
          "内存硬上限（seatbelt 无此能力，RLIMIT_AS 在 Darwin 不生效）",
          "按主机名的网络 allowlist（计划要求 allowlist 时本适配器拒绝执行，而不是放宽网络）",
          "系统只读区之外的一般性读取限制（默认允许读根，仅上面列出的敏感区被拒绝）",
        ],
      },
      implementationVersion: "1.0.0",
    }];
  };

  return {
    declarations,
    recoverInterrupted: () => options.recoverInterrupted?.() ?? 0,
    async run(spec: ScienceExecutionSpec, adapterId: string, signal: AbortSignal) {
      const declaration = declarations().find((item) => item.id === adapterId);
      if (declaration === undefined) throw new Error(`执行适配器 ${adapterId} 未安装`);
      if (!declaration.available) throw new Error(declaration.reason ?? `${declaration.label} 当前不可用`);
      if (spec.network.mode !== "none") {
        // 做不到就拒绝，不静默放宽：批准的是"受限网络"，我们不能悄悄按"无网络"或"全网络"执行
        throw new Error(`本适配器不支持网络 allowlist（计划要求 ${spec.network.mode}）；拒绝执行而不是放宽网络限制`);
      }
      const probe = probeSeatbelt();
      if (probe.interpreter === undefined) throw new Error(probe.reason ?? "seatbelt 解释器不可用");

      const executionId = `execution-${randomUUID()}`;
      const runDirectory = path.join(options.runRoot, executionId);
      const codeDirectory = path.join(runDirectory, "code");
      const inputsDirectory = path.join(runDirectory, "inputs");
      const scratchDirectory = path.join(runDirectory, "scratch");
      for (const directory of [codeDirectory, inputsDirectory, scratchDirectory]) mkdirSync(directory, { recursive: true });

      try {
        const scriptPath = materialize(spec.code.uri, spec.code.sha256, path.join(codeDirectory, "recipe.py"));
        for (const input of spec.inputs) {
          materialize(input.uri, input.sha256, path.join(inputsDirectory, safeName(input.name)));
        }

        const run = await runInSeatbelt({
          scriptPath,
          inputsDir: inputsDirectory,
          scratchDir: scratchDirectory,
          parametersJson: JSON.stringify(spec.parameters ?? {}),
          timeoutMs: spec.resources.timeoutMs,
          cpuSeconds: Math.max(1, Math.ceil(spec.resources.cpu)),
          interpreter: probe.interpreter as InterpreterResolution,
          signal,
          ...(options.deniedReadPaths === undefined ? {} : { deniedReadPaths: options.deniedReadPaths }),
        });

        const logPath = path.join(runDirectory, "execution.log");
        writeFileSync(logPath, [
          `# execution ${executionId}`,
          `planHash ${spec.planHash}`,
          `recipe ${spec.recipe.id}@${spec.recipe.version}`,
          `policyDigest ${run.policyDigest}`,
          `environmentDigest ${run.environmentDigest}`,
          `exitCode ${run.exitCode}`,
          `startedAt ${run.startedAt}`,
          `finishedAt ${run.finishedAt}`,
          "",
          "## enforced",
          ...run.enforced.map((line) => `- ${line}`),
          "",
          "## stdout",
          run.stdout,
          "",
          "## stderr",
          run.stderr,
          "",
          "## artifacts",
          ...run.artifacts.map((artifact) => `- ${artifact.name} ${artifact.bytes}B sha256=${artifact.sha256}`),
          "",
        ].join("\n"), "utf8");

        if (run.exitCode !== 0) {
          const tail = (run.stderr || run.stdout).trim().split("\n").slice(-6).join("\n");
          throw new Error(`沙箱内脚本以退出码 ${run.exitCode} 结束：${tail || "无输出"}`);
        }
        if (run.artifacts.length === 0) throw new Error("执行成功但没有任何产物：脚本必须把结果写入 scratch 目录");

        const outputs = run.artifacts.map((artifact) => toOutput(scratchDirectory, artifact));
        const result: ScienceExecutionResult = {
          outputs,
          exitCode: run.exitCode,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          environmentDigest: run.environmentDigest,
          logPath,
        };
        return { executionId, result };
      } catch (error) {
        // 失败也要留证：把 run 目录保留下来，但把失败原因如实抛出
        throw error instanceof Error ? error : new Error(String(error));
      }
    },
  };
}

/** 校验哈希后落到运行目录。哈希不符即拒绝执行。 */
function materialize(uri: string, expectedSha256: string, destination: string): string {
  const source = resolveUri(uri);
  if (!existsSync(source)) throw new Error(`计划引用的资源不存在：${uri}`);
  const bytes = readFileSync(source);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expectedSha256) {
    throw new Error(`资源内容与计划哈希不符：${uri}（计划 ${expectedSha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）`);
  }
  writeFileSync(destination, bytes, { mode: 0o600 });
  return destination;
}

function resolveUri(uri: string): string {
  if (uri.startsWith("file://")) return fileURLToPath(uri);
  if (path.isAbsolute(uri)) return uri;
  throw new Error(`不支持的资源 URI：${uri}（本适配器只解析 file:// 与绝对路径）`);
}

const DATASET_EXTENSIONS = new Map([[".json", "application/json"], [".csv", "text/csv"], [".txt", "text/plain"], [".tsv", "text/tab-separated-values"]]);
const REPORT_EXTENSIONS = new Map([[".md", "text/markdown"], [".markdown", "text/markdown"], [".rst", "text/plain"]]);

function toOutput(scratchDirectory: string, artifact: { name: string; bytes: number; sha256: string }): ScienceExecutionOutput {
  const extension = path.extname(artifact.name).toLowerCase();
  const datasetMime = DATASET_EXTENSIONS.get(extension);
  const reportMime = REPORT_EXTENSIONS.get(extension);
  const kind = datasetMime !== undefined ? "dataset" : "report";
  const mimeType = datasetMime ?? reportMime ?? "application/octet-stream";
  const bytes = readFileSync(path.join(scratchDirectory, artifact.name));
  // 产物登记接口只接受字符串：二进制走 base64，避免用"看起来是文本"的方式损坏内容
  const text = mimeType === "application/octet-stream" ? bytes.toString("base64") : bytes.toString("utf8");
  return { name: artifact.name, mimeType, kind, content: text };
}

function safeName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned === "" || cleaned.startsWith(".") ? `input-${createHash("sha256").update(name).digest("hex").slice(0, 12)}` : cleaned;
}

export type { SeatbeltRunOutput };
