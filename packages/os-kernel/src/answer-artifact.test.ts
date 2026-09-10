import test from "node:test";
import assert from "node:assert/strict";
import { OSKernel } from "./kernel.js";

test("answer promotion requires user and completed task, uses stored text and deduplicates", async () => {
  const kernel = new OSKernel();
  const user = { actor: "user" as const };
  const app = kernel.apps.install({ id: "local.writer", version: "1.0.0", name: "Writer", description: "text", runtimeName: "real", instructions: "write", capabilities: [], requestedActions: [], defaultModel: {}, ui: { kind: "agent-chat" } }, [], user);
  const session = kernel.apps.open(app.id, user).session;
  const task = await kernel.apps.submit(app.id, session.id, "notes", user);
  kernel.projection.messages.push({ id: "answer-test", taskId: task.id, runId: "run-test" as never, agentId: app.agentId, role: "assistant", text: "# Stored answer", createdAt: new Date().toISOString() });
  await assert.rejects(kernel.artifacts.saveAnswer("answer-test", { actor: "system" }), /用户/);
  await assert.rejects(kernel.artifacts.saveAnswer("answer-test", user), /完成/);
  kernel.projection.tasks.get(task.id)!.state = "completed";
  const first = await kernel.artifacts.saveAnswer("answer-test", user);
  const second = await kernel.artifacts.saveAnswer("answer-test", user);
  assert.equal(first.artifactId, second.artifactId);
  assert.equal(kernel.artifacts.contentOf(first.artifactId), "# Stored answer");
  assert.equal(first.metadata.creationMode, "user-saved-answer");
  assert.equal(kernel.tasks.get(task.id).outputArtifacts.length, 1);
  await assert.rejects(kernel.artifacts.saveAnswer("unknown", user), /回答/);
});
