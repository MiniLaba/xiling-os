import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DeepSeekHarness } from "@deepseek-ai/dsh-sdk-client";
import { bundledHarnessLaunch } from "./dsh-adapter.js";

test("real Harness restores history across owned processes using local model fixture", { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "xiling-history-"));
  const requests: string[] = [];
  const endpoint = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(body);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const base = { id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture" };
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "FIRST_REPLY" }, finish_reason: null }] })}\n\n`);
    res.end(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
  const address = endpoint.address();
  assert.ok(address && typeof address !== "string");
  try {
    for (const prompt of ["FIRST_USER_MARKER", "SECOND_USER_MARKER"]) {
      const harness = new DeepSeekHarness({ launch: { ...bundledHarnessLaunch(), env: {
        PATH: process.env.PATH, HOME: root, TEST_API_KEY: "fixture-only",
        XILING_HARNESS_ROUTE: JSON.stringify({ provider: "fixture", model: "fixture", keyVariable: "TEST_API_KEY",
          profile: { api: "openai-completions", baseURL: `http://127.0.0.1:${address.port}/v1` },
          contextWindow: 32000, sessionId: "persistent-session", persistenceRoot: path.join(root, "sessions"),
        }),
      } }, cwd: root, provider: "fixture", model: "fixture" });
      try {
        const result = await harness.run(prompt, { sessionId: "persistent-session" });
        assert.match(result.finalResponse, /FIRST_REPLY/);
      } finally { await harness.close(); }
    }
    assert.equal(requests.length, 2);
    assert.match(requests[1]!, /FIRST_USER_MARKER/);
    assert.match(requests[1]!, /FIRST_REPLY/);
    assert.match(requests[1]!, /SECOND_USER_MARKER/);
  } finally {
    endpoint.closeAllConnections();
    await new Promise<void>((resolve) => endpoint.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("official compaction plugin reduces an over-budget session before the next request", { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "xiling-compaction-"));
  const requests: string[] = [];
  const endpoint = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(body);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const base = { id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture" };
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "COMPACTION_FIXTURE_REPLY" }, finish_reason: null }] })}\n\n`);
    res.end(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 900, completion_tokens: 2, total_tokens: 902 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
  const address = endpoint.address();
  assert.ok(address && typeof address !== "string");
  try {
    const harness = new DeepSeekHarness({ launch: { ...bundledHarnessLaunch(), env: {
      PATH: process.env.PATH, HOME: root, TEST_API_KEY: "fixture-only",
      XILING_HARNESS_ROUTE: JSON.stringify({ provider: "fixture", model: "fixture", keyVariable: "TEST_API_KEY",
        profile: { api: "openai-completions", baseURL: `http://127.0.0.1:${address.port}/v1` },
        contextWindow: 4000, sessionId: "compact-session", persistenceRoot: path.join(root, "sessions"),
      }),
    } }, cwd: root, provider: "fixture", model: "fixture" });
    try {
      for (let index = 0; index < 8; index += 1) {
        const result = await harness.run(`COMPACTION_MARKER_${index} ${"long-context ".repeat(700)}`, { sessionId: "compact-session" });
        assert.match(result.finalResponse, /COMPACTION_FIXTURE_REPLY/);
      }
    } finally { await harness.close(); }
    assert.ok(requests.length > 8, "automatic compaction should issue a summarization request");
    assert.ok(requests.slice(1).some((body) => body.includes("<compacted-summary>")), "next model request should contain the durable checkpoint");
  } finally {
    endpoint.closeAllConnections();
    await new Promise<void>((resolve) => endpoint.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
