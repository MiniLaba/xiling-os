import type { BackgroundRunSettings } from "@xiling/contracts";

export type BackgroundDecision = "disabled" | "idle" | "outside-window" | "over-budget" | "advance";

export function withinBackgroundWindow(now: Date, settings: Pick<BackgroundRunSettings, "startHour" | "endHour">): boolean {
  const hour = now.getHours();
  if (settings.startHour === settings.endHour % 24 && settings.endHour !== 24) return true;
  if (settings.startHour < settings.endHour) return hour >= settings.startHour && hour < settings.endHour;
  return hour >= settings.startHour || hour < settings.endHour;
}

/**
 * Background work continues only while a Bot task is unfinished and the
 * clock is inside the configured window. An empty queue never calls a model.
 * A 24-hour window means unfinished work may cross midnight, not that the
 * runtime should spin while idle.
 */
export function backgroundDecision(settings: BackgroundRunSettings & { spentUsd?: number }, pendingTasks: number, now: Date): BackgroundDecision {
  if (!settings.enabled) return "disabled";
  if (pendingTasks <= 0) return "idle";
  if (!withinBackgroundWindow(now, settings)) return "outside-window";
  if ((settings.spentUsd ?? 0) >= settings.taskBudgetUsd) return "over-budget";
  return "advance";
}
