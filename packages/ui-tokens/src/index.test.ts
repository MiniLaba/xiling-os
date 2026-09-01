import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildTokensCss, lingjing, poxiao } from "./index.js";

describe("汐语灵境设计令牌", () => {
  it("tokens.css stays byte-identical with the TS source of truth", () => {
    const onDisk = readFileSync(new URL("../../../apps/web/src/styles/tokens.css", import.meta.url), "utf8");
    expect(onDisk).toBe(buildTokensCss());
  });

  it("covers every relation and entity kind in both themes", () => {
    for (const theme of [lingjing, poxiao]) {
      expect(Object.keys(theme.relations)).toHaveLength(16);
      expect(Object.keys(theme.entities)).toHaveLength(19);
      for (const color of [...Object.values(theme.relations), ...Object.values(theme.entities)]) expect(color).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("keeps body text at or above the 11px readability floor", () => {
    const css = buildTokensCss();
    expect(css).toContain('--xl-type-caption: 11px;');
    expect(css).toContain("prefers-reduced-motion");
    expect(css).toContain('data-theme="lingjing"');
    expect(css).toContain('data-theme="poxiao"');
  });
});
