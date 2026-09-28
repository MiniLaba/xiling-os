export const OPENMANUS_REPOSITORY = "https://github.com/FoundationAgents/OpenManus";
export const OPENMANUS_LICENSE = "MIT";

export type OpenManusExecutionTarget = "local" | "ssh" | "vm";

export interface ApprovedExecutionStep {
  target: OpenManusExecutionTarget;
  approved: boolean;
  changesFormalConclusion: boolean;
  largeDataDownload: boolean;
}

/**
 * Pi remains the only planner. OpenManus is limited to an approved execution
 * step against the user-selected target. Formal conclusions and large data
 * downloads stay on the existing plan/approval path.
 */
export function assertOpenManusStep(step: ApprovedExecutionStep): void {
  if (!step.approved) throw new Error("execution_requires_approval");
  if (step.changesFormalConclusion) throw new Error("formal_conclusion_requires_decision");
  if (step.largeDataDownload) throw new Error("large_data_download_requires_plan");
  if (step.target !== "local" && step.target !== "ssh" && step.target !== "vm") throw new Error("unknown_execution_target");
}
