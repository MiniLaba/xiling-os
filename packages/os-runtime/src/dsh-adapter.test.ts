// DeepSeekHarnessSdkRuntimeAdapter 的映射与生命周期测试。
// 用结构化 stub 客户端模拟 wire 通知流 —— 不拉起真实 dsh 运行时。

import test from "node:test";
import assert from "node:assert/strict";
import { activationId, agentId, runId, taskId, sessionId } from "@xiling/os-domain";
import type { HarnessNotificationLike } from "./dsh-adapter.js";
import { DeepSeekHarnessSdkRuntimeAdapter, composePrompt, createDefaultHarnessFactory, mapNotification, harnessSessionId, parseDshArgs, resolveDshLaunch } from "./dsh-adapter.js";
import type { DshHarnessLike, DshClientLike } from "./dsh-adapter.js";
import type { RunRequest, RuntimeEvent } from "./port.js";

test("Session survives activation changes and isolates other sessions and agents", () => {
  const first = makeRequest({ sessionId: sessionId("s1") });
  assert.equal(harnessSessionId(first), harnessSessionId({ ...first, activationId: activationId("new"), taskId: taskId("t2") }));
  assert.notEqual(harnessSessionId(first), harnessSessionId({ ...first, sessionId: sessionId("s2") }));
  assert.notEqual(harnessSessionId(first), harnessSessionId({ ...first, agentId: agentId("a2") }));
  assert.notEqual(harnessSessionId(makeRequest()), harnessSessionId(makeRequest({ taskId: taskId("t2") })));
});

test("explicit launch preserves Windows/Unicode paths and never adds guessed profile flags", () => {
  const args = parseDshArgs('["C:\\\\汐灵 OS\\\\runtime.js","配置文件.yml"]');
  const launch = resolveDshLaunch("C:\\Program Files\\node.exe", args);
  assert.deepEqual(launch, { command: "C:\\Program Files\\node.exe", args: ["C:\\汐灵 OS\\runtime.js", "配置文件.yml"] });
  args.push("later mutation");
  assert.equal(launch.args.length, 2);
  assert.deepEqual(resolveDshLaunch("dsh"), { command: "dsh", args: [] });
});

test("missing executable and invalid argv fail before process launch", () => {
  for (const command of [undefined, "", "  ", "node\nother"]) assert.throws(() => resolveDshLaunch(command), /XILING_DSH_BIN/);
  for (const raw of ["--profile sdk", "{}", "null", '[1]', '["bad\\u0000arg"]']) assert.throws(() => parseDshArgs(raw), /JSON/);
  assert.deepEqual(parseDshArgs(undefined), []);
});

test("subscription disposal failure still reaps process and releases session lock", async () => {
  let closes = 0;
  const adapter = new DeepSeekHarnessSdkRuntimeAdapter({ factory: () => {
    const harness = stubHarness([]);
    harness.close = async () => { closes++; };
    harness.client.subscribeSessionTree = () => ({ next: async () => { throw new Error("transport lost"); }, close() { throw new Error("subscription cleanup"); } });
    return harness;
  } });
  for (let attempt = 0; attempt < 2; attempt++) {
    const iterator = adapter.run(makeRequest())[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value?.type, "run.failed");
    await assert.rejects(iterator.next(), /subscription cleanup/);
  }
  assert.equal(closes, 2);
});

test("events arrive before idle and early consumer exit closes subscription", async () => {
  let closed = false;
  const harness = stubHarness([]);
  let first = true;
  harness.client.subscribeSessionTree = () => ({
    next: async () => { if (first) { first = false; return sessionEvent("agent/inbox/spliced", { inserted: [{ id: "msg_1" }] }); } return sessionEvent("step/start", { turn: 1, step: 1 }); },
    close: () => { closed = true; },
  });
  const adapter = new DeepSeekHarnessSdkRuntimeAdapter({ factory: () => harness, turnTimeoutMs: 50 });
  const iterator = adapter.run(makeRequest())[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.type, "step.started");
  await iterator.return?.();
  assert.equal(closed, true);
});

test("silent transport times out and closes without reporting success", async () => {
  let closed = false;
  const harness = stubHarness([]);
  harness.client.subscribeSessionTree = () => ({
    next: () => new Promise(() => {}),
    close: () => { closed = true; },
  });
  const adapter = new DeepSeekHarnessSdkRuntimeAdapter({ factory: () => harness, turnTimeoutMs: 10 });
  const events = await collect(adapter, makeRequest());
  assert.equal(events.at(-1)?.type, "run.failed");
  assert.equal(closed, true);
});

function notification(method: string, params: Record<string, unknown>): HarnessNotificationLike {
  return { method, params };
}

test("unconnected tool contracts fail before launching a process", async () => {
  let launched = false;
  const adapter = new DeepSeekHarnessSdkRuntimeAdapter({ factory: () => { launched = true; return stubHarness([]); } });
  const events = await collect(adapter, makeRequest({ tools: [{ name: "write", description: "" }] }));
  assert.equal(launched, false);
  assert.equal(events.at(-1)?.type, "run.failed");
});

test("idle before matching inbox receipt cannot complete an unconsumed prompt", async () => {
  const harness = stubHarness([]);
  harness.client.subscribeSessionTree = (id) => {
    const queue = [notification("session.status", { sessionId: id, status: "idle" }), sessionEvent("agent/inbox/spliced", { inserted: [{ id: "wrong" }] })];
    return { next: async () => { const item = queue.shift(); if (!item) throw new Error("closed"); return item; }, close() {} };
  };
  const events = await collect(new DeepSeekHarnessSdkRuntimeAdapter({ factory: () => harness }), makeRequest());
  assert.equal(events.at(-1)?.type, "run.failed");
});

test("interrupt reaps only the selected run and wakes a silent subscription", async () => {
  let closes = 0;
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const harness = stubHarness([]);
  harness.client.subscribeSessionTree = () => ({ next: () => { signalStarted(); return new Promise(() => {}); }, close() {} });
  harness.close = async () => { closes++; };
  const adapter = new DeepSeekHarnessSdkRuntimeAdapter({ factory: () => harness });
  const result = collect(adapter, makeRequest());
  await started;
  await adapter.interrupt(runId("run_1"));
  assert.equal((await result).at(-1)?.type, "run.failed");
  assert.equal(closes, 1);
});

function sessionEvent(type: string, data: Record<string, unknown>): HarnessNotificationLike {
  return notification("session.event", { sessionId: "xiling-agent_1-task-task_1", event: { type, data } });
}

/** stub 运行时：按脚本回放通知，直到状态 idle。 */
function stubHarness(script: HarnessNotificationLike[]): DshHarnessLike {
  const client: DshClientLike = {
    subscribeSessionTree() {
      let cursor = 0;
      const events = [sessionEvent("agent/inbox/spliced", { inserted: [{ id: "msg_1" }] }), ...script];
      return {
        async next() {
          if (cursor >= events.length) throw new Error("script exhausted");
          return events[cursor++]!;
        },
        close() {},
      };
    },
    async prompt() { return "msg_1"; },
  };
  return { start: async () => {}, client, close: async () => {} };
}

function makeRequest(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    runId: runId("run_1"),
    activationId: activationId("act_1"),
    agentId: agentId("agent_1"),
    taskId: taskId("task_1"),
    goal: "汇总 Q3 数据",
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

async function collect(adapter: DeepSeekHarnessSdkRuntimeAdapter, request: RunRequest): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  for await (const event of adapter.run(request)) events.push(event);
  return events;
}

test("wire 通知映射：tool/call → tool.requested，tool/result → tool.completed", () => {
  const texts: string[] = [];
  const outcome = mapNotification(runId("run_1"), sessionEvent("tool/call", { turn: 1, step: 1, callId: "call_9", name: "data.compile", arguments: "{\"rows\":42}" }), (text) => texts.push(text));
  assert.equal(outcome.events.length, 1);
  const requested = outcome.events[0]!;
  assert.equal(requested.type, "tool.requested");
  if (requested.type === "tool.requested") {
    assert.equal(requested.toolCallId, "call_9");
    assert.equal(requested.name, "data.compile");
    assert.deepEqual(requested.input, { rows: 42 });
  }

  const done = mapNotification(runId("run_1"), sessionEvent("tool/result", { turn: 1, step: 1, message: { callId: "call_9", content: "ok" } }), () => {});
  const completed = done.events[0]!;
  assert.equal(completed.type, "tool.completed");
  if (completed.type === "tool.completed") assert.equal(completed.output, "ok");
});

test("完整一轮：事件按线上顺序映射，idle 结束并携带 finalResponse", async () => {
  const adapter = new DeepSeekHarnessSdkRuntimeAdapter({
    factory: () => stubHarness([
      notification("session.status", { sessionId: "xiling-agent_1-task-task_1", status: "running" }),
      sessionEvent("step/start", { turn: 1, step: 1 }),
      sessionEvent("tool/call", { turn: 1, step: 1, callId: "c1", name: "data.compile", arguments: "{}" }),
      sessionEvent("tool/result", { turn: 1, step: 1, message: { callId: "c1", content: "42 rows" } }),
      sessionEvent("assistant/message", { turn: 1, step: 1, message: { content: [{ type: "text", text: "分析完成：增长稳健。" }] } }),
      notification("session.status", { sessionId: "xiling-agent_1-task-task_1", status: "idle" }),
    ]),
  });
  await adapter.activate({ activationId: activationId("act_1"), agentId: agentId("agent_1"), tools: [] });
  const events = await collect(adapter, makeRequest());

  assert.deepEqual(events.map((event) => event.type), ["step.started", "tool.requested", "tool.completed", "message", "run.completed"]);
  const completed = events.at(-1)!;
  if (completed.type === "run.completed") assert.equal(completed.summary, "分析完成：增长稳健。");
});

test("approval without a response channel fails closed instead of pretending to resume", async () => {
  const adapter = new DeepSeekHarnessSdkRuntimeAdapter({
    factory: () => stubHarness([
      sessionEvent("approval/asked", { action: "report.publish", resource: "report/q3", reason: "对外发布" }),
      notification("session.status", { sessionId: "xiling-agent_1-task-task_1", status: "idle" }),
    ]),
  });
  const events = await collect(adapter, makeRequest());
  assert.equal(events.at(-1)?.type, "run.failed");
  assert.equal(events.some((event) => event.type === "run.completed"), false);
});

test("传输断开 → run.failed（不假装成功）", async () => {
  const adapter = new DeepSeekHarnessSdkRuntimeAdapter({
    factory: () => stubHarness([]), // 脚本耗尽 → next() 抛错 = 传输断开
  });
  const events = await collect(adapter, makeRequest());
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "run.failed");
});

test("session id 确定性：同一无 Session 任务复用同一会话（§36 不复制轨迹）", async () => {
  const usedSessionIds: string[] = [];
  const harness: DshHarnessLike = {
    start: async () => {},
    client: {
      subscribeSessionTree(sessionId) {
        usedSessionIds.push(sessionId);
        let first = true;
        return { next: async () => { if (first) { first = false; return notification("session.event", { sessionId, event: { type: "agent/inbox/spliced", data: { inserted: [{ id: "m" }] } } }); } return notification("session.status", { sessionId, status: "idle" }); }, close() {} };
      },
      async prompt(sessionId) { usedSessionIds.push(sessionId); return "m"; },
    },
    close: async () => {},
  };
  const adapter = new DeepSeekHarnessSdkRuntimeAdapter({ factory: () => harness });
  const request = makeRequest();
  await collect(adapter, request);
  await collect(adapter, request);
  assert.ok(usedSessionIds.every((id) => id === "xiling-agent_1-task-task_1"));
});

test("每次运行独占 Harness，避免取消影响同模型其他任务", async () => {
  const created: string[] = [];
  const adapter = new DeepSeekHarnessSdkRuntimeAdapter({
    factory: (route) => {
      created.push(`${route?.address.providerId}/${route?.address.modelId}`);
      return stubHarness([notification("session.status", { sessionId: "xiling-agent_1-task-task_1", status: "idle" })]);
    },
  });
  await collect(adapter, makeRequest());
  await collect(adapter, makeRequest());
  await collect(adapter, makeRequest({
    modelRoute: {
      address: { providerId: "test", modelId: "image-model" },
      capabilities: {
        address: { providerId: "test", modelId: "image-model" },
        nativeInputs: ["text", "image"], nativeOutputs: ["text", "image"], contextWindowTokens: 16_000, source: "native-probe",
      },
      reason: "agent-preference",
    },
  }));
  assert.deepEqual(created, ["test/text-model", "test/text-model", "test/image-model"]);
  await adapter.close();
});

test("composePrompt：目标 + 上下文包 + 约束 + 产物 + 工具", () => {
  const prompt = composePrompt(makeRequest({
    contextBundle: {
      summary: "Q3 销售数据已整理",
      facts: [{ key: "region", value: "日本" }],
      constraints: ["图表用中文标签"],
    },
    inputArtifacts: [{ artifactId: "art_1", version: 2 }],
    tools: [{ name: "data.compile", description: "" }],
  }));
  assert.match(prompt, /目标：汇总 Q3 数据/);
  assert.match(prompt, /背景：Q3 销售数据已整理/);
  assert.match(prompt, /region: 日本/);
  assert.match(prompt, /图表用中文标签/);
  assert.match(prompt, /artifact:\/\/art_1\/version\/2/);
  assert.match(prompt, /data\.compile/);
});

test("默认工厂：dsh 未安装时给出带指引的错误（不崩溃构建）", async () => {
  const adapter = new DeepSeekHarnessSdkRuntimeAdapter({ factory: createDefaultHarnessFactory() });
  const events = await collect(adapter, makeRequest());
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "run.failed");
  if (events[0]!.type === "run.failed") {
    assert.match(events[0]!.reason, /deepseek harness runtime unavailable/);
  }
});
