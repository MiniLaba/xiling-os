import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { PiMcpGatewayManager } from "./mcp-host.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("PiMcpGatewayManager", () => {
  it("loads pi-mcp-adapter in an isolated host and keeps one lazy gateway schema", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "xiling-mcp-host-")); roots.push(root);
    const manager = new PiMcpGatewayManager(root);
    const fixture = resolve(import.meta.dirname, "../test-fixtures/mcp-echo-server.mjs");
    await manager.configure({ servers: [{ name: "echo-lab", description: "实验室无副作用回声工具", keywords: ["回声", "echo"], definition: { command: process.execPath, args: [fixture], lifecycle: "lazy", approveTools: false } }] });
    expect(manager.tool().name).toBe("mcp");
    expect(manager.matches("请调用 echo 工具")).toBe(true);
    expect(manager.matches("普通科研问题")).toBe(false);
    const connected = await manager.tool().execute("connect", { connect: "echo-lab" });
    expect(connected.content[0]).toMatchObject({ type: "text" });
    const found = await manager.tool().execute("search", { search: "echo", server: "echo-lab" });
    expect(found.content.find((item) => item.type === "text")?.text).toContain("echo");
    const called = await manager.tool().execute("call", { tool: "echo_lab_echo", server: "echo-lab", args: { text: "ocean" } });
    expect(called.content.find((item) => item.type === "text")?.text).toContain("echo:ocean");
    const controller = new AbortController();
    const cancelled = manager.tool().execute("cancel", { tool: "echo_lab_echo", server: "echo-lab", args: { text: "slow", delayMs: 5_000 } }, controller.signal);
    setTimeout(() => controller.abort(new Error("test cancellation")), 25);
    await expect(cancelled).rejects.toThrow("test cancellation");
    await manager.close();
  }, 30_000);

  it("fails configure with a visible error and leaves no orphan process when worker init dies", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "xiling-mcp-host-fatal-")); roots.push(root);
    // The first configure() uses runtime-1; making its agent dir a file forces
    // the worker's initialize() to fail with EEXIST before "ready" is answered.
    await mkdir(resolve(root, "runtime-1"), { recursive: true });
    await writeFile(resolve(root, "runtime-1", "agent"), "not a directory");
    const manager = new PiMcpGatewayManager(root);
    await expect(manager.configure({ servers: [{ name: "broken-lab", description: "初始化即失败的连接器", keywords: [], definition: { command: process.execPath, args: ["-e", ""], lifecycle: "lazy", approveTools: false } }] })).rejects.toThrow(/MCP host/i);
    await manager.close();
  }, 30_000);
});
