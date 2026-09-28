import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerLocalAccessControl } from "./local-access.js";
import { BOT_DESKTOP_NAME, VmDesktopSession, botDesktopContainerPort, botDesktopImage, explainVmDesktopFailure, loopbackEmbedUrl, registerVmDesktopRoutes } from "./vm-desktop.js";

const token = "a".repeat(64);

describe("Bot VM desktop", () => {
  it("reads only a loopback published port", () => {
    expect(loopbackEmbedUrl("127.0.0.1:45123\n", "testpass")).toBe("http://127.0.0.1:45123/vnc.html?autoconnect=1&resize=scale&password=testpass");
    expect(() => loopbackEmbedUrl("0.0.0.0:45123\n")).toThrow("回环地址");
  });

  it("explains a missing Docker engine without leaking the raw spawn error", () => {
    expect(explainVmDesktopFailure(Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" }))).toContain("没有可用的 Docker");
    expect(explainVmDesktopFailure(new Error("failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine"))).toContain("请先启动 Docker");
    expect(explainVmDesktopFailure(new Error("dialing registry-1.docker.io:443 container via direct connection because Docker Desktop has no HTTPS proxy"))).toContain("Proxies");
  });

  it("publishes the desktop on loopback and embeds that URL", async () => {
    const calls: string[][] = [];
    const session = new VmDesktopSession({
      probeAttempts: 1,
      probeIntervalMs: 0,
      probe: async () => true,
      vncPassword: "testpass",
      run: async (_file, args) => {
        calls.push(args);
        if (args[0] === "inspect") throw Object.assign(new Error("missing"), { stderr: "Error: No such object: xiling-bot-desktop" });
        if (args[0] === "rm") throw Object.assign(new Error("missing"), { stderr: "Error: No such object: xiling-bot-desktop" });
        if (args[0] === "port") return { stdout: "127.0.0.1:45123\n", stderr: "" };
        return { stdout: "container\n", stderr: "" };
      },
    });
    expect(session.start().status).toBe("starting");
    await session.settled();
    expect(session.snapshot()).toMatchObject({ status: "ready", embedUrl: "http://127.0.0.1:45123/vnc.html?autoconnect=1&resize=scale&password=testpass" });
    const run = calls.find((args) => args[0] === "run");
    expect(run).toEqual(expect.arrayContaining(["-p", `127.0.0.1::${botDesktopContainerPort()}`, "--name", BOT_DESKTOP_NAME, "-e", "XILING_DESKTOP=xfce", botDesktopImage()]));
    expect(run?.at(-1)).toBe(botDesktopImage());
    expect(run).not.toContain("/usr/bin/supervisord");
    expect(run).not.toContain("0.0.0.0");
    expect(session.start().status).toBe("ready");
    expect(calls.filter((args) => args[0] === "run")).toHaveLength(1);
  });

  it("tells the user the first open is downloading the desktop image", async () => {
    let duringRun = "";
    const session = new VmDesktopSession({
      probeAttempts: 1,
      probeIntervalMs: 0,
      probe: async () => true,
      vncPassword: "testpass",
      run: async (_file, args) => {
        if (args[0] === "image") throw Object.assign(new Error("missing image"), { stderr: "Error: No such image: webtop" });
        if (args[0] === "run") duringRun = session.snapshot().message;
        if (args[0] === "inspect") throw Object.assign(new Error("missing"), { stderr: "Error: No such object: xiling-bot-desktop" });
        if (args[0] === "rm") throw Object.assign(new Error("missing"), { stderr: "Error: No such object: xiling-bot-desktop" });
        if (args[0] === "port") return { stdout: "127.0.0.1:45123\n", stderr: "" };
        return { stdout: "container\n", stderr: "" };
      },
    });
    session.start();
    await session.settled();
    expect(duringRun).toContain("下载");
    expect(session.snapshot()).toMatchObject({ status: "ready", embedUrl: "http://127.0.0.1:45123/vnc.html?autoconnect=1&resize=scale&password=testpass" });
  });

  it("stays unavailable when the published port is not loopback", async () => {
    const session = new VmDesktopSession({
      probeAttempts: 1,
      probe: async () => true,
      run: async (_file, args) => {
        if (args[0] === "inspect") return { stdout: "true\n", stderr: "" };
        if (args[0] === "port") return { stdout: "0.0.0.0:45123\n", stderr: "" };
        return { stdout: "", stderr: "" };
      },
    });
    session.start();
    await session.settled();
    expect(session.snapshot().status).toBe("unavailable");
    expect(session.snapshot().embedUrl).toBeUndefined();
  });

  it("starts Docker when the engine is not running", async () => {
    let boots = 0;
    let infos = 0;
    const session = new VmDesktopSession({
      engineRetryMs: 0,
      probeAttempts: 1,
      probeIntervalMs: 0,
      probe: async () => true,
      vncPassword: "testpass",
      bootEngine: async () => { boots += 1; },
      run: async (_file, args) => {
        if (args[0] === "info") {
          infos += 1;
          if (infos === 1) throw new Error("failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine");
          return { stdout: "29\n", stderr: "" };
        }
        if (args[0] === "inspect") return { stdout: "true\n", stderr: "" };
        if (args[0] === "port") return { stdout: "127.0.0.1:45123\n", stderr: "" };
        return { stdout: "", stderr: "" };
      },
    });
    session.start();
    await session.settled();
    expect(boots).toBe(1);
    expect(session.snapshot()).toMatchObject({ status: "ready", embedUrl: "http://127.0.0.1:45123/vnc.html?autoconnect=1&resize=scale&password=testpass" });
  });

  it("refuses to start unless the saved execution target is the VM", async () => {
    const app = Fastify();
    registerLocalAccessControl(app, token);
    let started = false;
    const session = new VmDesktopSession({ run: async () => { started = true; return { stdout: "", stderr: "" }; } });
    registerVmDesktopRoutes(app, session, () => "local");
    const denied = await app.inject({ method: "POST", url: "/api/v1/bot/desktop", headers: { host: "127.0.0.1", "x-xiling-token": token } });
    expect(denied.statusCode).toBe(409);
    expect(started).toBe(false);
    const idle = await app.inject({ method: "GET", url: "/api/v1/bot/desktop", headers: { host: "127.0.0.1" } });
    expect(idle.json()).toMatchObject({ status: "stopped" });
    await app.close();
  });
});
