import { createHash } from "node:crypto";

export type AgentIsolation = "scoped" | "blind" | "execution";
export type DelegationMode = "single" | "parallel" | "chain";
export type DelegationStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "suspended";
export type ReviewProfile = "evidence" | "reproducibility" | "methods" | "adversarial";

export interface AgentRoleSpec {
  id: string;
  title: string;
  description: string;
  systemPrompt: string;
  allowedCapabilities: string[];
  includeDomainCapabilities?: boolean;
  defaultIsolation: AgentIsolation;
  canDelegate: false;
  dynamic?: boolean;
}

export interface ContextManifest {
  projectId: string;
  projectBriefRevision: string;
  researchEntityIds: string[];
  sourceUris: string[];
  projectionHash: string;
}

export interface AgentTaskBudget {
  maxDurationMs: number;
  maxToolCalls: number;
  maxCost?: number;
}

export interface AgentTaskRequest {
  roleId: string;
  objective: string;
  isolation?: AgentIsolation;
  dependsOn?: number[];
  reviewProfile?: ReviewProfile;
}

export interface AgentTaskResult {
  delegationId: string;
  roleId: string;
  status: "completed" | "failed" | "cancelled";
  summary: string;
  sourceUris: string[];
  artifactUris: string[];
  limitations: string[];
  childSessionId: string;
  childRunId?: string;
  usage?: { totalTokens: number; cost: number };
  error?: string;
}

export interface StoredDelegation {
  id: string;
  projectId: string;
  rootRunId: string;
  parentRunId: string;
  childSessionId: string;
  childRunId?: string;
  roleId: string;
  objective: string;
  isolation: AgentIsolation;
  contextManifestHash: string;
  contextManifest: unknown;
  budget: unknown;
  status: DelegationStatus;
  result?: unknown;
  error?: string;
  createdAt?: string;
}

export interface DelegationStore {
  getDelegation?(id: string): StoredDelegation | undefined;
  createDelegation(input: Omit<StoredDelegation, "createdAt" | "status"> & { status?: DelegationStatus }): StoredDelegation;
  updateDelegation(id: string, input: { status: DelegationStatus; childRunId?: string; result?: unknown; error?: string }): StoredDelegation;
}

export interface AgentTaskExecutor {
  createChildSession(projectId: string): string;
  execute(input: {
    delegationId: string;
    projectId: string;
    rootRunId: string;
    parentRunId: string;
    childSessionId: string;
    role: AgentRoleSpec;
    objective: string;
    isolation: AgentIsolation;
    contextManifest: ContextManifest;
    budget: AgentTaskBudget;
    signal?: AbortSignal;
    onRunStarted(runId: string): void;
  }): Promise<Omit<AgentTaskResult, "delegationId" | "roleId" | "childSessionId">>;
}

const commonContract = "只完成声明的子任务；区分事实、推断和未知；不得修改 Research Graph、Wiki 或项目状态。最终响应必须是一个 JSON 对象且只能包含 summary、sourceUris、artifactUris、limitations 四个字段；后三者必须是字符串数组，不得在 JSON 外输出文字。";

export interface ChildAccessPolicy {
  canReadEntity(entityId: string): boolean;
  canReadSource(uri: string): boolean;
  assertEntity(entityId: string): void;
  assertSource(uri: string): void;
}

export function createChildAccessPolicy(manifest: ContextManifest, isolation: AgentIsolation): ChildAccessPolicy {
  const entities = new Set(isolation === "scoped" ? manifest.researchEntityIds : []);
  const sources = new Set(manifest.sourceUris);
  return {
    canReadEntity: (entityId) => entities.has(entityId),
    canReadSource: (uri) => sources.has(uri),
    assertEntity(entityId) { if (!entities.has(entityId)) throw new Error("Child Agent entity access denied by ContextManifest"); },
    assertSource(uri) { if (!sources.has(uri)) throw new Error("Child Agent source access denied by ContextManifest"); },
  };
}

const reviewRubrics: Record<ReviewProfile, string> = {
  evidence: "证据审查清单：逐项核对来源定位、原文与解释边界、支持/反驳/限定关系、适用范围、置信度和证据缺口。",
  reproducibility: "复现审查清单：核对输入快照、代码版本、参数、随机种子、环境 digest、资源/网络策略、Artifact 哈希和重跑条件。",
  methods: "方法审查清单：核对研究设计、样本与偏差、单位和数据质量、统计假设、对照、敏感性分析及结论适用范围。",
  adversarial: "反方审查清单：寻找替代解释、选择偏差、混杂、统计误用、证据断裂、不可复现环节和过度推断。",
};

export function taskObjectiveWithProfile(task: AgentTaskRequest): string {
  if (task.reviewProfile && task.roleId !== "independent-reviewer") throw new Error("Review profiles are only valid for independent-reviewer");
  if (task.roleId !== "independent-reviewer") return task.objective;
  return `${task.objective}\n${reviewRubrics[task.reviewProfile ?? "adversarial"]}`;
}

export class AgentRoleRegistry {
  private readonly roles = new Map<string, AgentRoleSpec>();
  constructor(roles: readonly AgentRoleSpec[] = []) {
    for (const role of roles) this.register(role);
  }
  register(role: AgentRoleSpec): void {
    if (!/^[a-z0-9-]{2,64}$/.test(role.id)) throw new Error(`Invalid Agent role id: ${role.id}`);
    if (role.canDelegate !== false) throw new Error("Subagent role recursion is disabled");
    this.roles.set(role.id, structuredClone(role));
  }
  get(id: string): AgentRoleSpec | undefined { const role = this.roles.get(id); return role ? structuredClone(role) : undefined; }
  list(): AgentRoleSpec[] { return [...this.roles.values()].map((role) => structuredClone(role)); }
  createDynamic(input: { id: string; title: string; description: string; domainInstructions: string; allowedCapabilities: string[]; isolation?: AgentIsolation }): AgentRoleSpec {
    const role: AgentRoleSpec = {
      id: input.id, title: input.title, description: input.description,
      systemPrompt: `你是汐灵 OS 的一次性领域子智能体。领域任务约束：${input.domainInstructions}\n${commonContract}`,
      allowedCapabilities: [...new Set(input.allowedCapabilities)], defaultIsolation: input.isolation ?? "scoped", canDelegate: false, dynamic: true,
    };
    this.register(role);
    return role;
  }
}

export interface DelegationDecision {
  delegate: boolean;
  reasons: string[];
}

export function evaluateDelegationNeed(input: { independentTracks?: number; requiresBlindReview?: boolean; capabilityBoundaries?: number; contextPressure?: boolean; hasOutputContract?: boolean; unresolvedApproval?: boolean }): DelegationDecision {
  const reasons: string[] = [];
  if ((input.independentTracks ?? 0) >= 2) reasons.push("存在可并行的独立任务前沿");
  if (input.requiresBlindReview) reasons.push("需要独立盲审以降低锚定偏差");
  if ((input.capabilityBoundaries ?? 0) >= 2) reasons.push("任务跨越不同工具或权限边界");
  if (input.contextPressure) reasons.push("主上下文可拆为有界 TaskPacket");
  if (input.unresolvedApproval) return { delegate: false, reasons: ["存在尚未解决的用户审批"] };
  if (input.hasOutputContract === false) return { delegate: false, reasons: ["缺少可验收的结构化输出契约"] };
  return { delegate: reasons.length > 0, reasons };
}

export class MultiAgentOrchestrator {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(
    private readonly store: DelegationStore,
    private readonly executor: AgentTaskExecutor,
    readonly roles = new AgentRoleRegistry(),
    private readonly options: { maxConcurrency?: number; maxTasksPerDelegation?: number; defaultBudget?: AgentTaskBudget } = {},
  ) {}

  async delegate(input: { projectId: string; rootRunId?: string; parentRunId: string; mode: DelegationMode; tasks: AgentTaskRequest[]; contextManifest: ContextManifest; budget?: Partial<AgentTaskBudget>; signal?: AbortSignal }): Promise<AgentTaskResult[]> {
    const maxTasks = this.options.maxTasksPerDelegation ?? 6;
    if (!input.tasks.length || input.tasks.length > maxTasks) throw new Error(`Delegation requires 1-${maxTasks} tasks`);
    if (input.mode === "single" && input.tasks.length !== 1) throw new Error("Single delegation accepts exactly one task");
    if (input.mode === "chain" && input.tasks.some((task, index) => index > 0 && !(task.dependsOn?.length))) throw new Error("Chain tasks after the first require dependsOn");
    // dependsOn forms a DAG over task indices: strictly earlier references keep
    // it acyclic by construction, and every declared edge is actually honoured.
    for (const [index, task] of input.tasks.entries()) {
      for (const dependency of task.dependsOn ?? []) {
        if (!Number.isInteger(dependency) || dependency < 0 || dependency >= index) throw new Error(`Task ${index} dependsOn must reference an earlier task`);
      }
    }
    const maxCost = input.budget?.maxCost ?? this.options.defaultBudget?.maxCost;
    const budget: AgentTaskBudget = {
      maxDurationMs: input.budget?.maxDurationMs ?? this.options.defaultBudget?.maxDurationMs ?? 180_000,
      maxToolCalls: input.budget?.maxToolCalls ?? this.options.defaultBudget?.maxToolCalls ?? 12,
      ...(maxCost !== undefined ? { maxCost } : {}),
    };
    const tasks = input.tasks;
    const transitiveDependencies = (index: number): number[] => {
      const seen = new Set<number>();
      const stack = [...(tasks[index]!.dependsOn ?? [])];
      while (stack.length) {
        const dependency = stack.pop()!;
        if (seen.has(dependency)) continue;
        seen.add(dependency);
        stack.push(...(tasks[dependency]!.dependsOn ?? []));
      }
      return [...seen].sort((a, b) => a - b);
    };
    const results: Array<AgentTaskResult | undefined> = new Array(tasks.length);
    const summaries: string[] = new Array(tasks.length).fill("");
    const runTask = async (index: number) => {
      const task = tasks[index]!;
      const dependencies = transitiveDependencies(index).filter((dependency) => summaries[dependency]);
      const objective = dependencies.length ? `${task.objective}\n前序结构化摘要：\n${dependencies.map((dependency) => summaries[dependency]).join("\n")}` : task.objective;
      const result = await this.runOne({ ...input, rootRunId: input.rootRunId ?? input.parentRunId, task: { ...task, objective }, index, budget });
      results[index] = result;
      summaries[index] = result.status === "completed" ? result.summary : "";
    };
    // Level-by-level DAG execution: every task whose dependencies have all
    // completed runs as soon as a concurrency slot frees up.
    const pending = new Set(tasks.map((_, index) => index));
    while (pending.size) {
      const runnable = [...pending].filter((index) => (tasks[index]!.dependsOn ?? []).every((dependency) => results[dependency]?.status === "completed"));
      if (!runnable.length) {
        for (const index of pending) {
          const role = this.roles.get(tasks[index]!.roleId);
          results[index] = { delegationId: "", roleId: tasks[index]!.roleId, childSessionId: "", status: "failed", summary: "", sourceUris: [], artifactUris: [], limitations: [], error: "upstream dependency did not complete; task skipped" };
          void role;
        }
        break;
      }
      await Promise.all(runnable.map((index) => { pending.delete(index); return runTask(index); }));
    }
    return results.map((result) => result!);
  }

  private async runOne(input: { projectId: string; rootRunId: string; parentRunId: string; task: AgentTaskRequest; index: number; contextManifest: ContextManifest; budget: AgentTaskBudget; signal?: AbortSignal }): Promise<AgentTaskResult> {
    const role = this.roles.get(input.task.roleId);
    if (!role) throw new Error(`Unknown Agent role: ${input.task.roleId}`);
    const isolation = input.task.isolation ?? role.defaultIsolation;
    const objective = taskObjectiveWithProfile(input.task);
    const manifestHash = createHash("sha256").update(JSON.stringify(input.contextManifest)).digest("hex");
    const delegationId = createHash("sha256").update(JSON.stringify([input.parentRunId, input.index, role.id, objective, isolation, manifestHash])).digest("hex").slice(0, 40);
    const existing = this.store.getDelegation?.(delegationId);
    if (existing?.status === "completed" && existing.result) return structuredClone(existing.result as AgentTaskResult);
    const childSessionId = existing?.childSessionId ?? this.executor.createChildSession(input.projectId);
    if (!existing) this.store.createDelegation({ id: delegationId, projectId: input.projectId, rootRunId: input.rootRunId, parentRunId: input.parentRunId, childSessionId, roleId: role.id, objective, isolation, contextManifestHash: manifestHash, contextManifest: input.contextManifest, budget: input.budget });
    else this.store.updateDelegation(delegationId, { status: "queued" });
    let childRunId: string | undefined;
    let acquired = false;
    const taskController = new AbortController();
    const cancelFromParent = () => taskController.abort(input.signal?.reason ?? "parent cancelled");
    input.signal?.addEventListener("abort", cancelFromParent, { once: true });
    const timeout = setTimeout(() => taskController.abort("delegation duration budget exceeded"), input.budget.maxDurationMs);
    try {
      await this.acquire(taskController.signal);
      acquired = true;
      const execution = await this.executor.execute({ delegationId, projectId: input.projectId, rootRunId: input.rootRunId, parentRunId: input.parentRunId, childSessionId, role, objective, isolation, contextManifest: input.contextManifest, budget: input.budget, signal: taskController.signal, onRunStarted: (runId) => { childRunId = runId; this.store.updateDelegation(delegationId, { status: "running", childRunId: runId }); } });
      if (input.budget.maxCost !== undefined && (execution.usage?.cost ?? 0) > input.budget.maxCost) throw new Error("Delegation cost budget exceeded");
      const result: AgentTaskResult = { delegationId, roleId: role.id, childSessionId, ...(childRunId ? { childRunId } : {}), ...execution };
      this.store.updateDelegation(delegationId, { status: result.status, ...(childRunId ? { childRunId } : {}), result, ...(result.error ? { error: result.error } : {}) });
      return result;
    } catch (error) {
      const cancelled = taskController.signal.aborted;
      const message = error instanceof Error ? error.message : String(error);
      const result: AgentTaskResult = { delegationId, roleId: role.id, childSessionId, ...(childRunId ? { childRunId } : {}), status: cancelled ? "cancelled" : "failed", summary: "", sourceUris: [], artifactUris: [], limitations: [], error: message };
      this.store.updateDelegation(delegationId, { status: result.status, ...(childRunId ? { childRunId } : {}), result, error: message });
      return result;
    } finally { clearTimeout(timeout); input.signal?.removeEventListener("abort", cancelFromParent); if (acquired) this.release(); }
  }

  private async acquire(signal?: AbortSignal): Promise<void> {
    const limit = Math.max(1, this.options.maxConcurrency ?? 3);
    while (true) {
      if (signal?.aborted) throw new Error("Delegation cancelled");
      if (this.active < limit) { this.active += 1; return; }
      await new Promise<void>((resolve, reject) => {
        const next = () => { signal?.removeEventListener("abort", onAbort); resolve(); };
        const onAbort = () => { const index = this.waiters.indexOf(next); if (index >= 0) this.waiters.splice(index, 1); reject(new Error("Delegation cancelled")); };
        signal?.addEventListener("abort", onAbort, { once: true });
        this.waiters.push(next);
      });
      // Woken by a release(): re-check abort before claiming the handed-over
      // slot, and pass the wakeup on to the next waiter when aborting so the
      // freed slot is never lost.
      if (signal?.aborted) { this.waiters.shift()?.(); throw new Error("Delegation cancelled"); }
    }
  }
  private release(): void { if (this.active > 0) this.active -= 1; this.waiters.shift()?.(); }
}

export function extractTaskResultText(text: string): Pick<AgentTaskResult, "summary" | "sourceUris" | "artifactUris" | "limitations"> {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Subagent handoff must be valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Subagent handoff must be a JSON object");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "artifactUris,limitations,sourceUris,summary") throw new Error("Subagent handoff has an invalid schema");
  const stringArray = (name: string, limit: number) => {
    const items = record[name];
    if (!Array.isArray(items) || items.length > limit || !items.every((item) => typeof item === "string" && item.length <= 2_000)) throw new Error(`Subagent handoff ${name} is invalid`);
    return [...new Set(items as string[])];
  };
  if (typeof record.summary !== "string" || !record.summary.trim() || record.summary.length > 12_000) throw new Error("Subagent handoff summary is invalid");
  const sourceUris = stringArray("sourceUris", 32);
  const artifactUris = stringArray("artifactUris", 32);
  if (artifactUris.some((uri) => !uri.startsWith("artifact://"))) throw new Error("Subagent handoff contains an invalid Artifact URI");
  return { summary: record.summary.trim(), sourceUris, artifactUris, limitations: stringArray("limitations", 16) };
}
