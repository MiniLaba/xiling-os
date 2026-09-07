import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ScriptedRuntimeAdapter } from "@xiling/os-runtime";
import { OSKernel } from "@xiling/os-kernel";
import { NativeVoiceRuntime } from "./native-voice-runtime.js";
import { VoiceService, DEFAULT_VOICE, audioBytes } from "./voice-service.js";

function wav() { const bytes = Buffer.alloc(92); bytes.write("RIFF"); bytes.writeUInt32LE(84,4); bytes.write("WAVEfmt ",8); bytes.writeUInt32LE(16,16); bytes.writeUInt16LE(1,20); bytes.writeUInt16LE(1,22); bytes.writeUInt32LE(24000,24); bytes.writeUInt32LE(48000,28); bytes.writeUInt16LE(2,32); bytes.writeUInt16LE(16,34); bytes.write("data",36); bytes.writeUInt32LE(48,40); return bytes; }

test("voice: native audio → OS form → same-task resume → audio artifact; independent STT/TTS", { timeout: 15000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "xiling-voice-test-"));
  const bodies: Array<{ url: string; body: string }> = [];
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    bodies.push({ url: request.url ?? "", body });
    if (request.url?.endsWith("/audio/transcriptions")) { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ text: "制定两天的计划" })); return; }
    if (request.url?.endsWith("/audio/speech")) { response.setHeader("Content-Type", "audio/wav"); response.end(wav()); return; }
    const data = JSON.parse(body);
    if (data.tool_choice) { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ choices: [{ message: { role: "assistant", tool_calls: [{ id: "probe", type: "function", function: { name: "voice_probe", arguments: "{}" } }] } }] })); return; }
    const wantsForm = data.tools?.length && !body.includes('Slow');
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: wantsForm ? { role: "assistant", tool_calls: [{ id: "call-choose", type: "function", function: { name: "xiling_os", arguments: JSON.stringify({ input: JSON.stringify({ op: "ui.present", kind: "form", title: "选择节奏", data: { fields: [{ id: "pace", label: "节奏", type: "select", options: ["Slow", "Fast"] }] } }) }) } }] } : { role: "assistant", audio: { data: wav().toString("base64"), transcript: "已按你的节奏安排。" } } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  let key = "fixture-only";
  const voice = new VoiceService(directory, (_provider, field) => field === "baseUrl" ? `http://127.0.0.1:${address.port}/v1` : key);
  const settings = structuredClone(DEFAULT_VOICE); for (const kind of ["native", "stt", "tts"] as const) settings[kind].provider = "custom";
  try {
    await voice.save(settings); assert.equal(voice.status().ready.native, false);
    for (const kind of ["native", "stt", "tts"] as const) await voice.test(kind);
    assert.equal(await voice.transcribe(wav().toString("base64")), "制定两天的计划");
    assert.deepEqual(audioBytes(await voice.speak("你好")), wav());
    const kernel = new OSKernel(); kernel.runtimes.register(new ScriptedRuntimeAdapter("text-only-default", [])); kernel.runtimes.register(new NativeVoiceRuntime(kernel, voice));
    kernel.scheduler.setRunner({ run: async (id) => { await kernel.runner.executeTask(id); } });
    const agent = await kernel.agents.create({ name: "Main", runtimeName: "text-only-default", allowedActions: ["ui.present"], modelPolicy: { preferred: { providerId: "runtime", modelId: "default" } } });
    kernel.modelCatalog.register({ address: { providerId: "custom", modelId: settings.native.model }, nativeInputs: ["text", "audio"], nativeOutputs: ["text", "audio"], contextWindowTokens: 32000, supportsToolUse: true, source: "native-probe" });
    const session = kernel.sessions.open({ agentId: agent.id });
    const input = await kernel.artifacts.create({ name: "input.wav", mimeType: "audio/wav", type: "generic", content: wav().toString("base64"), creatorAgentId: agent.id });
    const task = await kernel.tasks.create({ goal: "原生语音请求", ownerAgentId: agent.id, assignedAgentId: agent.id, sessionId: session.id, inputArtifacts: [{ artifactId: input.artifactId, version: input.version }], constraints: { runtimeBinding: { name: "native-audio", providerId: "custom", modelId: settings.native.model } }, modelRequirements: { nativeInputs: ["audio"], nativeOutputs: ["audio"] } });
    await kernel.runner.executeTask(task.id);
    assert.equal(kernel.tasks.get(task.id).state, "waiting_input");
    const surface = kernel.ui.openSurfaces()[0]!;
    await kernel.ui.executeAction(surface.id, "submit", { pace: "Slow" }, { actor: "user" });
    assert.equal(kernel.tasks.get(task.id).state, "completed", kernel.tasks.get(task.id).statusReason);
    assert.equal(kernel.tasks.get(task.id).sessionId, session.id);
    assert.equal(kernel.agents.get(agent.id).runtimeName, "text-only-default");
    const output = kernel.tasks.get(task.id).outputArtifacts[0]!;
    assert.equal(kernel.artifacts.get(output.artifactId).mimeType, "audio/wav");
    assert.deepEqual(audioBytes(kernel.artifacts.contentOf(output.artifactId)), wav());
    assert.ok(bodies.filter((body) => body.url.endsWith("chat/completions")).every((body) => body.body.includes('input_audio')));
    const speechCount = bodies.filter((body) => body.url.endsWith("audio/speech")).length;
    assert.equal(speechCount, 2, "native output does not call TTS");
    await assert.rejects(voice.native([], AbortSignal.abort()));
    key = "changed-key"; assert.equal(voice.status().ready.native, false);
    assert.throws(() => voice.require("native"), /测试/);
    assert.throws(() => audioBytes("not-a-wav"), /音频/);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
});
