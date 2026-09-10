import {
  OsError,
  correlationFor,
  entityNotFound,
  newId,
  sessionId as makeSessionId,
} from "@xiling/os-domain";
import type {
  AgentId,
  AgentSession,
  OSOperationContext,
  SessionId,
  WorkspaceId,
} from "@xiling/os-domain";
import type { KernelServices } from "./kernel-services.js";
import type { OSKernel } from "./kernel.js";

export class SessionService {
  constructor(
    private readonly kernel: OSKernel,
    private readonly services: KernelServices,
  ) {}

  open(input: {
    agentId: AgentId;
    workspaceId?: WorkspaceId | undefined;
    title?: string | undefined;
    ctx?: OSOperationContext | undefined;
  }): AgentSession {
    this.services.agents.get(input.agentId);
    if (input.workspaceId !== undefined && !this.services.projection.workspaces.has(input.workspaceId)) {
      throw entityNotFound("workspace", input.workspaceId);
    }
    const now = new Date().toISOString();
    const session: AgentSession = {
      id: makeSessionId(newId("session")),
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      title: input.title?.trim() || undefined,
      state: "active",
      taskIds: [],
      startedAt: now,
      lastActiveAt: now,
    };
    this.kernel.emit("session.opened", { session }, correlationFor({ agentId: input.agentId, sessionId: session.id }), input.ctx);
    return this.get(session.id);
  }

  get(sessionIdValue: SessionId): AgentSession {
    const session = this.services.projection.sessions.get(sessionIdValue);
    if (!session) throw entityNotFound("session", sessionIdValue);
    return session;
  }

  listByAgent(agentId: AgentId): AgentSession[] {
    return [...this.services.projection.sessions.values()].filter((session) => session.agentId === agentId);
  }

  close(sessionIdValue: SessionId, state: "closed" | "interrupted" = "closed", ctx?: OSOperationContext): AgentSession {
    const session = this.get(sessionIdValue);
    if (session.state !== "active") throw new OsError("illegal_transition", `session ${sessionIdValue} is already ${session.state}`);
    this.kernel.emit("session.closed", { sessionId: sessionIdValue, state }, correlationFor({ agentId: session.agentId, sessionId: session.id }), ctx);
    return this.get(sessionIdValue);
  }
}
