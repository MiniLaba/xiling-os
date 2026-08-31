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
import { LazySkillCatalog, PiMcpGatewayManager, PiRuntimeAdapter, ModelRuntimeStore, TokenLedger, createLiveRoute, createOfflineRoute, resolveModelCatalogEntry } from "@xiling/pi-runtime";
import { DockerProjectAnalysisRunner, LocalWorkflowArtifactRegistrar } from "./research-runner.js";
import { ConnectorWorkflowService, FixtureConnectorAdapter, JsonConnectorJobRepository, type ConnectorDownloader, type ConnectorMetadataProbe } from "@xiling/connectors";
import { FileLiteratureCache, LiteratureSearchService, OpenAlexProvider, SemanticScholarProvider } from "@xiling/literature";
import { KnowledgeService } from "@xiling/knowledge";
import { LadybugResearchGraphStore } from "@xiling/research-graph";
import { AgentRoleRegistry, MultiAgentOrchestrator, createChildAccessPolicy, extractTaskResultText, type AgentTaskRequest, type DelegationMode } from "@xiling/multi-agent";
import { CredentialStore } from "@xiling/credentials";
import { LocalArtifactStore, type ArtifactRegistry } from "@xiling/artifacts";
import { ExecutionCoordinator, SqliteExecutionRepository } from "@xiling/execution";
import { DockerConnectorProbe, DockerConnectorRunner } from "./connector-runner.js";
import { agentEntryReaderTool, agentHistorySearchTool, createResearchTools, researchCapabilityCatalog, researchCapabilityCatalogFor, researchDelegationTool, roleAllowsCapability, selectDelegationRoles, selectResearchCapabilities, selectResearchTools, shouldOfferResearchDelegation } from "./agent-tools.js";
import { FixtureProjectAnalysisRunner, ProjectWorkflowService, SqliteProjectWorkflowRepository, type ProjectAnalysisRunner } from "./project-workflow.js";
import { registerLiteratureRoutes } from "./modules/literature/routes.js";
import { registerWorkspaceRoutes } from "./modules/workspace/routes.js";
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
import { selectModelRoute } from "./model-route-selection.js";

export function createApp(options: { dataRoot?: string; webRoot?: string; literatureFetch?: typeof fetch; literatureSleep?: (ms: number, signal?: AbortSignal) => Promise<void>; connectorProbe?: ConnectorMetadataProbe; connectorDownloader?: ConnectorDownloader; connectorMode?: "fixture" | "live"; projectAnalysisRunner?: ProjectAnalysisRunner; artifactStore?: ArtifactRegistry; fixtureModel?: boolean; additionalProjects?: Array<{ id: string; name: string; description: string; researchQuestion: string; domainIds: string[] }> } = {}) {
  const app = Fastify({ logger: false });
  void app.register(cors, { origin: /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/ });
  const webRoot = options.webRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  void app.register(fastifyStatic, { root: webRoot, wildcard: false });
  const defaultDataRoot = process.env.VITEST || process.env.NODE_ENV === "test"
    ? resolve(tmpdir(), `xiling-app-test-${randomUUID()}`)
    : process.platform === "win32" && process.env.LOCALAPPDATA
      ? resolve(process.env.LOCALAPPDATA, "XiLingOS")
      : resolve(dirname(fileURLToPath(import.meta.url)), "../../../data");
  const dataRoot = options.dataRoot ?? process.env.XILING_DATA_ROOT ?? defaultDataRoot;
  const workspaceRoot = resolve(dataRoot, "workspace");
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
  const skillCatalog = new LazySkillCatalog(resolve(dirname(fileURLToPath(import.meta.url)), "../../../skills"));
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
    for (const nodeId of selectedIds) {
      const node = graph.nodes.find((candidate) => candidate.id === nodeId);
      if (!node) continue;
      const resolved = await sourceContentResolver.resolve(projectId, node);
      resolvedNodes.set(node.id, resolved);
      const artifactUris = (node.uri && /^(artifact|dataset|project):\/\//.test(node.uri) ? [node.uri as ResourceUri] : []) as ContextCapsule["artifactUris"];
      const candidate = createNodeContextCapsule({ projectId, nodeId: node.id, title: node.title, body: resolved.body, artifactUris, updatedAt: node.updatedAt });
      const existing = capsuleMap.get(candidate.id);
      capsuleMap.set(node.id, existing?.sourceRevision === candidate.sourceRevision ? existing : knowledge.upsertContextCapsule(projectId, candidate));
    }
    projection = projectResearchGraphContext(projectionRequest, graph, capsuleMap, projectCapabilityCatalog);
    return { graph, projection, resolvedNodes };
  };
  const agentRoles = new AgentRoleRegistry(scienceDomains.list().flatMap((domain) => domain.agentRoles));
  let multiAgentOrchestrator: MultiAgentOrchestrator;
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
      const domainCapabilityIds = new Set(activeDomain.capabilities.map((capability) => capability.id));
      const allowedRoleIds = new Set(activeDomain.agentRoles.map((role) => role.id));
      const childRole = command.multiAgent && allowedRoleIds.has(command.multiAgent.roleId) ? agentRoles.get(command.multiAgent.roleId) : undefined;
      if (command.multiAgent && !childRole) throw new Error("Unknown delegated Agent role");
      if (command.multiAgent && command.multiAgent.contextManifest.projectId !== activeProject.id) throw new Error("Delegated ContextManifest project mismatch");
      const childAccess = command.multiAgent ? createChildAccessPolicy(command.multiAgent.contextManifest, command.multiAgent.isolation) : undefined;
      const activeCapabilities = childRole
        ? activeCapabilityCatalog.filter((capability) => roleAllowsCapability(childRole, capability.id, domainCapabilityIds) && !(command.multiAgent?.isolation !== "scoped" && ["project.read", "wiki.read"].includes(capability.id)))
        : selectResearchCapabilities(prompt, activeCapabilityCatalog);
      const scopedArtifactReader = (uri: string, offset: number, max: number) => { childAccess?.assertSource(uri); return readManagedArtifact(activeProject.id, uri, offset, max); };
      let activeTools = childRole
        ? createResearchTools(activeCapabilities, { project: activeProject, knowledge, literature, readArtifact: scopedArtifactReader })
        : selectResearchTools(prompt, { project: activeProject, knowledge, literature, readArtifact: (uri, offset, max) => readManagedArtifact(activeProject.id, uri, offset, max) }, activeCapabilityCatalog);
      await skillCatalogReady;
      const activatedSkills = await skillCatalog.activate(prompt, activeCapabilities.map((capability) => capability.id));
      await mcpReady;
      if (!childRole && mcpGateway.matches(prompt)) activeTools = [...activeTools, mcpGateway.tool()];
      const persistedContext = knowledge.getChatSessionContext(sessionId);
      const defaultContext = { activeNodeId: `research-question:${activeProject.id}`, quotedNodeIds: [] };
      const requestedContext = command.context ?? (persistedContext ? { activeNodeId: persistedContext.activeNodeId, quotedNodeIds: persistedContext.quotedNodeIds } : defaultContext);
      let resolvedContext = requestedContext;
      let researchProjection: Awaited<ReturnType<typeof projectResearchContext>>;
      if (command.multiAgent?.isolation === "blind" || command.multiAgent?.isolation === "execution") {
        const sourceUris = command.multiAgent.contextManifest.sourceUris.filter((uri): uri is ResourceUri => /^(artifact|dataset|project):\/\//.test(uri));
        researchProjection = {
          graph: await (async () => { await researchGraphReady; return researchGraph.getProjection(activeProject.id, "all"); })(),
          projection: { activeBranchNodeIds: [], quotedNodeIds: [], capsules: [], artifactUris: sourceUris, activatedCapabilities: activeCapabilities.map((capability) => capability.id), explanation: [`${command.multiAgent.isolation} 子智能体仅接收 ContextManifest 声明来源`], projectionHash: command.multiAgent.contextManifest.projectionHash, economy: { uniqueArtifactCount: new Set(sourceUris).size, reusedArtifactReferences: 0, selectedNodeCount: 0 } },
          resolvedNodes: new Map(),
        };
        resolvedContext = { activeNodeId: "isolated-task-packet", quotedNodeIds: [] };
      } else try { researchProjection = await projectResearchContext(activeProject.id, { ...requestedContext, activatedCapabilityIds: activeCapabilities.map((capability) => capability.id) }); }
      catch {
        resolvedContext = defaultContext;
        researchProjection = await projectResearchContext(activeProject.id, { ...resolvedContext, activatedCapabilityIds: activeCapabilities.map((capability) => capability.id) });
      }
      if (knowledge.getChatSession(sessionId)) knowledge.setChatSessionContext(sessionId, { projectId: activeProject.id, ...resolvedContext });
      const routeStatus = await modelStatus();
      const primaryRoute = routeStatus.primary;
      const turnOverride: ModelRouteSettings | undefined = !childRole && command.modelRoute
        ? { ...command.modelRoute, reasoning: primaryRoute?.reasoning ?? "medium", inputModalities: resolveModelCatalogEntry(command.modelRoute.providerId, command.modelRoute.modelId).inputModalities.filter((item): item is "text" | "image" => item === "text" || item === "image") }
        : undefined;
      const requestedRoute = selectModelRoute(routeStatus, { ...(childRole ? { roleId: childRole.id } : {}), ...(turnOverride ? { turnOverride } : {}) }).route;
      const useFixtureModel = options.fixtureModel ?? Boolean(process.env.VITEST || process.env.NODE_ENV === "test");
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
        "任何下载、计算、外部写入或结论沉淀都必须停在计划/建议阶段，等待用户确认。",
        "当你需要用户确认或做出选择时，必须在回复的最末尾追加一个选项块供界面渲染成可点击按钮：```xiling-choices 换行 [\"选项一\", \"选项二\"] 换行 ```；给 2 到 4 个选项，每个不超过 16 字、可直接作为用户回复发送；若你已在正文中列出带编号的确认事项，选项应与之对应（如「按默认方案推进」「1 改为…」）；没有需要确认的事项时不要输出该块。",
        "引用工具结果时说明数据源；缺少证据时明确说明。",
        ...(childRole ? [childRole.systemPrompt, "你是隔离的子智能体，不能创建其他子智能体。只返回当前 TaskPacket 的结果，不延伸为项目最终结论。"] : ["当任务存在可独立验收的并行前沿、竞争假说或盲审价值时，可使用 delegate_research_tasks；简单任务和需要单一连续推理的任务不要委派。"]),
      ].join("\n");
      const projectPrompt = command.multiAgent?.isolation === "blind" || command.multiAgent?.isolation === "execution"
        ? `隔离 TaskPacket：不得获知项目标题、研究问题、父会话、兄弟输出或未声明实体。声明来源：${command.multiAgent.contextManifest.sourceUris.join(", ") || "无"}`
        : `当前项目：${activeProject.name}\n研究问题：${activeProject.researchQuestion}\n当前科研图活动实体：${resolvedContext.activeNodeId}\n当前科研图显式引用：${resolvedContext.quotedNodeIds.join(", ") || "无"}`;
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
      if (!childRole && shouldOfferResearchDelegation(prompt)) {
        const delegationRoles = selectDelegationRoles(prompt, activeDomain.agentRoles);
        activeTools = [...activeTools, researchDelegationTool({
          roles: delegationRoles,
          delegate: async (mode: DelegationMode, tasks: AgentTaskRequest[], signal?: AbortSignal) => multiAgentOrchestrator.delegate({
            projectId: activeProject.id,
            parentRunId: runId,
            mode,
            tasks,
            contextManifest: {
              projectId: activeProject.id,
              projectBriefRevision: `${activeProject.id}:${activeProject.updatedAt}`,
              researchEntityIds: [...new Set([resolvedContext.activeNodeId, ...resolvedContext.quotedNodeIds])],
              sourceUris: researchProjection.projection.artifactUris,
              projectionHash,
            },
            ...(signal ? { signal } : {}),
          }),
        })];
      }
      if (command.multiAgent) {
        let toolCalls = 0;
        activeTools = activeTools.map((tool) => ({ ...tool, execute: async (...args: Parameters<typeof tool.execute>) => {
          toolCalls += 1;
          if (toolCalls > command.multiAgent!.budget.maxToolCalls) throw new Error("Child Agent tool-call budget exceeded");
          return tool.execute(...args);
        } }));
      }
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
  });
  multiAgentOrchestrator = new MultiAgentOrchestrator(agentSessionStore, {
    createChildSession(projectId) { return agentHarness.createSession({ projectId }).id; },
    async execute(input) {
      // Blind review receives declared sources, but not the Director's selected
      // claim/conclusion nodes or conversation. This keeps the review useful
      // without preserving the anchoring signal that isolation is meant to remove.
      const visibleEntityIds = input.isolation === "blind" ? [] : input.contextManifest.researchEntityIds;
      const activeNodeId = visibleEntityIds[0] ?? `research-question:${input.projectId}`;
      const quotedNodeIds = visibleEntityIds.slice(1, 12);
      const declaredSources = input.contextManifest.sourceUris.slice(0, 12);
      const taskPrompt = [
        `子任务角色：${input.role.title}`,
        `任务目标：${input.objective}`,
        `隔离级别：${input.isolation}`,
        `允许读取的科研实体：${visibleEntityIds.join("、") || "仅项目研究问题"}`,
        `声明来源 URI：${declaredSources.join("、") || "无"}`,
        "输出要求：给出精简结论、来源 URI、Artifact URI（如有）以及局限；不要给项目作最终决策。",
      ].join("\n");
      const started = agentHarness.startTurn({
        sessionId: input.childSessionId,
        prompt: taskPrompt,
        clientCommandId: `delegation:${input.delegationId}`,
        context: {
          projectId: input.projectId,
          context: { activeNodeId, quotedNodeIds },
          multiAgent: {
            delegationId: input.delegationId,
            rootRunId: input.rootRunId,
            parentRunId: input.parentRunId,
            roleId: input.role.id,
            isolation: input.isolation,
            contextManifest: input.contextManifest,
            budget: input.budget,
          },
        },
      });
      input.onRunStarted(started.run.id);
      const cancel = () => agentHarness.cancel(started.run.id);
      input.signal?.addEventListener("abort", cancel, { once: true });
      try {
        for await (const _event of agentHarness.subscribe(started.run.id, 0)) { /* durable completion barrier */ }
      } finally { input.signal?.removeEventListener("abort", cancel); }
      const snapshot = agentHarness.snapshot(started.run.id);
      const text = [...snapshot.entries].reverse().find((entry) => entry.kind === "assistant")?.text ?? "";
      if (snapshot.run.status === "failed") throw new Error(snapshot.run.error ?? "Delegated Agent failed");
      const parsed = extractTaskResultText(text);
      const access = createChildAccessPolicy(input.contextManifest, input.isolation);
      for (const uri of [...parsed.sourceUris, ...parsed.artifactUris]) if (/^(artifact|dataset|project):\/\//.test(uri)) access.assertSource(uri);
      return {
        status: snapshot.run.status === "cancelled" ? "cancelled" : "completed",
        ...parsed,
        usage: { totalTokens: snapshot.usageTotals.totalTokens, cost: snapshot.usageTotals.cost },
        ...(snapshot.run.error ? { error: snapshot.run.error } : {}),
      };
    },
  }, agentRoles, { maxConcurrency: 3, maxTasksPerDelegation: 6, defaultBudget: { maxDurationMs: 180_000, maxToolCalls: 12, maxCost: 2 } });
  const workflowProjectionReady = reconcileAgentWorkflowDrafts({ store: agentSessionStore, ready: projectWorkflowReady, workflows: projectWorkflow });
  const researchGraphReconciler = new ResearchGraphReconciler(researchGraph, knowledge, projectWorkflowRepository, agentSessionStore);
  const researchGraphReady = Promise.all([workflowProjectionReady, projectWorkflowReady]).then(() => researchGraphReconciler.reconcile());
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
  registerAgentCenterRoutes(app, { harness: agentHarness, store: agentSessionStore, ready: workflowProjectionReady, projectExists: (projectId) => Boolean(knowledge.getProject(projectId)), projectActive: (projectId) => { const project = knowledge.getProject(projectId); return Boolean(project && project.status !== "archived"); }, sessionExists: (sessionId, projectId) => knowledge.getChatSession(sessionId)?.projectId === projectId, sessionTitle: (sessionId) => knowledge.getChatSession(sessionId)?.title, listAgentRoles: () => agentRoles.list().map(({ systemPrompt: _systemPrompt, canDelegate: _canDelegate, ...role }) => role), acceptedInputModalities: async (override) => {
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
  registerWorkflowRoutes(app, { workflow: projectWorkflow, ready: projectWorkflowReady, projects: knowledge, conversations: knowledge, settle: settleProjectWorkflow });
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
    pi: "0.84.2",
    runner: "docker-sandbox",
    sandbox: { engine: "docker", isolation: "least-privilege", networkDefault: "none" },
  }));

  app.post("/api/context/project", async (request, reply) => {
    const parsed = projectionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
    if (!knowledge.getProject(parsed.data.projectId)) return reply.code(404).send({ error: "Project not found" });
    try {
      const { projection } = await projectResearchContext(parsed.data.projectId, { activeNodeId: parsed.data.activeNodeId, quotedNodeIds: parsed.data.quotedNodeIds, ...(parsed.data.capabilityQuery ? { capabilityQuery: parsed.data.capabilityQuery } : {}) });
      return projection;
    } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.get("/api/metrics/tokens", async (request, reply) => {
    const parsed = z.object({ limit: z.coerce.number().int().min(1).max(1000).default(100) }).safeParse(request.query);
    return parsed.success ? tokenLedger.list(parsed.data.limit) : reply.code(400).send({ error: parsed.error.issues });
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
