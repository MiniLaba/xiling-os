import { describe, expect, it } from "vitest";
import { backgroundDecision } from "./background-policy.js";

const settings = { enabled: true, startHour: 9, endHour: 18, taskBudgetUsd: 2, reminder: "none" as const };

describe("background run policy", () => {
  it("does not call a model when the queue is empty", () => {
    expect(backgroundDecision(settings, 0, new Date("2026-09-27T10:00:00"))).toBe("idle");
  });

  it("advances unfinished work inside the window and stops outside it", () => {
    expect(backgroundDecision(settings, 1, new Date("2026-09-27T10:00:00"))).toBe("advance");
    expect(backgroundDecision(settings, 1, new Date("2026-09-27T20:00:00"))).toBe("outside-window");
  });

  it("treats a full-day window as permission to continue unfinished work, not idle spinning", () => {
    const always = { ...settings, startHour: 0, endHour: 24 };
    expect(backgroundDecision(always, 1, new Date("2026-09-27T03:00:00"))).toBe("advance");
    expect(backgroundDecision(always, 0, new Date("2026-09-27T03:00:00"))).toBe("idle");
  });

  it("stops when the task budget is spent", () => {
    expect(backgroundDecision({ ...settings, spentUsd: 2 }, 1, new Date("2026-09-27T10:00:00"))).toBe("over-budget");
  });
});
