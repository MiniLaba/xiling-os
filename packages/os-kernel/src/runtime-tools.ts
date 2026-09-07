import { OsError, type UIAction } from "@xiling/os-domain";
import type { RunRequest, RuntimeToolDescriptor } from "@xiling/os-runtime";
import type { OSKernel } from "./kernel.js";

export const OS_TOOL: RuntimeToolDescriptor = {
  name: "xiling_os",
  description: 'OS operations, input JSON: {op:"artifact.create",name,content,type?:"report"|"plan"|"generic",sourceArtifactId?:string}; {op:"artifact.read",artifactId,offset?:number}; {op:"apps.list"}; {op:"apps.invoke",appId,goal,inputArtifactIds?:string[]}; {op:"ui.ask",question}. Create a real Markdown artifact when asked for a deliverable. sourceArtifactId creates an immutable lineage edge and must be an explicitly accessible artifact. Reads only task inputs/outputs and child outputs. Apps are isolated persistent agents: delegate only a bounded task, then end your turn to let the child run; after resume read returned artifacts rather than delegating again. ui.ask presents a trusted form, then end your turn and wait. No shell, arbitrary filesystem, or network tools.',
  inputSchema: { type: "object", properties: { input: { type: "string" } }, required: ["input"] },
};

/** Task-scoped capability gateway for shipped, non-executable OS operations. */
export function taskTools(kernel: OSKernel, request: Pick<RunRequest, "agentId" | "taskId" | "runId">) {
  const pending = new Map<string, Promise<unknown>>();
  const fingerprints = new Map<string, string>();
  return async (name: string, raw: unknown, callId: string): Promise<unknown> => {
    if (name !== OS_TOOL.name) throw new OsError("permission_denied", "工具没有已安装的执行器");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Expected operation object");
    const input = raw as Record<string, unknown>;
    const fingerprint = JSON.stringify(input);
    const key = `${request.taskId}:${request.runId}:${callId}`;
    const prior = kernel.events.all().find((event) => event.type === "tool.executed" && event.payload.idempotencyKey === key);
    if (prior?.type === "tool.executed") {
      const saved = prior.payload.output as { fingerprint: string; result: unknown };
      if (saved.fingerprint !== fingerprint) throw new Error("Tool call identity reused with different input");
      return saved.result;
    }
    if (pending.has(key)) {
      if (fingerprints.get(key) !== fingerprint) throw new Error("Tool call identity reused with different input");
      return pending.get(key)!;
    }
    const work = (async () => {
      const task = kernel.tasks.get(request.taskId);
      const started = [...kernel.events.all()].reverse().find((event) => event.type === "task.started" && event.payload.taskId === task.id);
      if (task.assignedAgentId !== request.agentId || task.state !== "running" || started?.type !== "task.started" || started.payload.runId !== request.runId) throw new OsError("permission_denied", "Task is not actively owned by this run");
      const agent = kernel.agents.get(request.agentId);
      const ctx = { actor: "agent" as const, actorAgentId: request.agentId, taskId: task.id, runId: request.runId };
      const policy = (action: string) => {
        if (!agent.permissionPolicy.allowedActions.includes(action) && !(agent.isMainAgent && action.startsWith("artifact.") && agent.permissionPolicy.allowedActions.includes("agent.message"))) throw new OsError("permission_denied", `App 未获准 ${action}`);
      };
      const accessible = new Set([...task.inputArtifacts, ...task.outputArtifacts,
        ...task.dependsOnTaskIds.flatMap((id) => kernel.tasks.get(id).outputArtifacts)].map((ref) => ref.artifactId));
      const text = (key: string, max: number) => {
        const value = input[key];
        if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`Invalid ${key}`);
        return value;
      };
      let result: unknown;
      switch (input.op) {
        case "artifact.create": {
          policy("artifact.create");
          const type = input.type ?? "generic";
          if (type !== "generic" && type !== "report" && type !== "plan") throw new Error("Unsupported artifact type");
          const name = text("name", 160);
          const content = text("content", 200_000);
          const sourceArtifactId = input.sourceArtifactId === undefined ? undefined : text("sourceArtifactId", 200);
          if (sourceArtifactId !== undefined && !accessible.has(sourceArtifactId)) throw new OsError("permission_denied", "sourceArtifactId 不在显式任务上下文中");
          const metadata = { creationMode: "agent-tool", sourceRunId: request.runId, toolCallId: callId };
          const artifact = sourceArtifactId === undefined
            ? await kernel.artifacts.create({ name, content, type, mimeType: "text/markdown", creatorAgentId: request.agentId, taskId: task.id, metadata, ctx })
            : await kernel.artifacts.derive(sourceArtifactId, { name, content, type, mimeType: "text/markdown", creatorAgentId: request.agentId, taskId: task.id, metadata }, ctx);
          result = { artifactId: artifact.artifactId, version: artifact.version, name: artifact.name }; break;
        }
        case "artifact.read": {
          policy("artifact.read");
          const id = text("artifactId", 200);
          if (!accessible.has(id)) throw new OsError("permission_denied", "Artifact 不在显式任务上下文中");
          const offset = input.offset ?? 0;
          if (!Number.isSafeInteger(offset) || (offset as number) < 0) throw new Error("Invalid offset");
          const content = kernel.artifacts.contentOf(id);
          result = { artifactId: id, content: content.slice(offset as number, (offset as number) + 8000), nextOffset: (offset as number) + 8000 < content.length ? (offset as number) + 8000 : null }; break;
        }
        case "apps.list":
          result = kernel.apps.list().filter((app) => app.state === "enabled" && app.agentId !== request.agentId).map((app) => ({ appId: app.id, name: app.package.name, description: app.package.description, capabilities: app.package.capabilities })); break;
        case "ui.ask": {
          policy("ui.present");
          const question = text("question", 2000);
          const surface = await kernel.ui.present({ agentId: request.agentId, taskId: task.id, kind: "form", title: "需要你的补充", data: { fields: [{ id: "answer", label: question, type: "textarea" }] },
            actions: [{ id: "answer", label: "提交并继续", command: "task.submit_input", inputSchema: { type: "object", properties: { answer: { type: "string", maxLength: 12000 } }, required: ["answer"], additionalProperties: false } }], ctx });
          kernel.tasks.transition(task.id, { type: "task.waiting_input", payload: { taskId: task.id, reason: question } }, ctx);
          result = { surfaceId: surface.id, state: "waiting_input", instruction: "End this turn. The user will answer in the form." }; break;
        }
        case "ui.present": {
          policy("ui.present");
          const kind = input.kind;
          if (kind !== "form" && kind !== "table" && kind !== "chart" && kind !== "comparison" && kind !== "task_board" && kind !== "diff") throw new Error("Unsupported UI kind");
          const title = text("title", 160);
          if (!input.data || typeof input.data !== "object" || JSON.stringify(input.data).length > 24000) throw new Error("Invalid or oversized UI data");
          const actions: UIAction[] = [];
          if (kind === "form") {
            const fields = (input.data as { fields?: unknown }).fields;
            if (!Array.isArray(fields) || !fields.length || fields.length > 12) throw new Error("Expected 1–12 form fields");
            const properties: Record<string, unknown> = Object.create(null);
            for (const field of fields) {
              if (!field || typeof field.id !== "string" || !/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(field.id) || Object.hasOwn(properties, field.id)) throw new Error("Invalid/duplicate field id");
              properties[field.id] = field.type === "number" ? { type: "number" } : field.type === "checkbox" ? { type: "boolean" } : { type: "string", maxLength: 12000, ...(field.type === "select" ? { enum: field.options } : {}) };
            }
            actions.push({ id: "submit", label: "确认并继续", command: "task.submit_input", inputSchema: { type: "object", properties, required: fields.map((field) => field.id), additionalProperties: false } });
          }
          // Agent chooses data, never commands/HTML/code. The host owns the action contract.
          const surface = await kernel.ui.present({ agentId: request.agentId, taskId: task.id, kind, title, data: input.data, actions, ctx });
          if (kind === "form") kernel.tasks.transition(task.id, { type: "task.waiting_input", payload: { taskId: task.id, reason: title } }, ctx);
          result = { surfaceId: surface.id, instruction: kind === "form" ? "End this turn and wait for user input." : "Displayed in the task interface. Continue or finish the task; do not repeat the same UI." }; break;
        }
        case "apps.invoke": {
          policy("task.delegate");
          const ids = input.inputArtifactIds ?? [];
          if (!Array.isArray(ids) || ids.length > 20 || ids.some((id) => typeof id !== "string" || !accessible.has(id))) throw new OsError("permission_denied", "只能传递显式任务产物");
          result = await kernel.apps.invoke(text("appId", 200), { fromAgentId: request.agentId, parentTaskId: task.id, goal: text("goal", 12000), inputArtifactIds: ids }, ctx); break;
        }
        default: throw new Error("Unknown OS operation");
      }
      kernel.emit("tool.executed", { taskId: task.id, toolCallId: callId, name, idempotencyKey: key, output: { fingerprint, result } }, { taskId: task.id, runId: request.runId, agentId: request.agentId }, ctx);
      return result;
    })();
    pending.set(key, work);
    fingerprints.set(key, fingerprint);
    try { return await work; } finally { pending.delete(key); fingerprints.delete(key); }
  };
}

OS_TOOL.description += ' Prefer a generated interface when it helps the user decide or understand: {op:"ui.present",kind,title,data}. kind=form data={fields:[{id,label,type:"text"|"textarea"|"number"|"checkbox"|"select",options?:string[]}]}; all fields required; end turn and wait after form. table data={columns:[{id,label}],rows:[object]}; comparison data={items:[{label,detail}]}; chart data={type:"bar"|"line"|"scatter",series:[{label,value:number}]}; task_board data={columns:[{id,title,tasks:[string]}]}; diff data={before,after}. Data only, no HTML, scripts, commands or external URLs.';
