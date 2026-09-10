import type { AgentRuntime, RunRequest, RuntimeEvent } from "@xiling/os-runtime";
import type { RunId } from "@xiling/os-domain";
import type { OSKernel } from "@xiling/os-kernel";
import { audioBytes, type VoiceService } from "./voice-service.js";

/** Native audio is a task runtime adapter, not a separate chat/session store. */
export class NativeVoiceRuntime implements AgentRuntime {
  readonly name = "native-audio";
  readonly supportsHostTools = true;
  readonly supportsCancellation = true;
  readonly nativeInputModalities = ["text", "audio"] as const;
  readonly nativeOutputModalities = ["text", "audio"] as const;
  private running = new Map<RunId, AbortController>();
  constructor(private kernel: OSKernel, private voice: VoiceService) {}
  async activate() {} async suspend() {} async resume() {}
  async interrupt(runId: RunId) { this.running.get(runId)?.abort(); }
  async *run(request: RunRequest): AsyncIterable<RuntimeEvent> {
    const controller = new AbortController(); this.running.set(request.runId, controller);
    try {
      this.voice.require("native");
      const configured = this.voice.settings.native;
      if (request.modelRoute.address.modelId !== configured.model || request.modelRoute.address.providerId !== configured.provider) throw new Error("语音模型配置已改变，请重新发起语音任务");
      const source = request.inputArtifacts.find((ref) => this.kernel.artifacts.get(ref.artifactId).mimeType === "audio/wav");
      if (!source) throw new Error("任务没有原生音频输入");
      const audio = this.kernel.artifacts.contentOf(source.artifactId); audioBytes(audio);
      const messages: unknown[] = [{ role: "system", content: "你是汐灵。直接理解用户音频，用用户的语言简明回答。实际操作必须调用提供的 OS 工具，不得声称完成未执行的操作。需要选择时生成表单。收到等待提示后立即结束本轮。" }];
      // At most two prior native turns, strictly from this session. No STT substitution.
      if (request.sessionId) {
        const prior = [...this.kernel.projection.tasks.values()].filter((task) => task.sessionId === request.sessionId && task.id !== request.taskId && task.state === "completed" && task.constraints.runtimeBinding?.name === this.name).slice(-2);
        for (const task of prior) {
          const input = task.inputArtifacts.find((ref) => this.kernel.artifacts.get(ref.artifactId).mimeType === "audio/wav");
          if (input) messages.push({ role: "user", content: [{ type: "input_audio", input_audio: { data: this.kernel.artifacts.contentOf(input.artifactId), format: "wav" } }] });
          const answer = this.kernel.projection.messages.filter((message) => message.taskId === task.id && message.role === "assistant").at(-1);
          if (answer) messages.push({ role: "assistant", content: answer.text });
        }
      }
      messages.push({ role: "user", content: [{ type: "text", text: JSON.stringify(request.contextBundle ?? { goal: request.goal }) }, { type: "input_audio", input_audio: { data: audio, format: "wav" } }] });
      yield { type: "run.started", runId: request.runId };
      for (let turn = 0; turn < 8; turn++) {
        this.voice.require("native");
        if (JSON.stringify(configured) !== JSON.stringify(this.voice.settings.native)) throw new Error("语音配置发生变化，本轮已停止");
        const stepId = `audio-${turn}`;
        yield { type: "model.requested", runId: request.runId, stepId, model: configured.model };
        const response = await this.voice.native(messages, controller.signal, request.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })));
        const message = response.choices?.[0]?.message;
        if (!message) throw new Error("原生音频接口没有返回消息");
        yield { type: "model.completed", runId: request.runId, stepId };
        if (message.tool_calls?.length) {
          messages.push({ role: "assistant", content: message.content ?? null, tool_calls: message.tool_calls });
          for (const call of message.tool_calls) {
            if (controller.signal.aborted) throw new Error("语音任务已取消");
            const wrapper = JSON.parse(call.function.arguments) as { input: string };
            const input = JSON.parse(wrapper.input);
            if (!request.executeTool) throw new Error("缺少受控工具入口");
            const output = await request.executeTool(call.function.name, input, call.id);
            messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(output) });
            if (this.kernel.tasks.get(request.taskId).state !== "running") { yield { type: "run.completed", runId: request.runId }; return; }
          }
          continue;
        }
        audioBytes(message.audio?.data);
        const transcript = message.audio?.transcript;
        if (!transcript) throw new Error("音频回复缺少同步文字");
        yield { type: "message", runId: request.runId, text: transcript };
        yield { type: "artifact.produced", runId: request.runId, artifact: { name: "语音回复.wav", type: "generic", mimeType: "audio/wav", content: message.audio!.data } };
        yield { type: "run.completed", runId: request.runId }; return;
      }
      throw new Error("语音工具轮次达到上限，请细化任务");
    } catch (error) { yield { type: "run.failed", runId: request.runId, reason: controller.signal.aborted ? "语音任务已取消" : error instanceof Error ? error.message : "语音调用失败" }; }
    finally { this.running.delete(request.runId); }
  }
}
