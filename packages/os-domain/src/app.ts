import type { AgentDefinition, ModelPolicy } from "./agent.js";
import type { AgentId } from "./ids.js";

/** Initial package format is declarative only; no executable code or implicit grants. */
export interface AppPackage {
  id: string;
  version: string;
  name: string;
  description: string;
  runtimeName: string;
  instructions: string;
  capabilities: string[];
  requestedActions: string[];
  defaultModel: ModelPolicy;
  ui: { kind: "agent-chat" };
}
export interface AppInstance {
  id: string;
  agentId: AgentId;
  package: AppPackage;
  state: "enabled" | "disabled" | "removed";
  history?: AppPackage[];
  approvedActions: string[];
  installedAt: string;
  updatedAt: string;
}
export interface AppInstallFact { instance: AppInstance; agent: AgentDefinition }
