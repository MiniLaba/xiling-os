import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

export type RoutineSchedule = "hourly" | "daily" | "weekdays" | "once";

export interface BotRoutine {
  id: string;
  projectId: string;
  instruction: string;
  schedule: RoutineSchedule;
  hour: number;
  minute: number;
  enabled: boolean;
  runOn?: string;
  lastSlot?: string;
  createdAt: string;
}

export function localDay(now: Date): string {
  return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
}

export function routineSlot(routine: Pick<BotRoutine, "schedule" | "hour" | "minute" | "runOn">, now: Date): string | null {
  const day = localDay(now);
  const current = now.getHours() * 60 + now.getMinutes();
  const target = routine.hour * 60 + routine.minute;
  if (routine.schedule === "hourly") {
    if (now.getMinutes() !== routine.minute) return null;
    return `${day}T${now.getHours()}`;
  }
  if (routine.schedule === "once") {
    if (routine.runOn !== day || current < target) return null;
    return `${routine.runOn}T${routine.hour}:${routine.minute}`;
  }
  if (routine.schedule === "weekdays" && (now.getDay() === 0 || now.getDay() === 6)) return null;
  if (current !== target && current !== target + 1) return null;
  return `${day}T${routine.hour}:${routine.minute}`;
}

export function routineDue(routine: BotRoutine, now: Date): boolean {
  if (!routine.enabled) return false;
  const slot = routineSlot(routine, now);
  return slot !== null && routine.lastSlot !== slot;
}

export class BotRoutineStore {
  private routines: BotRoutine[] = [];

  constructor(private readonly path: string) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { routines?: BotRoutine[] };
      this.routines = Array.isArray(parsed.routines) ? parsed.routines : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  list(projectId: string): BotRoutine[] {
    return this.routines.filter((routine) => routine.projectId === projectId);
  }

  create(input: Omit<BotRoutine, "id" | "createdAt" | "lastSlot">): BotRoutine {
    if (this.routines.filter((routine) => routine.projectId === input.projectId).length >= 20) throw new Error("定时任务最多 20 条");
    const routine: BotRoutine = {
      id: randomUUID(),
      projectId: input.projectId,
      instruction: input.instruction,
      schedule: input.schedule,
      hour: input.hour,
      minute: input.minute,
      enabled: input.enabled,
      createdAt: new Date().toISOString(),
      ...(input.schedule === "once" ? { runOn: input.runOn ?? localDay(new Date()) } : {}),
    };
    this.routines.push(routine);
    this.persist();
    return routine;
  }

  update(id: string, patch: { enabled?: boolean; lastSlot?: string }): BotRoutine {
    const routine = this.routines.find((item) => item.id === id);
    if (!routine) throw new Error("定时任务不存在");
    if (patch.enabled !== undefined) routine.enabled = patch.enabled;
    if (patch.lastSlot !== undefined) routine.lastSlot = patch.lastSlot;
    this.persist();
    return routine;
  }

  delete(id: string): void {
    this.routines = this.routines.filter((routine) => routine.id !== id);
    this.persist();
  }

  due(now: Date): BotRoutine[] {
    return this.routines.filter((routine) => routineDue(routine, now));
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ routines: this.routines }, null, 2)}\n`, "utf8");
    renameSync(temporary, this.path);
  }
}

const routineInput = z.object({
  projectId: z.string().min(1).max(120),
  instruction: z.string().trim().min(1).max(2_000),
  schedule: z.enum(["hourly", "daily", "weekdays", "once"]),
  hour: z.number().int().min(0).max(23).default(9),
  minute: z.number().int().min(0).max(59).default(0),
  runOn: z.string().regex(/^\d{4}-\d{1,2}-\d{1,2}$/).optional(),
});

export function registerBotRoutineRoutes(app: FastifyInstance, store: BotRoutineStore, projectExists: (projectId: string) => boolean): void {
  app.get("/api/v1/bot/routines", async (request, reply) => {
    const projectId = z.object({ projectId: z.string().min(1).max(120) }).safeParse(request.query);
    if (!projectId.success || !projectExists(projectId.data.projectId)) return reply.code(404).send({ error: "项目不存在" });
    return store.list(projectId.data.projectId);
  });
  app.post("/api/v1/bot/routines", async (request, reply) => {
    const parsed = routineInput.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "定时任务内容无效" });
    if (!projectExists(parsed.data.projectId)) return reply.code(404).send({ error: "项目不存在" });
    try {
      const { runOn, ...rest } = parsed.data;
      return reply.code(201).send(store.create({ ...rest, enabled: true, ...(rest.schedule === "once" ? { runOn: runOn ?? localDay(new Date()) } : {}) }));
    }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.patch("/api/v1/bot/routines/:id", async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const body = z.object({ enabled: z.boolean() }).safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "定时任务内容无效" });
    try { return store.update(params.data.id, { enabled: body.data.enabled }); }
    catch (error) { return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.delete("/api/v1/bot/routines/:id", async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "定时任务内容无效" });
    store.delete(params.data.id);
    return reply.code(204).send();
  });
}

export function dispatchDueRoutines(input: {
  now: Date;
  routines: BotRoutineStore;
  sessionId(projectId: string): string | undefined;
  busy(sessionId: string): boolean;
  start(sessionId: string, projectId: string, routineId: string, instruction: string, slot: string): void;
}): number {
  let started = 0;
  for (const routine of input.routines.due(input.now)) {
    const slot = routineSlot(routine, input.now);
    const sessionId = slot ? input.sessionId(routine.projectId) : undefined;
    if (!slot || !sessionId || input.busy(sessionId)) continue;
    try { input.start(sessionId, routine.projectId, routine.id, routine.instruction, slot); }
    catch { continue; }
    input.routines.update(routine.id, { lastSlot: slot, ...(routine.schedule === "once" ? { enabled: false } : {}) });
    started += 1;
  }
  return started;
}
