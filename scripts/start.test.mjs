import { describe, expect, it } from "vitest";
import { appUrl, browserCommand, defaultDataRoot } from "./start.mjs";

describe("cross-platform launcher", () => {
  it("opens a loopback URL when the service listens on all interfaces", () => {
    expect(appUrl("0.0.0.0", 4317)).toBe("http://127.0.0.1:4317/");
  });

  it("uses native browser launchers without a shell wrapper", () => {
    expect(browserCommand("darwin", "http://127.0.0.1:4317/")).toEqual({ command: "open", args: ["http://127.0.0.1:4317/"] });
    expect(browserCommand("win32", "http://127.0.0.1:4317/")).toMatchObject({ command: "cmd.exe" });
    expect(browserCommand("linux", "http://127.0.0.1:4317/")).toMatchObject({ command: "xdg-open" });
  });

  it("keeps native Windows application data outside the repository", () => {
    expect(defaultDataRoot("win32", { LOCALAPPDATA: "C:\\Users\\研究者\\AppData\\Local" })).toBe("C:\\Users\\研究者\\AppData\\Local\\XiLingOS");
  });
});
