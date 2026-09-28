import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BotRoutineStore, dispatchDueRoutines, routineDue } from "./bot-routines.js";

describe("Bot routines", () => {
  it("runs a weekday routine once in its slot and skips a busy conversation", () => {
    const store = new BotRoutineStore(join(mkdtempSync(join(tmpdir(), "xiling-routines-")), "routines.json"));
    const routine = store.create({ projectId: "p1", instruction: "打开学院官网并记录标题", schedule: "weekdays", hour: 9, minute: 0, enabled: true });
    const monday = new Date(2026, 8, 28, 9, 0, 10);
    expect(routineDue(routine, monday)).toBe(true);
    expect(routineDue(routine, new Date(2026, 8, 27, 9, 0, 10))).toBe(false);
    const started: string[] = [];
    expect(dispatchDueRoutines({
      now: monday,
      routines: store,
      sessionId: () => "session-1",
      busy: () => false,
      start: (_sessionId, _projectId, routineId) => { started.push(routineId); },
    })).toBe(1);
    expect(started).toEqual([routine.id]);
    expect(dispatchDueRoutines({
      now: monday,
      routines: store,
      sessionId: () => "session-1",
      busy: () => false,
      start: () => { throw new Error("should not start twice"); },
    })).toBe(0);
  });

  it("runs a same-day task after its clock and does not repeat it", () => {
    const store = new BotRoutineStore(join(mkdtempSync(join(tmpdir(), "xiling-routines-")), "routines.json"));
    const routine = store.create({ projectId: "p1", instruction: "打开山东大学官网主页", schedule: "once", hour: 16, minute: 20, runOn: "2026-9-28", enabled: true });
    expect(routineDue(routine, new Date(2026, 8, 28, 16, 19, 0))).toBe(false);
    const started: string[] = [];
    expect(dispatchDueRoutines({
      now: new Date(2026, 8, 28, 16, 22, 0),
      routines: store,
      sessionId: () => "session-1",
      busy: () => false,
      start: (_sessionId, _projectId, _routineId, instruction) => { started.push(instruction); },
    })).toBe(1);
    expect(started).toEqual(["打开山东大学官网主页"]);
    expect(dispatchDueRoutines({
      now: new Date(2026, 8, 28, 16, 30, 0),
      routines: store,
      sessionId: () => "session-1",
      busy: () => false,
      start: () => { throw new Error("should not start twice"); },
    })).toBe(0);
  });
});
