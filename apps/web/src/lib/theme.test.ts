import { describe, expect, it } from "vitest";
import { DEFAULT_THEME_PREFERENCE, parseStoredTheme } from "./theme.js";

describe("theme preference", () => {
  it("defaults a new installation to Lingjing", () => {
    expect(DEFAULT_THEME_PREFERENCE).toBe("lingjing");
    expect(parseStoredTheme(null)).toBe("lingjing");
    expect(parseStoredTheme("unexpected-value")).toBe("lingjing");
  });

  it("preserves explicit user choices", () => {
    expect(parseStoredTheme("lingjing")).toBe("lingjing");
    expect(parseStoredTheme("poxiao")).toBe("poxiao");
    expect(parseStoredTheme("system")).toBe("system");
  });
});
