import { describe, expect, it } from "vitest";
import { deferredAssignment, deferredAssignmentReply } from "./deferred-assignment.js";

describe("deferred assignment", () => {
  it("keeps a dated clock for later instead of treating it as immediate", () => {
    const deferred = deferredAssignment("今天16：42帮我把attention is all you need这篇论文下载到桌面", new Date(2026, 8, 28, 16, 30));
    expect(deferred).toMatchObject({ schedule: "once", hour: 16, minute: 42, instruction: "把attention is all you need这篇论文下载到桌面", runOn: "2026-9-28", when: "今天 16:42" });
    expect(deferredAssignmentReply("今天16：42帮我把attention is all you need这篇论文下载到桌面", new Date(2026, 8, 28, 16, 30))).toBe("到今天 16:42 再执行：把attention is all you need这篇论文下载到桌面。点「加入」后才会到点开始。");
  });

  it("leaves an untimed download immediate", () => {
    expect(deferredAssignment("把attention is all you need这篇论文下载到桌面")).toBeNull();
  });
});
