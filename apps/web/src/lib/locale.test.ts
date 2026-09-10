import { describe, expect, it } from "vitest";
import { translate } from "./locale.js";

describe("interface language", () => {
  it("translates explicit interface labels", () => {
    expect(translate("科研画布", "en")).toBe("Research canvas");
    expect(translate("科研画布", "zh-CN")).toBe("科研画布");
  });
  it("does not translate project content or unknown labels", () => {
    expect(translate("海草床生态系统", "en")).toBe("海草床生态系统");
  });
});
