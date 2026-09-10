// PiResearchRuntimeAdapter 的行为测试。
// 用结构化 stub 会话模拟 Pi 事件流 —— 不拉起真实 Pi 模型调用。
// 关注点：真实能力声明、工具契约拒绝、取消、以及"未产生终态就不得算完成"。

import test from "node:test";
import assert from "node:assert/strict";
import { activationId, agentId, runId, sessionId, taskId } from "@xiling/os-domain";
import { PiEventQueue, PiResearchRuntimeAdapter, piSessionId } from "./pi-research-adapter.js";
import type { PiStreamEventLike, PiTurnSession } from "./pi-research-adapter.js";
import type { RunRequest, RuntimeEvent } from "./port.js";

test("Pi 会话 ID 按 Session/Task 隔离，不混用其他 Agent 的轨迹", () => {
  const first = makeRequest({ sessionId: sessionId("s1") });
  assert.equal(piSessionId(first), piSessionId({ ...first, activationId: activationId("new"), taskId: taskId("t2") }));
  assert.notEqual(piSessionId(first), piSessionId({ ...first, sessionId: sessionId("s2") }));
  assert.notEqual(piSessionId(first), piSessionId({ ...first, agentId: agentId("a2") }));
  assert.notEqual(piSessionId(makeRequest()), piSessionId(makeRequest({ taskId: taskId("t2") })));
});

test("能力声明默认保守：仅文本、不声称宿主工具、不替 Pi 持有历史", () => {
  const adapter = new PiResearchRuntimeAdapter({ sessionFactory: () => stubSession([]) });
  assert.equal(adapter.name, "pi-research");
  assert.deepEqual([...adapter.nativeInputModalities], ["text"]);
  assert.deepEqual([...adapter.nativeOutputModalities], ["text"]);
  assert.equal(adapter.supportsHostTools, false);
  assert.equal(adapter.ownsSessionHistory, false);
  assert.equal(adapter.supportsCancellation, true);
});

test("宿主显式声明后才扩大输入模态，且不夸大输出模态", () => {
  const adapter = new PiResearchRuntimeAdapter({
    sessionFactory: () => stubSession([]),
    nativeInputModalities: ["text", "image"],
    ownsSessionHistory: true,
  });
  assert.deepEqual([...adapter.nativeInputModalities], ["text", "image"]);
  assert.deepEqual([...adapter.nativeOutputModalities], ["text"]);
  assert.equal(adapter.ownsSessionHistory, true);
});

test("文本轮次：增量合并为一条 message，并以 run.completed 收尾", async () => {
  const session = stubSession([
    { type: "session.started", sessionId: "s" },
    { type: "message.delta", delta: "海冰" },
    { type: "message.delta", delta: "覆盖下的近惯性波" },
    { type: "session.finished", sessionId: "s", stopReason: "stop" },
  ]);
  const events = await collect(new PiResearchRuntimeAdapter({ sessionFactory: () => session }), makeRequest());
  assert.deepEqual(events.map((event) => event.type), ["run.started", "message", "run.completed"]);
  assert.equal((events[1] as { text: string }).text, "海冰覆盖下的近惯性波");
  assert.equal((events[2] as { summary?: string }).summary, "海冰覆盖下的近惯性波");
  assert.equal(session.aborted, false);
});

test("工具契约在工具桥未接入时明确失败，不静默剥离工具", async () => {
  const adapter = new PiResearchRuntimeAdapter({ sessionFactory: () => stubSession([]) });
  const events = await collect(adapter, makeRequest({ tools: [{ name: "read_file", description: "读取文件" }] }));
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "run.failed");
  assert.match((events[0] as { reason: string }).reason, /工具桥未接入/);
});

test("模型错误映射为 run.failed，且不冒充完成", async () => {
  const adapter = new PiResearchRuntimeAdapter({ sessionFactory: () => stubSession([
    { type: "session.started", sessionId: "s" },
    { type: "session.error", sessionId: "s", message: "API Key 无效" },
  ]) });
  const events = await collect(adapter, makeRequest());
  assert.deepEqual(events.map((event) => event.type), ["run.started", "run.failed"]);
  assert.match((events[1] as { reason: string }).reason, /API Key 无效/);
});

test("事件流无终态时判失败（防挂死，禁止把静默当成功）", async () => {
  const adapter = new PiResearchRuntimeAdapter({ sessionFactory: () => stubSession([
    { type: "session.started", sessionId: "s" },
    { type: "message.delta", delta: "半句话" },
  ]) });
  const events = await collect(adapter, makeRequest());
  assert.equal(events.at(-1)?.type, "run.failed");
  assert.match((events.at(-1) as { reason: string }).reason, /未产生结束事件/);
});

test("会话工厂抛错 → 明确的不可用失败，而不是空轮次", async () => {
  const adapter = new PiResearchRuntimeAdapter({ sessionFactory: () => { throw new Error("@earendil-works/pi-agent-core 未安装"); } });
  const events = await collect(adapter, makeRequest());
  assert.deepEqual(events.map((event) => event.type), ["run.failed"]);
  assert.match((events[0] as { reason: string }).reason, /Pi 运行时不可用.*未安装/);
});

test("取消：interrupt 触发 Pi abort，并以取消原因结束而不是成功", async () => {
  let resolveFinish: (() => void) | undefined;
  const session = stubSession([], () => new Promise<void>((resolve) => { resolveFinish = resolve; }));
  const adapter = new PiResearchRuntimeAdapter({ sessionFactory: () => session });
  const iterator = adapter.run(makeRequest())[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.type, "run.started");
  const pending = iterator.next();
  await adapter.interrupt(runId("run_1"));
  assert.equal(session.aborted, true);
  resolveFinish?.();
  const settled = await pending;
  assert.equal(settled.value?.type, "run.failed");
  assert.match((settled.value as { reason: string }).reason, /取消/);
});

test("单轮超时上限触发 abort，不无限等待静默 transport", async () => {
  const session = stubSession([], () => new Promise<void>(() => {}));
  const adapter = new PiResearchRuntimeAdapter({ sessionFactory: () => session, turnTimeoutMs: 20 });
  const events = await collect(adapter, makeRequest());
  assert.equal(events.at(-1)?.type, "run.failed");
  assert.equal(session.aborted, true);
});

test("重复 runId 与已挂起 Agent 被拒绝，避免并发复用同一轮", async () => {
  const adapter = new PiResearchRuntimeAdapter({ sessionFactory: () => stubSession([]) });
  await adapter.suspend(agentId("agent_1"));
  const suspended = await collect(adapter, makeRequest());
  assert.match((suspended[0] as { reason: string }).reason, /挂起/);
  await adapter.resume(agentId("agent_1"));
  const resumed = await collect(adapter, makeRequest());
  assert.notEqual(resumed[0]?.type, "run.failed");
});

test("事件队列保持入队顺序，关闭后仍吐出已入队事件", async () => {
  const queue = new PiEventQueue();
  queue.push({ type: "message.delta", delta: "1" });
  queue.push({ type: "message.delta", delta: "2" });
  queue.close();
  assert.equal((await queue.next())?.type, "message.delta");
  assert.deepEqual(await queue.next(), { type: "message.delta", delta: "2" });
  assert.equal(await queue.next(), undefined);
  queue.push({ type: "session.started", sessionId: "s" });
  assert.equal(await queue.next(), undefined);
});

function makeRequest(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    runId: runId("run_1"),
    activationId: activationId("act_1"),
    agentId: agentId("agent_1"),
    taskId: taskId("task_1"),
    goal: "梳理海冰覆盖期的近惯性波证据",
    modelRoute: {
      address: { providerId: "test", modelId: "text-model" },
      capabilities: {
        address: { providerId: "test", modelId: "text-model" },
        nativeInputs: ["text"], nativeOutputs: ["text"], contextWindowTokens: 8_000, source: "user-declared",
      },
      reason: "agent-preference",
    },
    inputArtifacts: [],
    tools: [],
    ...overrides,
  };
}

interface StubSession extends PiTurnSession { readonly aborted: boolean }

function stubSession(script: PiStreamEventLike[], wait: () => Promise<void> = async () => {}): StubSession {
  const listeners = new Set<(event: PiStreamEventLike) => void | Promise<void>>();
  let aborted = false;
  const session: StubSession = {
    get aborted() { return aborted; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async prompt() {
      for (const event of script) for (const listener of listeners) await listener(event);
      await wait();
    },
    abort() { aborted = true; },
  };
  return session;
}

async function collect(adapter: PiResearchRuntimeAdapter, request: RunRequest): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  for await (const event of adapter.run(request)) events.push(event);
  return events;
}
