import { registerErrorHandlers, validationFailure } from "./http-errors.js";
import { registerLocalAccessControl, loadOrCreateLocalAccessToken } from "./local-access.js";
import { reapOrphanSandboxes } from "./sandbox-reaper.js";
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { z } from "zod";
import { ResearchAgentHarness, SqliteAgentSessionStore, type RuntimeUsageInput } from "@xiling/agent-harness";
import { projectionSchema } from "@xiling/api-contracts";
import { ContextAssemblyCache, assembleContext, createNodeContextCapsule, estimateContextTokens, projectResearchGraphContext, type ContextNodeContent } from "@xiling/context";
import type { AgentStreamEvent, ContextCapsule, ModelProviderId, ModelRouteSettings, ResourceUri } from "@xiling/contracts";
import { FREE_EXPLORATION_PROJECT_ID } from "@xiling/contracts";
import type { ConnectorMetadataSummary, OceanSubsetRequest } from "@xiling/domain-ocean";
import { LazySkillCatalog, PI_COMPATIBILITY_BASELINE, PiMcpGatewayManager, PiRuntimeAdapter, ModelRuntimeStore, TokenLedger, createLiveRoute, createOfflineRoute, findKnownModelCatalogEntry, listRecommendedModels, resolveModelCatalogEntry } from "@xiling/pi-runtime";
import { DockerProjectAnalysisRunner, LocalWorkflowArtifactRegistrar } from "./research-runner.js";
import { ConnectorWorkflowService, FixtureConnectorAdapter, JsonConnectorJobRepository, type ConnectorDownloader, type ConnectorMetadataProbe } from "@xiling/connectors";
import { FileLiteratureCache, LiteratureSearchService, OpenAlexProvider, SemanticScholarProvider } from "@xiling/literature";
import { KnowledgeService } from "@xiling/knowledge";
import { LadybugResearchGraphStore } from "@xiling/research-graph";
import { CredentialStore } from "@xiling/credentials";
import { LocalArtifactStore, type ArtifactRegistry } from "@xiling/artifacts";
import { ExecutionCoordinator, SqliteExecutionRepository } from "@xiling/execution";
import { DockerConnectorProbe, DockerConnectorRunner } from "./connector-runner.js";
import { agentEntryReaderTool, agentHistorySearchTool, researchCapabilityCatalog, researchCapabilityCatalogFor, selectResearchCapabilities, selectResearchTools } from "./agent-tools.js";
import { FixtureProjectAnalysisRunner, ProjectWorkflowService, SqliteProjectWorkflowRepository, type ProjectAnalysisRunner } from "./project-workflow.js";
import { registerLiteratureRoutes } from "./modules/literature/routes.js";
import { BOT_SESSION_TITLE, registerWorkspaceRoutes } from "./modules/workspace/routes.js";
import { ModelSettingsService, humanizeModelFailure, registerSettingsRoutes } from "./modules/settings/routes.js";
import { registerConnectorRoutes } from "./modules/connectors/routes.js";
import { registerWorkflowRoutes } from "./modules/workflows/routes.js";
import { registerAgentCenterRoutes } from "./modules/agent-center/routes.js";
import { projectAgentWorkflowDraft, reconcileAgentWorkflowDrafts } from "./agent-workflow-projector.js";
import { McpSettingsService } from "./modules/mcp/mcp-service.js";
import { registerMcpSettingsRoutes } from "./modules/mcp/routes.js";
import { ResearchGraphReconciler } from "./research-graph-projector.js";
import { registerResearchGraphRoutes } from "./modules/research-graph/routes.js";
import { ScientificCanvasLayoutStore } from "./modules/research-graph/layout-store.js";
import { ResearchGraphProposalStore } from "./modules/research-graph/proposal-store.js";
import { SourceContentResolver } from "./source-content-resolver.js";
import { registerScienceDomainRoutes } from "./modules/science-domains/routes.js";
import { registerArtifactRoutes } from "./modules/artifacts/routes.js";
import { registerAttentionRoutes } from "./modules/attention/routes.js";
import { createTabularExecutionRunner, registerTabularExecutionRoutes } from "./modules/tabular/routes.js";
import { createInstalledScienceDomainRegistry } from "./installed-domains.js";
import { chooseAutomaticModel, selectModelRoute } from "./model-route-selection.js";
import { backgroundDecision } from "./background-policy.js";
import { BrainService } from "./modules/brain/service.js";
import { registerBrainRoutes } from "./modules/brain/routes.js";
import { registerVmDesktopRoutes, VmDesktopSession } from "./vm-desktop.js";
import { createBrainTools } from "./brain-tools.js";
import { fulfillAssignedBrowse } from "./assigned-browse.js";
import { fulfillAssignedDownload } from "./assigned-download.js";
import { fulfillAssignedInspect } from "./assigned-inspect.js";
import { deferredAssignment, deferredAssignmentReply } from "./deferred-assignment.js";
import { ComputerExecutor } from "./computer-executor.js";
import { createComputerTools } from "./computer-tools.js";
import { BotRoutineStore, dispatchDueRoutines, registerBotRoutineRoutes } from "./bot-routines.js";

export function createApp(options: { dataRoot?: string; webRoot?: string; skillsRoot?: string; literatureFetch?: typeof fetch; literatureSleep?: (ms: number, signal?: AbortSignal) => Promise<void>; connectorProbe?: ConnectorMetadataProbe; connectorDownloader?: ConnectorDownloader; connectorMode?: "fixture" | "live"; projectAnalysisRunner?: ProjectAnalysisRunner; artifactStore?: ArtifactRegistry; fixtureModel?: boolean; additionalProjects?: Array<{ id: string; name: string; description: string; researchQuestion: string; domainIds: string[] }> } = {}) {
  const app = Fastify({ logger: false });
  void app.register(cors, { origin: /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/ });
  const webRoot = options.webRoot ?? process.env.XILING_WEB_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  // wildcard 静态服务按请求实时解析路径：wildcard:false 会在启动时冻结文件
  // 清单，web 重新构建后新哈希资产全部 404（需重启服务才能恢复的隐性故障）。
  void app.register(fastifyStatic, { root: webRoot });
  registerErrorHandlers(app);
  const defaultDataRoot = process.env.VITEST || process.env.NODE_ENV === "test"
    ? resolve(tmpdir(), `xiling-app-test-${randomUUID()}`)
    : process.platform === "win32" && process.env.LOCALAPPDATA
      ? resolve(process.env.LOCALAPPDATA, "XiLingOS")
      : resolve(dirname(fileURLToPath(import.meta.url)), "../../../data");
  const dataRoot = options.dataRoot ?? process.env.XILING_DATA_ROOT ?? defaultDataRoot;
  const workspaceRoot = resolve(dataRoot, "workspace");
  registerLocalAccessControl(app, loadOrCreateLocalAccessToken(resolve(dataRoot, "runtime")));
  let artifactStore: ArtifactRegistry;
  const readManagedArtifact = async (projectId: string, uri: string, offsetBytes: number, maxBytes: number) => {
    if (!uri.startsWith("artifact://sha256/")) throw new Error("Only content-addressed managed Artifacts can be read through this tool");
    const result = await artifactStore.read(projectId, uri, offsetBytes, maxBytes);
    if (!/^(text\/|application\/(json|csv|xml|yaml|x-yaml))/i.test(result.record.mimeType)) throw new Error("Artifact is not a text format");
    return { uri, offsetBytes, text: Buffer.from(result.data).toString("utf8"), truncated: result.truncated };
  };
  const knowledgePath = resolve(workspaceRoot, "knowledge.sqlite");
  const agentCenterPath = resolve(workspaceRoot, "agent-center.sqlite");
  const knowledge = new KnowledgeService(knowledgePath);
  if (!knowledge.getProject(FREE_EXPLORATION_PROJECT_ID)) {
    knowledge.createProject({
      id: FREE_EXPLORATION_PROJECT_ID,
      name: "自由探索",
      description: "不绑定单一学科或研究事件的通用科研入口。",
      researchQuestion: "提出研究问题，检索和核对证据，规划数据与方法，并将结果沉淀为可追溯的科研对象。",
      domainIds: ["general-science"],
    });
  }
  for (const project of options.additionalProjects ?? []) if (!knowledge.getProject(project.id)) knowledge.createProject(project);
  artifactStore = options.artifactStore ?? new LocalArtifactStore(resolve(workspaceRoot, "artifacts.sqlite"), resolve(workspaceRoot, "artifact-blobs"));
  if (!options.artifactStore) app.addHook("onClose", async () => (artifactStore as LocalArtifactStore).close());
  registerArtifactRoutes(app, artifactStore, (projectId) => Boolean(knowledge.getProject(projectId)));
  const executionRepository = new SqliteExecutionRepository(resolve(workspaceRoot, "executions.sqlite"));
  const executionRecovered = executionRepository.recoverInterrupted();
  if (executionRecovered > 0) console.warn(`[xiling] marked ${executionRecovered} interrupted execution(s) from a previous session as failed`);
  void reapOrphanSandboxes()
    .then((removed) => { if (removed > 0) console.warn(`[xiling] removed ${removed} orphaned sandbox container(s) from a previous session`); })
    .catch(() => undefined);
  const executionCoordinator = new ExecutionCoordinator(executionRepository, createTabularExecutionRunner(artifactStore));
  app.addHook("onClose", async () => executionRepository.close());
  registerTabularExecutionRoutes(app, { artifacts: artifactStore, executions: executionCoordinator, projectExists: (projectId) => Boolean(knowledge.getProject(projectId)) });
  const scienceDomains = createInstalledScienceDomainRegistry();
  const installedCapabilityCatalog = researchCapabilityCatalogFor(scienceDomains.list().flatMap((domain) => domain.capabilities));
  registerScienceDomainRoutes(app, scienceDomains);
  const agentSessionStore = new SqliteAgentSessionStore(agentCenterPath);
  const researchGraph = new LadybugResearchGraphStore(resolve(workspaceRoot, "research-graph.lbdb"));
  const scientificCanvasLayout = new ScientificCanvasLayoutStore(resolve(workspaceRoot, "scientific-canvas-layout.sqlite"));
  const researchGraphProposals = new ResearchGraphProposalStore(resolve(workspaceRoot, "research-graph-proposals.sqlite"));
  const credentials = new CredentialStore(resolve(dataRoot, "credentials"));
  const credentialsReady = credentials.initialize();
  const modelRuntime = new ModelRuntimeStore(resolve(workspaceRoot, "model-runtime.json"));
  const tokenLedger = new TokenLedger(resolve(workspaceRoot, "token-ledger.jsonl"));
  const skillCatalog = new LazySkillCatalog(options.skillsRoot ?? process.env.XILING_SKILLS_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../../skills"));
  const skillCatalogReady = skillCatalog.initialize().then(() => {
    const knownSkills = new Set(skillCatalog.list().map((skill) => skill.name));
    for (const capability of installedCapabilityCatalog) for (const skillName of capability.skillNames) if (!knownSkills.has(skillName)) throw new Error(`Capability ${capability.id} references unknown Skill ${skillName}`);
  });
  const contextAssemblyCache = new ContextAssemblyCache();
  const modelRuntimeReady = modelRuntime.initialize();
  const modelSettings = new ModelSettingsService(credentials, modelRuntime, credentialsReady, modelRuntimeReady);
  registerSettingsRoutes(app, modelSettings, credentialsReady, { ready: skillCatalogReady, list: () => skillCatalog.list(), capabilities: installedCapabilityCatalog });
  const mcpGateway = new PiMcpGatewayManager(resolve(workspaceRoot, "mcp", "host"));
  const mcpSettings = new McpSettingsService(resolve(workspaceRoot, "mcp"), credentials, mcpGateway);
  const mcpReady = credentialsReady.then(() => mcpSettings.initialize());
  registerMcpSettingsRoutes(app, mcpSettings, mcpReady);
  const modelStatus = () => modelSettings.status();
  const customRouteConfig = () => modelSettings.customRouteConfig();
  const literatureCache = new FileLiteratureCache(resolve(workspaceRoot, "literature-cache"));
  const literature = new LiteratureSearchService(
    new SemanticScholarProvider(options.literatureFetch ?? fetch, () => credentials.get("semantic-scholar", "apiKey")),
    new OpenAlexProvider(options.literatureFetch ?? fetch, () => credentials.get("openalex", "apiKey")),
    literatureCache,
    { retry: { ...(options.literatureSleep ? { sleep: options.literatureSleep } : {}) } },
  );
  const fixtureConnector = new FixtureConnectorAdapter(resolve(workspaceRoot, "connector-artifacts"));
  const connectorMode = options.connectorMode ?? (process.env.XILING_CONNECTOR_MODE === "live" ? "live" : "fixture");
  const connectorCredentials = (connectorId: OceanSubsetRequest["connectorId"]): Record<string, unknown> => {
    const network = Object.fromEntries(["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "REQUESTS_CA_BUNDLE", "SSL_CERT_FILE"].flatMap((name) => process.env[name] ? [[name, process.env[name]!]] : []));
    const base = Object.keys(network).length ? { _network: network } : {};
    if (connectorId === "copernicus-marine") return { ...base, ...Object.fromEntries(["username", "password"].flatMap((field) => { const value = credentials.get("copernicus-marine", field); return value ? [[field, value]] : []; })) };
    if (connectorId === "nasa-harmony") return { ...base, ...Object.fromEntries(["token", "username", "password"].flatMap((field) => { const value = credentials.get("nasa-earthdata", field); return value ? [[field, value]] : []; })) };
    return base;
  };
  const liveConnectorProbe = new DockerConnectorProbe(resolve(workspaceRoot, "connector-metadata"), connectorCredentials);
  const liveConnectorRunner = new DockerConnectorRunner(resolve(workspaceRoot, "connector-runs"), connectorCredentials);
  const connectorProbe = options.connectorProbe ?? (connectorMode === "live" ? liveConnectorProbe : fixtureConnector);
  const connectorWorkflow = new ConnectorWorkflowService(
    new JsonConnectorJobRepository(resolve(workspaceRoot, "connector-jobs.json")),
    options.connectorDownloader ?? (connectorMode === "live" ? liveConnectorRunner : fixtureConnector),
  );
  const connectorReady = connectorWorkflow.initialize();
  const connectorCredentialsAvailable = (request: OceanSubsetRequest) => {
    const credentialId = request.connectorId === "copernicus-marine" ? "copernicus-marine" : request.connectorId === "nasa-harmony" ? "nasa-earthdata" : undefined;
    return !credentialId || credentials.status(credentialId).configured;
  };
  const projectWorkflowRepository = new SqliteProjectWorkflowRepository(resolve(workspaceRoot, "project-workflows.sqlite"));
  const projectWorkflow = new ProjectWorkflowService(
    projectWorkflowRepository,
    connectorWorkflow,
    connectorProbe,
    options.projectAnalysisRunner ?? (connectorMode === "live" ? new DockerProjectAnalysisRunner(workspaceRoot) : new FixtureProjectAnalysisRunner(resolve(workspaceRoot, "project-runs"))),
    connectorCredentialsAvailable,
    undefined,
    new LocalWorkflowArtifactRegistrar(workspaceRoot, artifactStore),
  );
  const projectWorkflowReady = Promise.all([connectorReady, credentialsReady]).then(() => projectWorkflow.initialize());
  const connectorMetadata = new Map<string, { requestHash: string; metadata: ConnectorMetadataSummary }>();
  const activeConnectorRuns = new Map<string, AbortController>();
  app.addHook("onClose", async () => knowledge.close());
  app.addHook("onClose", async () => { for (const controller of activeConnectorRuns.values()) controller.abort("server closing"); });
  registerLiteratureRoutes(app, { literature, credentialsReady, evidence: knowledge, validateClaimRevision: async (projectId, entityId) => {
    await researchGraphReady; await researchGraphReconciler.reconcile();
    const entity = await researchGraph.getEntity(projectId, entityId);
    return entity?.kind === "ClaimRevision";
  } });
  const sourceContentResolver = new SourceContentResolver({
    getWikiPage: (id) => knowledge.getWikiPage(id),
    listEvidence: (projectId) => knowledge.listEvidence(projectId),
    getAgentRun: (runId) => {
      const run = agentSessionStore.getRun(runId);
      const session = run ? agentSessionStore.getSession(run.sessionId) : undefined;
      if (!run || !session) return undefined;
      return { projectId: session.projectId, prompt: run.prompt, entries: agentSessionStore.snapshot(runId).entries.map(({ role, kind, text }) => ({ role: role ?? kind, text })) };
    },
    getWorkflow: (id) => projectWorkflow.get(id),
    readArtifact: readManagedArtifact,
  });
  const projectResearchContext = async (projectId: string, request: { activeNodeId: string; quotedNodeIds: string[]; capabilityQuery?: string; activatedCapabilityIds?: string[] }) => {
    await researchGraphReady;
    await researchGraphReconciler.reconcile();
    const graph = await researchGraph.getProjection(projectId, "all");
    knowledge.pruneContextCapsules(projectId, graph.nodes.map((node) => node.id));
    const persisted = new Map(knowledge.listContextCapsules(projectId).map((capsule) => [capsule.id, capsule]));
    const capsuleMap = new Map<string, ContextCapsule>();
    for (const node of graph.nodes) {
      const artifactUris = (node.uri && /^(artifact|dataset|project):\/\//.test(node.uri) ? [node.uri as ResourceUri] : []) as ContextCapsule["artifactUris"];
      const candidate = createNodeContextCapsule({ projectId, nodeId: node.id, title: node.title, body: node.summary, artifactUris, updatedAt: node.updatedAt });
      const existing = persisted.get(candidate.id);
      const capsule = existing?.sourceRevision === candidate.sourceRevision ? existing : knowledge.upsertContextCapsule(projectId, candidate);
      capsuleMap.set(node.id, capsule);
    }
    const project = knowledge.getProject(projectId);
    if (!project) throw new Error("Project not found");
    const domain = scienceDomains.resolve(project.domainIds);
    const projectCapabilityCatalog = researchCapabilityCatalogFor(domain.capabilities);
    const resolvedCapabilities = request.activatedCapabilityIds ?? (request.capabilityQuery ? selectResearchCapabilities(request.capabilityQuery, projectCapabilityCatalog).map((capability) => capability.id) : []);
    const projectionRequest = { activeNodeId: request.activeNodeId, quotedNodeIds: request.quotedNodeIds, activatedCapabilityIds: resolvedCapabilities };
    let projection = projectResearchGraphContext(projectionRequest, graph, capsuleMap, projectCapabilityCatalog);
    const selectedIds = [...new Set([...projection.activeBranchNodeIds, ...projection.quotedNodeIds])];
    const resolvedNodes = new Map<string, ContextNodeContent>(graph.nodes.map((node) => [node.id, { id: node.id, title: node.title, body: node.summary, sourceLabel: "科研图结构化摘要（非原文）", sourceKind: "structured-summary", ...(node.sourceLocator || node.uri ? { sourceLocator: node.sourceLocator ?? node.uri } : {}) }]));
    let capsuleRefreshed = false;
    for (const nodeId of selectedIds) {
      const node = graph.nodes.find((candidate) => candidate.id === nodeId);
      if (!node) continue;
      const resolved = await sourceContentResolver.resolve(projectId, node);
      resolvedNodes.set(node.id, resolved);
      const artifactUris = (node.uri && /^(artifact|dataset|project):\/\//.test(node.uri) ? [node.uri as ResourceUri] : []) as ContextCapsule["artifactUris"];
      const candidate = createNodeContextCapsule({ projectId, nodeId: node.id, title: node.title, body: resolved.body, artifactUris, updatedAt: node.updatedAt });
      const existing = capsuleMap.get(candidate.id);
      if (existing?.sourceRevision !== candidate.sourceRevision) {
        capsuleMap.set(node.id, knowledge.upsertContextCapsule(projectId, candidate));
        capsuleRefreshed = true;
      }
    }
    // Re-projecting is only meaningful when a selected node's capsule actually
    // changed; otherwise the first projection already reflects current state.
    if (capsuleRefreshed) projection = projectResearchGraphContext(projectionRequest, graph, capsuleMap, projectCapabilityCatalog);
    return { graph, projection, resolvedNodes };
  };
  let computerExecutor: ComputerExecutor | undefined;
  const agentHarness = new ResearchAgentHarness(agentSessionStore, {
    create: async ({ sessionId, runId, prompt, attachments, commandContext, history, onUsage }) => {
      const command = z.object({
        projectId: z.string().min(1).max(120),
        modelRoute: z.object({ providerId: z.enum(["openai", "anthropic", "google", "openrouter", "deepseek", "xai", "mistral", "moonshotai", "zai", "groq", "custom"]), modelId: z.string().trim().min(1).max(240) }).optional(),
        context: z.object({ activeNodeId: z.string().min(1).max(120), quotedNodeIds: z.array(z.string().min(1).max(120)).max(12) }).optional(),
        multiAgent: z.object({ delegationId: z.string().min(1).max(160), rootRunId: z.string().min(1).max(160), parentRunId: z.string().min(1).max(160), roleId: z.string().min(1).max(80), isolation: z.enum(["scoped", "blind", "execution"]), contextManifest: z.object({ projectId: z.string().min(1).max(120), projectBriefRevision: z.string().min(1).max(240), researchEntityIds: z.array(z.string().min(1).max(240)).max(64), sourceUris: z.array(z.string().min(1).max(2_000)).max(64), projectionHash: z.string().min(1).max(240) }), budget: z.object({ maxDurationMs: z.number().positive(), maxToolCalls: z.number().int().positive(), maxCost: z.number().positive().optional() }) }).optional(),
      }).parse(commandContext);
      const activeProject = knowledge.getProject(command.projectId);
      if (!activeProject || activeProject.status === "archived") throw new Error("Project not found or archived");
      const session = agentSessionStore.getSession(sessionId);
      if (!session || session.projectId !== activeProject.id) throw new Error("Agent session project mismatch");
      const activeDomain = scienceDomains.resolve(activeProject.domainIds);
      const activeCapabilityCatalog = researchCapabilityCatalogFor(activeDomain.capabilities);
      if (command.multiAgent) throw new Error("内置子智能体已停用，后续能力请通过 MCP 接入");
      const activeCapabilities = selectResearchCapabilities(prompt, activeCapabilityCatalog);
      let activeTools = selectResearchTools(prompt, { project: activeProject, knowledge, literature, readArtifact: (uri, offset, max) => readManagedArtifact(activeProject.id, uri, offset, max) }, activeCapabilityCatalog);
      await skillCatalogReady;
      const activatedSkills = await skillCatalog.activate(prompt, activeCapabilities.map((capability) => capability.id));
      await mcpReady;
      if (mcpGateway.matches(prompt)) activeTools = [...activeTools, mcpGateway.tool()];
      const persistedContext = knowledge.getChatSessionContext(sessionId);
      const defaultContext = { activeNodeId: `research-question:${activeProject.id}`, quotedNodeIds: [] };
      const requestedContext = command.context ?? (persistedContext ? { activeNodeId: persistedContext.activeNodeId, quotedNodeIds: persistedContext.quotedNodeIds } : defaultContext);
      let resolvedContext = requestedContext;
      let researchProjection: Awaited<ReturnType<typeof projectResearchContext>>;
      try { researchProjection = await projectResearchContext(activeProject.id, { ...requestedContext, activatedCapabilityIds: activeCapabilities.map((capability) => capability.id) }); }
      catch (error) {
        // The persisted context pointing at a removed entity (or a graph cycle)
        // must stay explainable: log the fallback before degrading to defaults.
        console.warn(`[xiling] falling back to default research context for session ${sessionId}: ${error instanceof Error ? error.message : error}`);
        resolvedContext = defaultContext;
        researchProjection = await projectResearchContext(activeProject.id, { ...resolvedContext, activatedCapabilityIds: activeCapabilities.map((capability) => capability.id) });
      }
      if (knowledge.getChatSession(sessionId)) knowledge.setChatSessionContext(sessionId, { projectId: activeProject.id, ...resolvedContext });
      const routeStatus = await modelStatus();
      const primaryRoute = routeStatus.primary;
      const turnOverride: ModelRouteSettings | undefined = command.modelRoute
        ? { ...command.modelRoute, reasoning: primaryRoute?.reasoning ?? "medium", inputModalities: resolveModelCatalogEntry(command.modelRoute.providerId, command.modelRoute.modelId).inputModalities.filter((item): item is "text" | "image" => item === "text" || item === "image") }
        : undefined;
      const storedPreferences = modelRuntime.get();
      let requestedRoute = selectModelRoute(routeStatus, { ...(turnOverride ? { turnOverride } : {}) }).route;
      let modelSelection: "manual" | "auto" = storedPreferences.selection === "auto" ? "auto" : "manual";
      if (modelSelection === "auto") {
        const requiredModalities: Array<"text" | "image"> = attachments.some((item) => item.modality === "image") ? ["text", "image"] : ["text"];
        const providers = storedPreferences.autoProviders?.length ? storedPreferences.autoProviders : requestedRoute ? [requestedRoute.providerId] : [];
        const automatic = chooseAutomaticModel({ providers, requiredModalities, costCapUsd: storedPreferences.costCapUsd ?? 1, catalog: listRecommendedModels() });
        if (!automatic) throw new Error("automatic_model_unavailable");
        requestedRoute = { providerId: automatic.providerId, modelId: automatic.modelId, reasoning: requestedRoute?.reasoning ?? storedPreferences.primary?.reasoning ?? "medium" };
      }
      const useFixtureModel = options.fixtureModel ?? Boolean(process.env.VITEST || process.env.NODE_ENV === "test");
      if (requestedRoute && /^sk[-_]/i.test(requestedRoute.modelId)) throw new Error("模型名无效：保存的是 API Key。请在对话输入框旁重新选择 DeepSeek V4 Pro。");
      if (!requestedRoute && !useFixtureModel) throw new Error("selection_required");
      if (requestedRoute && !credentials.status(requestedRoute.providerId).configured) throw new Error("credential_required");
      let selectedRuntimeRoute: ReturnType<typeof createLiveRoute> | ReturnType<typeof createOfflineRoute> | undefined;
      if (requestedRoute) {
        const apiKey = credentials.get(requestedRoute.providerId as ModelProviderId, "apiKey") ?? (requestedRoute.providerId === "custom" ? "xiling-local" : undefined);
        if (!apiKey) throw new Error("credential_required");
        selectedRuntimeRoute = createLiveRoute(requestedRoute.providerId, requestedRoute.modelId, apiKey, requestedRoute.providerId === "custom" ? customRouteConfig() : undefined, requestedRoute.inputModalities);
      } else selectedRuntimeRoute = createOfflineRoute();
      const resolveImages = (items: typeof attachments) => items.map((attachment) => {
        const stored = agentSessionStore.getAttachment(attachment.id);
        if (!stored || stored.projectId !== activeProject.id || stored.sha256 !== attachment.sha256) throw new Error("Agent image attachment is missing or failed integrity validation");
        return { type: "image" as const, data: Buffer.from(stored.data).toString("base64"), mimeType: stored.mimeType };
      });
      const currentImages = resolveImages(attachments);
      const historyAttachments = new Map(history.map((message) => [message.id, message.attachments ?? []] as const));
      const freeExploration = activeProject.id === FREE_EXPLORATION_PROJECT_ID;
      const coreRules = [
        "你是汐灵 OS 的科学研究 Agent。",
        ...activeDomain.promptFragments,
        ...(freeExploration
          ? ["当前处于自由探索模式：不绑定单一学科或研究事件，可协助广泛科学领域的问题形成、文献与证据检索、数据和方法规划、计算分析与复现审查。涉及特定学科能力时，应建议用户创建或切换到启用相应领域模块的项目；涉及已有项目时先调用 read_project_context。"]
          : ["只处理当前项目；需要项目细节时先调用 read_project_context。"]),
        "只在用户问题确实需要时调用其余已激活工具；不得假装工具已经运行。",
        "MCP 只允许先搜索/描述后调用；若工具返回需要审批，必须停止并请用户在设置中显式信任对应服务器后重试，不得规避审批。",
        "用户要求打开网页、操作电脑、运行命令、查看目录或保存文件，并且原话里没有指定钟点时，直接调用 computer_browse、computer_shell、computer_read、computer_write，在当前执行目标上自己完成。远程 SSH 上查看目录用 computer_shell 执行 ls，不要写成让用户自己在终端运行的步骤。",
        "用户要求把论文或单个文件下载到桌面，并且原话里没有指定钟点时，调用 computer_download 把 PDF 保存到当前电脑桌面，不要写成步骤让用户自己操作。单个文件不超过 40MB。原话里有今天、每天、工作日或钟点时，这一轮不要下载。",
        "正式科研结论和大规模数据集下载仍停在计划阶段并进入待决定，不要直接写入 Claim 或 Evidence。",
        ...(knowledge.getChatSession(sessionId)?.title === BOT_SESSION_TITLE ? ["如果用户原话里有钟点，这一轮不要打开、下载或运行命令，只说明到点再做。没有钟点的交办才立刻做完，不要让用户自己设闹钟或按步骤操作。钟点按原话换算成 24 小时制：早上八点是 8，下午三点是 15，八点半的分钟是 30。今天、今日只执行一次，schedule 用 once；每天用 daily，工作日用 weekdays，每小时用 hourly。在回复最末尾追加 ```xiling-routine 换行 {\"schedule\":\"once\",\"hour\":16,\"minute\":20,\"instruction\":\"打开山东大学官网主页\"} 换行 ```。hour 与 minute 必须换成用户原话里的钟点，instruction 只留要做的事。不要自己把任务写入定时列表，等用户确认。"] : []),
        "当你需要用户确认或做出选择时，必须在回复的最末尾追加一个选项块供界面渲染成可点击按钮：```xiling-choices 换行 [\"选项一\", \"选项二\"] 换行 ```；给 2 到 4 个选项，每个不超过 16 字、可直接作为用户回复发送；若你已在正文中列出带编号的确认事项，选项应与之对应（如「按默认方案推进」「1 改为…」）；没有需要确认的事项时不要输出该块。",
        "引用工具结果时说明数据源；缺少证据时明确说明。",
        `本轮实际模型会在界面标明。若已选定模型，在回复末尾单独一行写「实际模型：${requestedRoute?.providerId ?? "fixture"}/${requestedRoute?.modelId ?? "fixture"}」。`,
        "读写笔记、来源和科研图关系时使用 brain_search、brain_read_source、brain_save_note、brain_link，不要直接写图数据库或 Wiki 表。",
        "涉及正式 Claim 或 Evidence 的关系只会进入待决定队列。",
      ].join("\n");
      const executionTarget = storedPreferences.execution?.target ?? "vm";
      const executionLabel = executionTarget === "local" ? "本机" : executionTarget === "ssh" ? `远程 SSH${storedPreferences.execution?.sshHost ? ` ${storedPreferences.execution.sshHost}` : ""}` : "虚拟机";
      const projectPrompt = `当前项目：${activeProject.name}\n研究问题：${activeProject.researchQuestion}\n当前科研图活动实体：${resolvedContext.activeNodeId}\n当前科研图显式引用：${resolvedContext.quotedNodeIds.join(", ") || "无"}\n当前执行目标：${executionLabel}。这台电脑有桌面、终端、文件和浏览器。交办后由你自己操作，用户不需要动手；虚拟机画面嵌在 Bot 里。正式结论和大规模下载除外。`;
      const historyRecords = history;
      const allowedSourceEntries = new Set<string>();
      const latestCompaction = agentSessionStore.latestCompaction(sessionId);
      const compactedEntries = latestCompaction
        ? agentSessionStore.listSessionEntries(sessionId).filter((entry) => entry.sequence <= latestCompaction.coveredThroughSequence && entry.kind !== "compaction")
        : [];
      for (const entry of compactedEntries) allowedSourceEntries.add(entry.id);
      const historyLookupPrompt = latestCompaction
        ? "较早研究对话已压缩为结构化索引。遇到摘要无法回答的旧决策、证据或产物时，先调用 search_agent_history，再按返回的 Entry ID 调用 read_agent_entry；不要猜测被压缩内容。"
        : "";
      if (allowedSourceEntries.size) activeTools = [...activeTools, agentEntryReaderTool({
        project: activeProject,
        knowledge,
        literature,
        readAgentEntry: async (entryId, offsetChars, maxChars) => {
          if (!allowedSourceEntries.has(entryId)) throw new Error("Agent entry is not declared by the compacted session index");
          const entry = agentSessionStore.getEntry(entryId);
          const sourceSession = entry ? agentSessionStore.getSession(entry.sessionId) : undefined;
          if (!entry || sourceSession?.projectId !== activeProject.id) throw new Error("Agent entry is outside the active project");
          const text = entry.text.slice(offsetChars, offsetChars + maxChars);
          return { entryId, text, offsetChars, truncated: offsetChars + text.length < entry.text.length };
        },
      })];
      if (latestCompaction) activeTools = [...activeTools, agentHistorySearchTool({
        project: activeProject,
        knowledge,
        literature,
        searchAgentHistory: async (query, limit) => {
          const normalized = query.toLocaleLowerCase().trim();
          const terms = [...new Set([normalized, ...normalized.split(/\s+/u).filter((term) => term.length > 1)])];
          return compactedEntries
            .map((entry) => ({ entry, score: terms.reduce((score, term) => score + (entry.text.toLocaleLowerCase().includes(term) ? term.length : 0), 0) }))
            .filter(({ score }) => score > 0)
            .sort((left, right) => right.score - left.score || right.entry.sequence - left.entry.sequence)
            .slice(0, limit)
            .map(({ entry }) => ({ entryId: entry.id, kind: entry.kind, excerpt: entry.text.replace(/\s+/gu, " ").slice(0, 700), createdAt: entry.createdAt }));
        },
      })];
      activeTools = [...activeTools, ...createBrainTools(brainService, activeProject.id), ...(computerExecutor && !deferredAssignment(prompt) ? createComputerTools(computerExecutor) : [])];
      const modelContextWindow = selectedRuntimeRoute.contextWindow;
      const maxOutputTokens = selectedRuntimeRoute.maxOutputTokens;
      const projectionHash = researchProjection.projection.projectionHash;
      const cacheKey = contextAssemblyCache.key({ projectId: activeProject.id, sessionId, projectionHash, prompt, history: historyRecords.map(({ id, role, text }) => [id, role, text]), modelContextWindow, maxOutputTokens, skills: activatedSkills.entries.map(({ name, version }) => [name, version]), tools: activeTools.map((tool) => tool.name) });
      let contextAssembly = contextAssemblyCache.get(cacheKey);
      if (contextAssembly) contextAssembly.trace.cache = "hit";
      else {
        contextAssembly = assembleContext({ projection: researchProjection.projection, nodes: researchProjection.resolvedNodes, history: historyRecords, modelContextWindow, maxOutputTokens, fixedPromptTokens: estimateContextTokens(`${coreRules}\n${projectPrompt}\n当前用户问题：${prompt}`), toolSchemaTokens: estimateContextTokens(JSON.stringify(activeTools.map(({ name, description, parameters }) => ({ name, description, parameters })))), skillTokens: estimateContextTokens(activatedSkills.prompt), activatedSkillNames: activatedSkills.skills.map((skill) => skill.name) });
        contextAssemblyCache.set(cacheKey, contextAssembly);
      }
      // Binary visual context is deliberately lazy: the current turn is always
      // native, while historical bytes are restored only when the user refers
      // to an earlier image. Descriptors remain in durable history either way.
      const explicitPriorImageReference = /上(?:一)?张|前(?:一)?张|先前|此前|之前|刚才|历史图片|previous\s+(?:image|figure)|earlier\s+(?:image|figure)|last\s+(?:image|figure)/iu.test(prompt);
      const implicitImageReference = currentImages.length === 0 && /(?:这|那|该)?(?:张)?(?:图像|图片|截图|照片|图中)|(?:它|其中|这个).*(?:显示|表明|说明|异常)|(?:image|figure).*(?:show|indicate|compare)/iu.test(prompt);
      const historicalImageMessageId = explicitPriorImageReference || implicitImageReference
        ? [...contextAssembly.history].reverse().find((message) => (historyAttachments.get(message.id)?.length ?? 0) > 0)?.id
        : undefined;
      const runtime = new PiRuntimeAdapter({
        sessionId,
        systemPrompt: [coreRules, projectPrompt, contextAssembly.canvasText ? `科研图局部上下文：\n${contextAssembly.canvasText}` : "当前科研图选择没有可用上下文。", historyLookupPrompt, activatedSkills.prompt ? `本轮按需加载的 Skill：\n${activatedSkills.prompt}` : "本轮没有命中额外 Skill。"].filter(Boolean).join("\n"),
        route: selectedRuntimeRoute,
        initialMessages: contextAssembly.history.map((message) => {
          const descriptors = historyAttachments.get(message.id) ?? [];
          const images = message.id === historicalImageMessageId ? resolveImages(descriptors) : [];
          const attachmentNote = descriptors.length ? `\n[原生图像附件：${descriptors.map(({ name }) => name).join("、")}；${images.length ? "本轮已按需载入" : "本轮未重复载入"}]` : "";
          return { role: message.role, text: `${message.text}${attachmentNote}`, timestamp: message.timestamp, ...(images.length ? { images } : {}) };
        }),
        contextPolicy: "deduplicate-adjacent",
        reasoning: requestedRoute?.reasoning ?? "off",
        onUsage: async (usage) => {
          const normalized = { providerId: requestedRoute?.providerId ?? "xiling-test-fixture", modelId: requestedRoute?.modelId ?? "fixture", inputTokens: usage.input, outputTokens: usage.output, cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite, reasoningTokens: usage.reasoning ?? 0, totalTokens: usage.totalTokens, cost: usage.cost.total } satisfies RuntimeUsageInput;
          await onUsage(normalized);
          await tokenLedger.record({ sessionId, providerId: normalized.providerId, modelId: normalized.modelId, inputTokens: normalized.inputTokens, outputTokens: normalized.outputTokens, cacheReadTokens: normalized.cacheReadTokens, cacheWriteTokens: normalized.cacheWriteTokens, reasoningTokens: normalized.reasoningTokens, totalTokens: normalized.totalTokens, cost: normalized.cost, projectionHash, contextEstimatedTokens: contextAssembly.trace.estimatedInputTokens, contextAvailableTokens: contextAssembly.trace.availableInputTokens, contextCacheHit: contextAssembly.trace.cache === "hit", activatedCapabilityCount: contextAssembly.trace.activatedCapabilityIds.length, activatedSkillCount: contextAssembly.trace.activatedSkillNames.length, omittedHistoryCount: contextAssembly.trace.omittedHistoryCount, contextSourceCoverage: contextAssembly.trace.sourceCoverage.ratio, contextDuplicateHistoryCount: contextAssembly.trace.deduplicatedHistoryCount });
        },
      });
      runtime.setActiveTools(activeTools);
      return {
        subscribe(listener: (event: AgentStreamEvent) => void | Promise<void>) {
          let contextDelivered = false;
          return runtime.subscribe(async (event) => {
            if (!contextDelivered) {
              contextDelivered = true;
              if (requestedRoute) await listener({ type: "model.selected", providerId: requestedRoute.providerId, modelId: requestedRoute.modelId, selection: modelSelection });
              await listener({ type: "context.ready", trace: contextAssembly.trace });
            }
            const deliveredEvent = event.type === "session.error" ? { ...event, message: humanizeModelFailure(event.message) } : event;
            await listener(deliveredEvent);
            if (event.type !== "tool.finished") return;
            const sourceEvent = agentSessionStore.lastEvent(runId);
            if (!sourceEvent || sourceEvent.type !== "tool.finished") return;
            const operation = agentSessionStore.findOperationByCallId(runId, event.callId);
            const projectionEvent = await projectAgentWorkflowDraft({
              event,
              projectId: activeProject.id,
              sessionId,
              runId,
              sourceEventSequence: sourceEvent.sequence,
              ...(operation ? { sourceOperationId: operation.id } : {}),
              ready: projectWorkflowReady,
              workflows: projectWorkflow,
            });
            if (projectionEvent) await listener(projectionEvent);
          });
        },
        prompt: (text: string) => runtime.prompt(text, currentImages),
        abort: () => runtime.abort(),
        // Custom providers and model IDs missing from the catalog report zero
        // cost; flag it so the harness cost guard degrades to tool/duration.
        costAccountingKnown: useFixtureModel || !requestedRoute ? true : requestedRoute.providerId !== "custom" && Boolean(findKnownModelCatalogEntry(requestedRoute.providerId, requestedRoute.modelId)),
      };
    },
  }, {
    compaction: {
      maxEntries: 24,
      retainEntries: 10,
      maxEstimatedTokens: 18_000,
      maxEstimatedChars: 72_000,
      async summarize(entries) {
        const indexed = entries.map((entry) => {
          const normalized = entry.text.replace(/\s+/gu, " ").trim();
          const references = [...new Set(normalized.match(/(?:artifact|dataset|project):\/\/[^\s,;，。)\]]+|https?:\/\/[^\s,;，。)\]]+|10\.\d{4,9}\/[-._;()/:A-Z0-9]+/giu) ?? [])].slice(0, 8);
          const tags = [
            /假设|hypothes/iu.test(normalized) ? "假设" : "",
            /决定|采用|选择|decision/iu.test(normalized) ? "决策" : "",
            /证据|结果|发现|evidence|result/iu.test(normalized) ? "证据" : "",
            /局限|风险|不确定|limitation|uncertain/iu.test(normalized) ? "局限" : "",
          ].filter(Boolean);
          return `- [entry:${entry.id}] ${entry.role ?? entry.kind}${tags.length ? ` · ${tags.join("/")}` : ""}：${normalized.slice(0, 360)}${normalized.length > 360 ? "…" : ""}${references.length ? `\n  来源指针：${references.join("；")}` : ""}`;
        });
        return {
          summary: ["前序研究记录增量索引（每项保留耐久 Entry 指针，可按需检索全文）：", ...indexed].join("\n"),
          model: "xiling-structured-compactor-v2",
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0, cost: 0 },
        };
      },
    },
    settleAnswer: async ({ prompt, answer, toolNames }) => {
      if (!computerExecutor) return answer;
      const waiting = deferredAssignmentReply(prompt);
      if (waiting) return waiting;
      const downloaded = await fulfillAssignedDownload(computerExecutor, prompt, answer, toolNames);
      if (downloaded !== answer) return downloaded;
      const browsed = await fulfillAssignedBrowse(computerExecutor, prompt, answer, toolNames);
      if (browsed !== answer) return browsed;
      return fulfillAssignedInspect(computerExecutor, prompt, answer, toolNames);
    },
  });
  const workflowProjectionReady = reconcileAgentWorkflowDrafts({ store: agentSessionStore, ready: projectWorkflowReady, workflows: projectWorkflow });
  const researchGraphReconciler = new ResearchGraphReconciler(researchGraph, knowledge, projectWorkflowRepository, agentSessionStore);
  const researchGraphReady = Promise.all([workflowProjectionReady, projectWorkflowReady]).then(() => researchGraphReconciler.reconcile());
  const brainService = new BrainService({
    knowledge,
    graph: researchGraph,
    graphReady: researchGraphReady,
    sources: sourceContentResolver,
    proposals: researchGraphProposals,
    searchChat(projectId, query) {
      const needle = query.toLocaleLowerCase();
      const botSessionIds = new Set(knowledge.listChatSessions(projectId).filter((session) => session.title === BOT_SESSION_TITLE).map((session) => session.id));
      return agentSessionStore.listProjectSessions(projectId).filter((session) => !botSessionIds.has(session.id)).flatMap((session) => agentSessionStore.listSessionEntries(session.id)
        .filter((entry) => (entry.role === "user" || entry.role === "assistant") && entry.text.toLocaleLowerCase().includes(needle))
        .map((entry) => ({ id: entry.id, text: entry.text, createdAt: entry.createdAt }))).slice(0, 12);
    },
  });
  registerBrainRoutes(app, brainService, (projectId) => Boolean(knowledge.getProject(projectId)));
  const vmDesktop = new VmDesktopSession();
  computerExecutor = new ComputerExecutor({
    localRoot: resolve(workspaceRoot, "bot-computer"),
    target: () => {
      const execution = modelRuntime.get().execution;
      return { target: execution?.target ?? "vm", ...(execution?.sshHost ? { sshHost: execution.sshHost } : {}) };
    },
    ensureVm: async () => {
      if (modelRuntime.get().execution?.target !== "vm") return;
      vmDesktop.start();
      await vmDesktop.settled();
    },
  });
  registerVmDesktopRoutes(app, vmDesktop, () => modelRuntime.get().execution?.target ?? "vm");
  const botRoutines = new BotRoutineStore(resolve(workspaceRoot, "bot-routines.json"));
  registerBotRoutineRoutes(app, botRoutines, (projectId) => Boolean(knowledge.getProject(projectId)));
  if (!process.env.VITEST && process.env.NODE_ENV !== "test") {
    const routineTimer = setInterval(() => {
      dispatchDueRoutines({
        now: new Date(),
        routines: botRoutines,
        sessionId: (projectId) => {
          const existing = knowledge.listChatSessions(projectId).find((session) => session.title === BOT_SESSION_TITLE);
          if (existing) {
            if (!agentSessionStore.getSession(existing.id)) agentHarness.createSession({ id: existing.id, projectId });
            return existing.id;
          }
          const created = knowledge.createChatSession(projectId, BOT_SESSION_TITLE);
          agentHarness.createSession({ id: created.id, projectId });
          return created.id;
        },
        busy: (sessionId) => agentSessionStore.listSessionRuns(sessionId).some((run) => run.status === "queued" || run.status === "running"),
        start: (sessionId, projectId, routineId, instruction, slot) => {
          agentHarness.startTurn({ sessionId, prompt: instruction, clientCommandId: `routine:${routineId}:${slot}`, context: { projectId } });
        },
      });
    }, 15_000);
    routineTimer.unref();
    app.addHook("onClose", async () => { clearInterval(routineTimer); });
  }
  app.addHook("onClose", async () => { await vmDesktop.stop(); });
  if (!process.env.VITEST && process.env.NODE_ENV !== "test") {
    const backgroundTimer = setInterval(() => {
      const background = modelRuntime.get().background;
      if (!background?.enabled) return;
      const suspended = knowledge.listProjects().flatMap((project) => agentSessionStore.listProjectSessions(project.id).flatMap((session) => agentSessionStore.listSessionRuns(session.id).filter((run) => run.status === "suspended")));
      if (backgroundDecision({ ...background, spentUsd: 0 }, suspended.length, new Date()) !== "advance") return;
      const next = suspended[0];
      if (next) agentHarness.resume(next.id);
    }, 60_000);
    backgroundTimer.unref();
    app.addHook("onClose", async () => { clearInterval(backgroundTimer); });
  }
  app.addHook("onClose", async () => { await agentHarness.shutdown(); try { await mcpReady; } catch { /* initialization error is surfaced by settings and Agent routes */ } await mcpGateway.close(); try { await workflowProjectionReady; } finally { agentSessionStore.close(); } });
  app.addHook("onClose", async () => {
    try {
      await researchGraphReady;
      await researchGraph.checkpoint();
    } finally {
      await researchGraph.close();
      projectWorkflowRepository.close();
      scientificCanvasLayout.close();
      researchGraphProposals.close();
    }
  });
  registerWorkspaceRoutes(app, { knowledge, agentSessions: agentSessionStore, onChatSessionCreated: (session) => agentHarness.createSession({ id: session.id, projectId: session.projectId }), onChatSessionArchived: (session) => agentHarness.archiveSession(session.id), validateDomainIds: (ids) => scienceDomains.validate(ids), validateResearchContext: async (projectId, context) => projectResearchContext(projectId, context) });
  registerAgentCenterRoutes(app, { harness: agentHarness, store: agentSessionStore, ready: workflowProjectionReady, projectExists: (projectId) => Boolean(knowledge.getProject(projectId)), projectActive: (projectId) => { const project = knowledge.getProject(projectId); return Boolean(project && project.status !== "archived"); }, sessionExists: (sessionId, projectId) => knowledge.getChatSession(sessionId)?.projectId === projectId, sessionTitle: (sessionId) => knowledge.getChatSession(sessionId)?.title, listAgentRoles: () => [], acceptedInputModalities: async (override) => {
    if (override) return resolveModelCatalogEntry(override.providerId as ModelProviderId, override.modelId).inputModalities.filter((modality) => modality === "text" || modality === "image");
    const status = await modelStatus();
    if (!status.ready || !status.primary?.selectedModel) return ["text"];
    return status.primary.selectedModel.inputModalities.filter((modality) => modality === "text" || modality === "image");
  } });
  app.addHook("onClose", async () => { try { await projectWorkflowReady; } catch { /* initialization failure is already surfaced by routes */ } });
  const settleProjectWorkflow = async (workflow: NonNullable<ReturnType<typeof projectWorkflow.get>>) => {
    if (workflow.settledAt || workflow.status !== "completed" || !workflow.run || !workflow.review) return workflow;
    await researchGraphReconciler.reconcile();
    const settled = await projectWorkflow.markSettled(workflow.id);
    await researchGraphReconciler.reconcile();
    return settled;
  };

  registerConnectorRoutes(app, { root: workspaceRoot, mode: connectorMode, credentials, credentialsReady, probe: connectorProbe, workflow: connectorWorkflow, workflowReady: connectorReady, metadata: connectorMetadata, activeRuns: activeConnectorRuns });
  registerWorkflowRoutes(app, { workflow: projectWorkflow, ready: projectWorkflowReady, projects: knowledge, conversations: knowledge, settle: settleProjectWorkflow, executionTarget: () => { const execution = modelRuntime.get().execution; return { target: execution?.target ?? "vm", ...(execution?.sshHost ? { sshHost: execution.sshHost } : {}) }; } });
  registerResearchGraphRoutes(app, { graph: researchGraph, layout: scientificCanvasLayout, proposals: researchGraphProposals, ready: researchGraphReady, reconcile: () => researchGraphReconciler.reconcile(), projectExists: (projectId) => Boolean(knowledge.getProject(projectId)) });
  registerAttentionRoutes(app, { projectExists: (projectId) => Boolean(knowledge.getProject(projectId)), listWorkflows: (projectId) => projectWorkflow.list({ projectId }), listEvidence: (projectId) => knowledge.listEvidence(projectId), listProposals: (projectId) => researchGraphProposals.list(projectId), listAgentIssues: (projectId) => agentSessionStore.listProjectSessions(projectId).flatMap((session) => agentSessionStore.listSessionRuns(session.id)).filter((run) => run.status === "failed" || run.status === "suspended").map((run) => ({ id: run.id, status: run.status, ...(run.error ? { error: run.error } : {}), createdAt: run.startedAt })) });
  app.get("/api/projects/:projectId/overview", async (request, reply) => {
    const parsed = z.object({ projectId: z.string().min(1).max(120) }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid project overview request" });
    const project = knowledge.getProject(parsed.data.projectId);
    if (!project || project.status === "archived") return reply.code(404).send({ error: "Project not found" });
    await Promise.all([projectWorkflowReady, researchGraphReady]);
    await researchGraphReconciler.reconcile();
    return {
      project,
      items: knowledge.listItems(project.id),
      evidence: knowledge.listEvidence(project.id),
      researchGraph: await researchGraph.getProjection(project.id, "all"),
      workflows: projectWorkflow.list({ projectId: project.id }),
      generatedAt: new Date().toISOString(),
    };
  });

  app.get("/health", async () => ({
    status: "ok",
    service: "xiling-server",
    pi: PI_COMPATIBILITY_BASELINE.agentCore,
    runner: "docker-sandbox",
    sandbox: { engine: "docker", isolation: "least-privilege", networkDefault: "none" },
  }));

  app.post("/api/context/project", async (request, reply) => {
    const parsed = projectionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(validationFailure(parsed.error));
    if (!knowledge.getProject(parsed.data.projectId)) return reply.code(404).send({ error: "Project not found" });
    try {
      const { projection } = await projectResearchContext(parsed.data.projectId, { activeNodeId: parsed.data.activeNodeId, quotedNodeIds: parsed.data.quotedNodeIds, ...(parsed.data.capabilityQuery ? { capabilityQuery: parsed.data.capabilityQuery } : {}) });
      return projection;
    } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.get("/api/metrics/tokens", async (request, reply) => {
    const parsed = z.object({ limit: z.coerce.number().int().min(1).max(1000).default(100) }).safeParse(request.query);
    return parsed.success ? tokenLedger.list(parsed.data.limit) : reply.code(400).send(validationFailure(parsed.error));
  });

  app.get("/api/metrics/context", async () => {
    await skillCatalogReady;
    return {
      ...(await tokenLedger.summarize()),
      assemblyCache: contextAssemblyCache.stats(),
      skills: skillCatalog.list().map(({ name, description, version, capabilityIds }) => ({ name, description, version, capabilityIds })),
      capabilities: installedCapabilityCatalog.map(({ id, description, toolName, skillNames }) => ({ id, description, toolName, skillNames })),
      scienceDomains: scienceDomains.list().map(({ id, version }) => ({ id, version })),
    };
  });

  app.post("/api/system/stop", async (_request, reply) => {
    await reply.send({ status: "stopping" });
    setImmediate(() => void app.close());
  });

  return app;
}
