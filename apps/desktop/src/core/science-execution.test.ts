// 科研执行端口（seatbelt 沙箱）的验收测试。
//
// 重点不是"能跑"，而是**计划与执行的一致性**：
// 哈希不符必须拒绝、做不到的网络要求必须拒绝、未知适配器必须拒绝、
// 非零退出与无产物都不能被当作成功。

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { probeSeatbelt } from "@xiling/execution";
import { createScienceExecutionPort, SEATBELT_ADAPTER_ID } from "./science-execution.js";
import type { ScienceExecutionPlan, ScienceExecutionSpec } from "@xiling/os-kernel";

const seatbeltReady = probeSeatbelt().available === true;

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface Fixture { root: string; port: ReturnType<typeof createScienceExecutionPort>; spec: ScienceExecutionSpec; scriptPath: string }

/** 造一个真实可执行的科研脚本 + 输入，返回已经绑定哈希的 spec。 */
function fixture(script: string, options: { inputName?: string; inputBody?: string } = {}): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "xiling-science-"));
  const sources = path.join(root, "sources");
  mkdirSync(sources, { recursive: true });
  const scriptPath = path.join(sources, "recipe.py");
  writeFileSync(scriptPath, script, "utf8");
  const inputName = options.inputName ?? "mooring.csv";
  const inputPath = path.join(sources, inputName);
  const inputBody = options.inputBody ?? "depth,speed\n12,0.031\n24,0.044\n36,0.019\n";
  writeFileSync(inputPath, inputBody, "utf8");

  const plan: ScienceExecutionPlan = {
    projectId: "project-niw",
    recipe: { id: "niw-vertical-mode", version: "1.0.0" },
    inputs: [{ name: inputName, uri: pathToFileURL(inputPath).href, sha256: sha256(inputBody) }],
    code: { uri: pathToFileURL(scriptPath).href, sha256: sha256(script) },
    parameters: { window: 3 },
    randomSeed: 20260910,
    environment: { imageDigest: "macos-seatbelt@1" },
    resources: { cpu: 5, memoryBytes: 256 * 1024 * 1024, timeoutMs: 30_000 },
    network: { mode: "none" },
  };
  const port = createScienceExecutionPort({ runRoot: path.join(root, "science-runs") });
  return { root, port, spec: { ...plan, planHash: sha256(JSON.stringify(plan)) }, scriptPath };
}

const GOOD_SCRIPT = `
import json
argv = __import__("sys").argv[1:]
def value_of(flag):
    return argv[argv.index(flag) + 1] if flag in argv else None
INPUTS = value_of("--inputs"); SCRATCH = value_of("--scratch"); PARAMS = json.loads(value_of("--parameters") or "{}")

rows = []
with open(INPUTS + "/mooring.csv") as handle:
    next(handle)
    for line in handle:
        depth, speed = line.strip().split(",")
        rows.append({"depth": float(depth), "speed": float(speed)})
speeds = [row["speed"] for row in rows]
mean = sum(speeds) / len(speeds)
report = {"samples": len(rows), "meanSpeed": round(mean, 5), "window": PARAMS["window"]}
with open(SCRATCH + "/niw-profile.json", "w") as handle:
    json.dump(report, handle, sort_keys=True)
with open(SCRATCH + "/summary.md", "w") as handle:
    handle.write("# 近惯性波垂向模态分析\\n\\n")
    handle.write("- 样本数：%d\\n" % report["samples"])
    handle.write("- 平均流速：%.5f m/s\\n" % report["meanSpeed"])
print("MEAN", mean)
`;

test("适配器声明真实的隔离能力，并逐项列出强制与未覆盖的限制", () => {
  const { root, port } = fixture(GOOD_SCRIPT);
  try {
    const declarations = port.declarations();
    assert.equal(declarations.length, 1);
    const declaration = declarations[0]!;
    if (seatbeltReady) {
      assert.equal(declaration.available, true);
      assert.equal(declaration.id, SEATBELT_ADAPTER_ID);
      assert.equal(declaration.isolation.network, "none");
      // 声明必须具体到可以逐项核对，不能只给一个布尔值
      assert.ok(declaration.isolation.enforced.length >= 4, "必须列出被强制执行的限制");
      assert.ok(declaration.isolation.notEnforced.some((item) => item.includes("内存")), "必须说明内存上限未覆盖");
      assert.ok(declaration.isolation.notEnforced.some((item) => item.includes("allowlist")), "必须说明网络 allowlist 不支持");
    } else {
      assert.equal(declaration.available, false);
      assert.ok(declaration.reason);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("通过端口跑一次真实科研计算，产出可登记的数据与报告", { skip: !seatbeltReady ? "seatbelt 不可用" : false }, async () => {
  const { root, port, spec } = fixture(GOOD_SCRIPT);
  try {
    const controller = new AbortController();
    const { executionId, result } = await port.run(spec, SEATBELT_ADAPTER_ID, controller.signal);
    assert.match(executionId, /^execution-/);
    assert.equal(result.exitCode, 0);
    assert.equal(result.environmentDigest.length, 64);
    assert.ok(result.logPath !== undefined && existsSync(result.logPath), "执行日志必须留档");

    const byName = new Map(result.outputs.map((output) => [output.name, output]));
    const dataset = byName.get("niw-profile.json")!;
    const report = byName.get("summary.md")!;
    assert.equal(dataset.kind, "dataset");
    assert.equal(dataset.mimeType, "application/json");
    assert.equal(report.kind, "report");
    assert.equal(report.mimeType, "text/markdown");
    const parsed = JSON.parse(dataset.content) as { samples: number; meanSpeed: number; window: number };
    assert.equal(parsed.samples, 3);
    assert.equal(parsed.window, 3);
    assert.ok(parsed.meanSpeed > 0);
    assert.match(report.content, /近惯性波垂向模态分析/);
    // 日志里必须留下真实的环境摘要与产物哈希，便于事后核对
    const log = readFileSync(result.logPath!, "utf8");
    assert.match(log, new RegExp(result.environmentDigest));
    assert.match(log, /niw-profile\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("计划哈希不符的资源被拒绝执行", { skip: !seatbeltReady ? "seatbelt 不可用" : false }, async () => {
  const { root, port, spec, scriptPath } = fixture(GOOD_SCRIPT);
  try {
    // 审批之后悄悄改脚本：内容哈希对不上，必须拒绝而不是照跑
    writeFileSync(scriptPath, `${GOOD_SCRIPT}\nprint("TAMPERED")\n`, "utf8");
    await assert.rejects(
      port.run(spec, SEATBELT_ADAPTER_ID, new AbortController().signal),
      /与计划哈希不符/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("计划要求网络 allowlist 时拒绝执行，而不是放宽网络限制", { skip: !seatbeltReady ? "seatbelt 不可用" : false }, async () => {
  const { root, port, spec } = fixture(GOOD_SCRIPT);
  try {
    await assert.rejects(
      port.run({ ...spec, network: { mode: "allowlist", hosts: ["cds.climate.copernicus.eu"] } }, SEATBELT_ADAPTER_ID, new AbortController().signal),
      /不支持网络 allowlist/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("未知或未安装的适配器被拒绝", { skip: !seatbeltReady ? "seatbelt 不可用" : false }, async () => {
  const { root, port, spec } = fixture(GOOD_SCRIPT);
  try {
    await assert.rejects(
      port.run(spec, "host-bare-run", new AbortController().signal),
      /未安装/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("脚本非零退出不算成功", { skip: !seatbeltReady ? "seatbelt 不可用" : false }, async () => {
  const { root, port, spec } = fixture(`
import sys
print("开始计算", file=sys.stderr)
sys.exit(3)
`);
  try {
    await assert.rejects(
      port.run(spec, SEATBELT_ADAPTER_ID, new AbortController().signal),
      /退出码 3/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("执行成功但没有任何产物也判失败", { skip: !seatbeltReady ? "seatbelt 不可用" : false }, async () => {
  const { root, port, spec } = fixture(`print("算完了但什么都没写")\n`);
  try {
    await assert.rejects(
      port.run(spec, SEATBELT_ADAPTER_ID, new AbortController().signal),
      /没有任何产物/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
