import { describe, expect, it } from "vitest";
import { localDate, proposeRoutine, routineWhen, visibleReply } from "./routine-proposal.js";

describe("routine proposals", () => {
  it("treats a repeating request as a schedule and asks with the task itself", () => {
    const proposal = proposeRoutine("每个工作日早上9点打开山东大学官网", "好的，我先打开。");
    expect(proposal).toMatchObject({ schedule: "weekdays", hour: 9, minute: 0, instruction: "打开山东大学官网" });
    expect(routineWhen(proposal!)).toBe("工作日 9:00");
  });

  it("uses the model block when the reply includes one", () => {
    const answer = "这是定时任务。\n```xiling-routine\n{\"schedule\":\"hourly\",\"hour\":0,\"minute\":15,\"instruction\":\"检查收件箱\"}\n```";
    expect(proposeRoutine("帮我盯着邮箱", answer)).toMatchObject({ schedule: "hourly", minute: 15, instruction: "检查收件箱" });
    expect(visibleReply(answer)).toBe("这是定时任务。");
  });

  it("keeps a dated download on the clock instead of running it immediately", () => {
    const proposal = proposeRoutine("今天16：42帮我把attention is all you need这篇论文下载到桌面", "已把论文下载到当前电脑桌面。");
    expect(proposal).toMatchObject({ schedule: "once", hour: 16, minute: 42, instruction: "把attention is all you need这篇论文下载到桌面", runOn: localDate(new Date()) });
    expect(routineWhen(proposal!)).toBe("今天 16:42");
  });

  it("leaves a one-off request off the schedule list", () => {
    expect(proposeRoutine("把这篇论文下载到桌面", "已下载。")).toBeNull();
  });

  it("reads Chinese clock words from the request itself", () => {
    const proposal = proposeRoutine("每天早上八点打开山东大学官网", "可以设一个每天 8:00 的闹钟。");
    expect(proposal).toMatchObject({ schedule: "daily", hour: 8, minute: 0, instruction: "打开山东大学官网" });
    expect(routineWhen(proposal!)).toBe("每天 8:00");
  });

  it("keeps the spoken time when the model block copies a different hour", () => {
    const answer = "```xiling-routine\n{\"schedule\":\"daily\",\"hour\":9,\"minute\":0,\"instruction\":\"早上八点打开山东大学官网\"}\n```";
    expect(proposeRoutine("每天早上八点打开山东大学官网", answer)).toMatchObject({ hour: 8, minute: 0, instruction: "打开山东大学官网" });
  });

  it("keeps today at 16:20 as one run and drops the leftover clock word", () => {
    const proposal = proposeRoutine("省今天16：20分打开山东大学官网主页", "```xiling-routine\n{\"schedule\":\"daily\",\"hour\":9,\"minute\":0,\"instruction\":\"今天分打开山东大学官网主页\"}\n```");
    expect(proposal).toMatchObject({ schedule: "once", hour: 16, minute: 20, instruction: "打开山东大学官网主页", runOn: localDate(new Date()) });
    expect(routineWhen(proposal!)).toBe("今天 16:20");
  });

  it("reads a clock without 每天 as a daily open", () => {
    const proposal = proposeRoutine("早上11点6分打开山东大学官网", "One or more configured tools are unavailable in this process");
    expect(proposal).toMatchObject({ schedule: "daily", hour: 11, minute: 6, instruction: "打开山东大学官网" });
    expect(routineWhen(proposal!)).toBe("每天 11:06");
  });

  it("reads afternoon halves and does not invent a clock", () => {
    expect(proposeRoutine("每天下午三点半检查邮箱", "好。")).toMatchObject({ hour: 15, minute: 30, instruction: "检查邮箱" });
    expect(proposeRoutine("每天打开官网", "好。")).toBeNull();
  });
});
