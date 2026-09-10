// 服务集合：内核各服务的共享句柄（互相引用用）。

import type { AgentRegistry } from "./agent-registry.js";
import type { SessionService } from "./session-service.js";
import type { CapabilityService } from "./capability-service.js";
import type { MemoryService } from "./memory-service.js";
import type { ArtifactService } from "./artifact-service.js";
import type { TaskService } from "./task-service.js";
import type { Scheduler } from "./scheduler.js";
import type { A2ARouter } from "./a2a-router.js";
import type { ApprovalService } from "./approval-service.js";
import type { UISurfaceService } from "./ui-surface-service.js";
import type { WorkspaceService } from "./workspace-service.js";
import type { RuntimeManager } from "./runtime-manager.js";
import type { PluginService } from "./plugin-service.js";
import type { CapabilityResolver } from "./capability-resolver.js";
import type { AgentOrchestrator } from "./agent-orchestrator.js";
import type { EventStore } from "./event-store.js";
import type { OSProjection } from "./projection.js";
import type { AgentRuntime } from "@xiling/os-runtime";
import type { ModelRouter } from "./model-router.js";
import type { ModelCatalogService } from "./model-catalog-service.js";
import type { ScienceService } from "./science-service.js";

export interface KernelServices {
  readonly events: EventStore;
  readonly projection: OSProjection;
  readonly agents: AgentRegistry;
  readonly sessions: SessionService;
  readonly capabilities: CapabilityService;
  readonly memories: MemoryService;
  readonly artifacts: ArtifactService;
  readonly tasks: TaskService;
  readonly scheduler: Scheduler;
  readonly a2a: A2ARouter;
  readonly approvals: ApprovalService;
  readonly ui: UISurfaceService;
  readonly workspaces: WorkspaceService;
  readonly runtimes: RuntimeRegistry;
  readonly runner: RuntimeManager;
  readonly plugins: PluginService;
  readonly resolver: CapabilityResolver;
  readonly orchestrator: AgentOrchestrator;
  readonly models: ModelRouter;
  readonly modelCatalog: ModelCatalogService;
  readonly science: ScienceService;
}

/** runtimeName → AgentRuntime。DeepSeek Harness 将来作为一个条目注册进来。 */
export class RuntimeRegistry {
  private readonly runtimes = new Map<string, AgentRuntime>();

  register(runtime: AgentRuntime): void {
    this.runtimes.set(runtime.name, runtime);
  }

  get(name: string): AgentRuntime | undefined {
    return this.runtimes.get(name);
  }

  names(): string[] {
    return [...this.runtimes.keys()];
  }
}
