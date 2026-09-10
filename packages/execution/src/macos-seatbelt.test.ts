// seatbelt 执行后端的验收测试。
//
// 两类断言：
// 1) 计算能真的跑起来并产出可校验的产物（否则"sandbox 可用"是空话）。
// 2) 隔离真的生效：网络、越界读、越界写、派生其他二进制都必须被内核拒绝。
//    第 2 类是这个后端存在的理由，缺了它就只能算"宿主裸跑 + 一层包装"。

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { DEFAULT_DENIED_READ_PATHS, frameworkVersionRoot, interpreterExecAllowances, probeSeatbelt, resolveInterpreter, runInSeatbelt, seatbeltProfile } from "./macos-seatbelt.js";

const probe = probeSeatbelt();
const interpreter = resolveInterpreter();
const available = probe.available && interpreter !== undefined;
const withoutSandbox = available ? false : `seatbelt 不可用：${probe.reason ?? "未找到解释器"}`;
void withoutSandbox;
type RunOutput = Awaited<ReturnType<typeof runInSeatbelt>>;

async function withSandbox(
  script: string,
  work: (context: { outputs: RunOutput; scratchDir: string }) => Promise<void> | void,
  options: { timeoutMs?: number; cpuSeconds?: number; signal?: AbortSignal } = {},
): Promise<void> {
  const runRoot = await mkdtemp(path.join(os.tmpdir(), "xiling-seatbelt-"));
  try {
    const codeDir = path.join(runRoot, "code");
    const inputsDir = path.join(runRoot, "inputs");
    const scratchDir = path.join(runRoot, "scratch");
    await mkdir(codeDir, { recursive: true });
    await mkdir(inputsDir, { recursive: true });
    const scriptPath = path.join(codeDir, "recipe.py");
    await writeFile(scriptPath, script, "utf8");
    const outputs = await runInSeatbelt({
      scriptPath,
      inputsDir,
      scratchDir,
      parametersJson: JSON.stringify({ alpha: 0.25 }),
      timeoutMs: options.timeoutMs ?? 20_000,
      cpuSeconds: options.cpuSeconds ?? 10,
      interpreter: interpreter!,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    await work({ outputs, scratchDir });
  } finally {
    await rm(runRoot, { recursive: true, force: true });
  }
}

const ABI_PREAMBLE = `
import json, sys
argv = sys.argv[1:]
def value_of(flag):
    return argv[argv.index(flag) + 1] if flag in argv else None
INPUTS = value_of("--inputs"); SCRATCH = value_of("--scratch"); PARAMS = json.loads(value_of("--parameters") or "{}")
`;

describe("seatbelt 隔离策略", () => {
  it("默认全拒，读取用「允许根 + 显式拒绝敏感区 + 再放行声明输入」三段式", () => {
    const profile = seatbeltProfile({
      readPaths: ["/tmp/xiling-run/code", "/tmp/xiling-run/inputs"],
      writablePaths: ["/tmp/xiling-run/scratch"],
      execAllowances: [
        { kind: "literal", path: "/bin/sh" },
        { kind: "literal", path: "/usr/bin/python3" },
        { kind: "subpath", path: "/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9" },
      ],
      allowFork: false,
      deniedReadPaths: DEFAULT_DENIED_READ_PATHS,
    });
    expect(profile).toMatch(/\(deny default\)/);
    expect(profile).toMatch(/\(deny network\*\)/);
    expect(profile).toMatch(/\(deny process-fork\)/);
    expect(profile).toMatch(/\(allow file-write\* \(subpath "\/tmp\/xiling-run\/scratch"\)/);
    expect(profile).toMatch(/\(allow process-exec \(literal "\/bin\/sh"\) \(literal "\/usr\/bin\/python3"\) \(subpath "\/Library\/Developer\/CommandLineTools\/Library\/Frameworks\/Python3\.framework\/Versions\/3\.9"\)\)/);
    // 设备文件必须是 literal：(subpath "/dev/null") 永远不命中，会静默失去放开项
    expect(profile).toMatch(/\(literal "\/dev\/null"\)/);
    // 三段式的顺序不能变：拒绝必须排在第一次放开之后、声明输入之前
    const allowRoot = profile.indexOf('(allow file-read* (subpath "/")');
    const denySensitive = profile.indexOf('(deny file-read* (subpath "/Users")');
    const allowInputs = profile.indexOf('(allow file-read* (subpath "/tmp/xiling-run/code")');
    expect(allowRoot).toBeGreaterThan(-1);
    expect(denySensitive).toBeGreaterThan(allowRoot);
    expect(allowInputs).toBeGreaterThan(denySensitive);
    // 敏感区默认在拒绝清单里
    expect(DEFAULT_DENIED_READ_PATHS).toContain("/Users");
    expect(DEFAULT_DENIED_READ_PATHS).toContain("/private/etc");
    expect(DEFAULT_DENIED_READ_PATHS).toContain("/Volumes");
  });

  it("解释器的 exec 白名单覆盖转发桩与 framework 内的真实二进制", () => {
    const resolution = {
      launcher: "/usr/bin/python3",
      interpreter: "/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9/bin/python3.9",
      version: "3.9.6",
    };
    const allowances = interpreterExecAllowances(resolution);
    expect(allowances).toContainEqual({ kind: "literal", path: "/bin/sh" });
    expect(allowances).toContainEqual({ kind: "literal", path: "/bin/bash" });
    expect(allowances).toContainEqual({ kind: "literal", path: resolution.launcher });
    // sys.executable 报的路径与桩实际 posix_spawn 的路径不同，必须靠 framework 版本目录覆盖
    expect(allowances).toContainEqual({
      kind: "subpath",
      path: "/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9",
    });
    expect(frameworkVersionRoot("/opt/homebrew/Cellar/python@3.12/3.12.1/Frameworks/Python.framework/Versions/3.12/bin/python3.12"))
      .toBe("/opt/homebrew/Cellar/python@3.12/3.12.1/Frameworks/Python.framework/Versions/3.12");
    expect(frameworkVersionRoot("/usr/bin/python3")).toBeUndefined();
  });

  it("探测结果与平台一致，非 macOS 时给出明确原因而不是回退", () => {
    if (process.platform === "darwin") {
      expect(probe.available).toBe(true);
      expect(probe.binary).toBe("/usr/bin/sandbox-exec");
      expect(interpreter).toBeTypeOf("object");
      // 必须解析出真实解释器：/usr/bin/python3 只是转发桩
      expect(interpreter!.interpreter).toMatch(/python3(\.\d+)?$/);
      expect(interpreter!.interpreter.startsWith("/")).toBe(true);
      expect(interpreter!.version).toMatch(/^\d+\.\d+/);
    } else {
      expect(probe.available).toBe(false);
      expect(probe.reason).toMatch(/不做宿主裸跑回退/);
    }
  });
});

describe.skipIf(!available)("seatbelt 真实执行", () => {
  it("跑真实数值计算并产出内容寻址的产物", async () => {
    await withSandbox(
      `${ABI_PREAMBLE}
import math
values = [math.sin(i * PARAMS["alpha"]) for i in range(2000)]
mean = sum(values) / len(values)
variance = sum((v - mean) ** 2 for v in values) / len(values)
report = {"count": len(values), "mean": round(mean, 6), "variance": round(variance, 6)}
with open(SCRATCH + "/summary.json", "w") as handle:
    json.dump(report, handle, sort_keys=True)
print("MEAN", report["mean"])
`,
      async ({ outputs, scratchDir }) => {
        expect(outputs.exitCode).toBe(0);
        expect(outputs.stdout).toMatch(/MEAN /);
        expect(outputs.artifacts).toHaveLength(1);
        expect(outputs.artifacts[0]!.name).toBe("summary.json");
        expect(outputs.artifacts[0]!.sha256).toHaveLength(64);
        expect(outputs.environmentDigest).toHaveLength(64);
        expect(outputs.policyDigest).toHaveLength(64);
        // 产物哈希必须与落盘内容一致，否则"内容寻址"只是说法
        const bytes = await readFile(path.join(scratchDir, "summary.json"));
        expect(outputs.artifacts[0]!.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
        expect(outputs.artifacts[0]!.bytes).toBe(bytes.byteLength);
        const report = JSON.parse(bytes.toString("utf8")) as { count: number; variance: number };
        expect(report.count).toBe(2000);
        expect(report.variance).toBeGreaterThan(0);
      },
    );
  });

  it("拒绝网络访问", async () => {
    await withSandbox(
      `${ABI_PREAMBLE}
import socket
try:
    sock = socket.create_connection(("1.1.1.1", 80), timeout=3)
    sock.close()
    print("NETWORK_ALLOWED")
except Exception as error:
    print("NETWORK_BLOCKED", type(error).__name__)
`,
      ({ outputs }) => {
        expect(outputs.stdout).toMatch(/NETWORK_BLOCKED/);
        expect(outputs.stdout).not.toMatch(/NETWORK_ALLOWED/);
      },
    );
  });

  it("拒绝读取入参声明之外的宿主文件", async () => {
    await withSandbox(
      `${ABI_PREAMBLE}
try:
    with open("/etc/hosts") as handle:
        print("READ_ESCAPED", handle.read()[:20])
except Exception as error:
    print("READ_BLOCKED", type(error).__name__)
`,
      ({ outputs }) => {
        expect(outputs.stdout).toMatch(/READ_BLOCKED/);
        expect(outputs.stdout).not.toMatch(/READ_ESCAPED/);
      },
    );
  });

  it("拒绝读取宿主家目录（敏感区默认清单生效）", async () => {
    await withSandbox(
      `${ABI_PREAMBLE}
import os
targets = [os.path.expanduser("~/.zshrc"), "/etc/hosts", "/Volumes"]
for target in targets:
    try:
        open(target).read(1)
        print("HOME_ESCAPED", target)
    except Exception as error:
        print("HOME_BLOCKED", target, type(error).__name__)
`,
      ({ outputs }) => {
        expect(outputs.stdout).toMatch(/HOME_BLOCKED .*\.zshrc/);
        expect(outputs.stdout).toMatch(/HOME_BLOCKED \/etc\/hosts/);
        expect(outputs.stdout).not.toMatch(/HOME_ESCAPED/);
      },
    );
  });

  it("声明输入落在被拒敏感区内时仍可读，同级未声明文件读不到", async () => {
    // 生产布局就是这样：science-runs 落在 ~/Library/Application Support（属于被拒的 /Users）
    const base = await mkdtemp(path.join(os.tmpdir(), "xiling-denied-"));
    try {
      const runRoot = path.join(base, "science-runs");
      const codeDir = path.join(runRoot, "code");
      const inputsDir = path.join(runRoot, "inputs");
      const scratchDir = path.join(runRoot, "scratch");
      for (const directory of [codeDir, inputsDir, scratchDir]) await mkdir(directory, { recursive: true });
      await writeFile(path.join(inputsDir, "declared.txt"), "declared-input", "utf8");
      const sibling = path.join(base, "sibling-secret.txt");
      await writeFile(sibling, "should-not-be-readable", "utf8");
      const scriptPath = path.join(codeDir, "recipe.py");
      await writeFile(scriptPath, `${ABI_PREAMBLE}
def attempt(target):
    try:
        return "OK " + open(target).read(16)
    except Exception as error:
        return "BLOCKED " + type(error).__name__
print("DECLARED:", attempt(INPUTS + "/declared.txt"))
print("SIBLING:", attempt(${JSON.stringify(sibling)}))
`, "utf8");
      const outputs = await runInSeatbelt({
        scriptPath, inputsDir, scratchDir, parametersJson: "{}",
        timeoutMs: 20_000, cpuSeconds: 10, interpreter: interpreter!,
        deniedReadPaths: [base],
      });
      expect(outputs.stdout).toMatch(/DECLARED: OK declared-input/);
      expect(outputs.stdout).toMatch(/SIBLING: BLOCKED/);
      expect(outputs.stdout).not.toMatch(/SIBLING: OK/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("拒绝写 scratch 之外的路径", async () => {
    const escapeTarget = `/tmp/xiling-escape-${Date.now()}.txt`;
    await withSandbox(
      `${ABI_PREAMBLE}
try:
    with open("${escapeTarget}", "w") as handle:
        handle.write("escaped")
    print("WRITE_ESCAPED")
except Exception as error:
    print("WRITE_BLOCKED", type(error).__name__)
`,
      ({ outputs }) => {
        expect(outputs.stdout).toMatch(/WRITE_BLOCKED/);
        expect(existsSync(escapeTarget)).toBe(false);
      },
    );
  });

  it("拒绝派生声明之外的二进制", async () => {
    await withSandbox(
      `${ABI_PREAMBLE}
import subprocess
try:
    subprocess.run(["/bin/ls", "/"], check=True, capture_output=True)
    print("EXEC_ALLOWED")
except Exception as error:
    print("EXEC_BLOCKED", type(error).__name__)
`,
      ({ outputs }) => {
        expect(outputs.stdout).toMatch(/EXEC_BLOCKED/);
        expect(outputs.stdout).not.toMatch(/EXEC_ALLOWED/);
      },
    );
  });

  it("超过 wall-clock 上限的计算被终止，不算成功", async () => {
    await expect(
      withSandbox(`${ABI_PREAMBLE}
while True:
    pass
`, () => { /* 不应到达 */ }, { timeoutMs: 2500, cpuSeconds: 30 }),
    ).rejects.toThrow(/超时/);
  });

  it("取消信号能终止沙箱内的计算", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 400);
    await expect(
      withSandbox(`${ABI_PREAMBLE}
while True:
    pass
`, () => { /* 不应到达 */ }, { timeoutMs: 30_000, cpuSeconds: 30, signal: controller.signal }),
    ).rejects.toThrow(/取消/);
  });
});
