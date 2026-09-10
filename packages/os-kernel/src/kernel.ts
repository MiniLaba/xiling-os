// OSKernel（指南 §33/§53/§54）：
// Control Plane 的 Modular Monolith 门面 —— 八组核心 API + 事件发射器。
// 所有长期状态变更都经由 kernel.emit 落入 EventStore，再由投影引擎消费。

import type { EventCorrelation, OSEvent, OSEventPayloads, OSEventType, OSOperationContext } from "@xiling/os-domain";
import { EventStore } from "./event-store.js";
import { applyEvent, emptyProjection } from "./projection.js";
import type { OSProjection } from "./projection.js";
import { AgentRegistry } from "./agent-registry.js";
import { AppService } from "./app-service.js";
import { SessionService } from "./session-service.js";
import { CapabilityService } from "./capability-service.js";
import { MemoryService } from "./memory-service.js";
import { ArtifactService } from "./artifact-service.js";
import { TaskService } from "./task-service.js";
import { Scheduler } from "./scheduler.js";
import { A2ARouter } from "./a2a-router.js";
import { ApprovalService } from "./approval-service.js";
import { UISurfaceService } from "./ui-surface-service.js";
import { WorkspaceService } from "./workspace-service.js";
import { RuntimeManager } from "./runtime-manager.js";
import { PluginService } from "./plugin-service.js";
import { RuntimeRegistry } from "./kernel-services.js";
import { CapabilityResolver } from "./capability-resolver.js";
import { AgentOrchestrator } from "./agent-orchestrator.js";
import type { KernelServices } from "./kernel-services.js";
import { ModelRouter } from "./model-router.js";
import { ModelCatalogService } from "./model-catalog-service.js";
import { InMemoryArtifactContentStore, type ArtifactContentStore } from "./artifact-content-store.js";
import { ScienceService, unavailableScienceExecutionPort, type ScienceExecutionPort } from "./science-service.js";

export class OSKernel {
  readonly apps: AppService;
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
  readonly services: KernelServices;
  readonly artifactContentStore: ArtifactContentStore;
  readonly science: ScienceService;

  constructor(options: { eventHooks?: ConstructorParameters<typeof EventStore>[0]; artifactContentStore?: ArtifactContentStore; scienceExecution?: ScienceExecutionPort } = {}) {
    this.events = new EventStore(options.eventHooks);
    this.artifactContentStore = options.artifactContentStore ?? new InMemoryArtifactContentStore();
    this.projection = emptyProjection();
    this.apps = new AppService(this);
    this.runtimes = new RuntimeRegistry();
    this.models = new ModelRouter();

    // 投影只从事件流来（Recovery 与测试共用 replay 路径）
    this.events.subscribe((event) => {
      void applyEvent(this.projection, event);
      if ((event.type === "artifact.created" || event.type === "artifact.version_added") && typeof event.payload.content === "string") {
        this.artifactContentStore.put(event.payload.artifact.storageRef, event.payload.content);
      }
      if (event.type === "model.registered") this.models.register(event.payload.declaration);
      if (event.type === "model.removed") this.models.unregister(event.payload.address);
    });

    // 服务在构造完成后互相可见（this.servicesRef 的 getter 闭包绑定本实例）
    const kernel = this;
    const services: KernelServices = {
      get events() { return kernel.events; },
      get projection() { return kernel.projection; },
      get agents() { return kernel.agents; },
      get sessions() { return kernel.sessions; },
      get capabilities() { return kernel.capabilities; },
      get memories() { return kernel.memories; },
      get artifacts() { return kernel.artifacts; },
      get tasks() { return kernel.tasks; },
      get scheduler() { return kernel.scheduler; },
      get a2a() { return kernel.a2a; },
      get approvals() { return kernel.approvals; },
      get ui() { return kernel.ui; },
      get workspaces() { return kernel.workspaces; },
      get runtimes() { return kernel.runtimes; },
      get runner() { return kernel.runner; },
      get plugins() { return kernel.plugins; },
      get resolver() { return kernel.resolver; },
      get orchestrator() { return kernel.orchestrator; },
      get models() { return kernel.models; },
      get modelCatalog() { return kernel.modelCatalog; },
      get science() { return kernel.science; },
    };

    this.agents = new AgentRegistry(this, services);
    this.sessions = new SessionService(this, services);
    this.capabilities = new CapabilityService(this, services);
    this.memories = new MemoryService(this, services);
    this.artifacts = new ArtifactService(this, services);
    this.tasks = new TaskService(this, services);
    this.scheduler = new Scheduler(this, services);
    this.a2a = new A2ARouter(this, services);
    this.approvals = new ApprovalService(this, services);
    this.ui = new UISurfaceService(this, services);
    this.workspaces = new WorkspaceService(this, services);
    this.runner = new RuntimeManager(this, services);
    this.plugins = new PluginService(this, services);
    this.resolver = new CapabilityResolver(services);
    this.orchestrator = new AgentOrchestrator(services);
    this.modelCatalog = new ModelCatalogService(this, services);
    this.science = new ScienceService(this, services, { execution: options.scienceExecution ?? unavailableScienceExecutionPort() });
    this.services = services;
  }

  emit<T extends OSEventType>(
    type: T,
    payload: OSEventPayloads[T],
    correlation?: EventCorrelation | undefined,
    ctx?: OSOperationContext | undefined,
  ): OSEvent {
    const mergedCorrelation: EventCorrelation = {
      ...(correlation ?? {}),
      ...(ctx !== undefined ? { userId: ctx.userId, tenantId: ctx.tenantId, sessionId: ctx.sessionId, runId: ctx.runId, stepId: ctx.stepId, toolCallId: ctx.toolCallId, artifactId: ctx.artifactId, traceId: ctx.traceId } : {}),
    };
    if (ctx?.actorAgentId !== undefined && mergedCorrelation.agentId === undefined) {
      mergedCorrelation.agentId = ctx.actorAgentId;
    }
    return this.events.append({ type, payload, correlation: mergedCorrelation });
  }

  /** 事件重放重建投影（恢复路径：Event Store → Projection） */
  static replayProjection(events: readonly OSEvent[]): OSProjection {
    let state = emptyProjection();
    for (const event of events) state = applyEvent(state, event);
    return state;
  }
}
