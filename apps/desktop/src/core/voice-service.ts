import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { VoiceKind, VoiceRoute, VoiceSettings, VoiceStatus } from "./voice-types.js";

export const DEFAULT_VOICE: VoiceSettings = {
  native: { provider: "openai", model: "gpt-audio", voice: "alloy" },
  stt: { provider: "openai", model: "gpt-4o-mini-transcribe", voice: "" },
  tts: { provider: "openai", model: "gpt-4o-mini-tts", voice: "alloy" },
};
export function audioBytes(value: unknown): Buffer {
  if (typeof value !== "string" || value.length > 8_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error("音频无效或超过大小限制");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") throw new Error("需要 WAV 音频");
  return bytes;
}
export class VoiceService {
  settings = structuredClone(DEFAULT_VOICE);
  private verified: Partial<Record<VoiceKind, string>> = {};
  constructor(private directory: string, private readKey: (provider: string, field?: string) => string | undefined) {}
  async initialize() {
    try { const saved = JSON.parse(await readFile(path.join(this.directory, "voice.json"), "utf8")); this.settings = this.validate(saved.settings); this.verified = saved.verified ?? {}; } catch { /* new installation */ }
  }
  private validate(value: unknown): VoiceSettings {
    const data = value as VoiceSettings;
    for (const kind of ["native", "stt", "tts"] as const) {
      const route = data?.[kind];
      if (!route || !["openai", "custom"].includes(route.provider) || typeof route.model !== "string" || !route.model.trim() || route.model.length > 160 || typeof route.voice !== "string" || route.voice.length > 80) throw new Error("语音配置无效");
    }
    return structuredClone(data);
  }
  private connection(route: VoiceRoute) {
    const raw = route.provider === "openai" ? "https://api.openai.com/v1" : this.readKey("custom", "baseUrl");
    if (!raw) throw new Error("请在模型与连接中配置自定义 Base URL");
    const url = new URL(raw);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("语音服务需要 HTTPS，或本机 HTTP 地址");
    const key = this.readKey(route.provider, "apiKey");
    if (!key && route.provider === "openai") throw new Error("请先配置 OpenAI API Key");
    return { base: url.href.replace(/\/$/, ""), key: key ?? "" };
  }
  private fingerprint(kind: VoiceKind) { const route = this.settings[kind]; const connection = this.connection(route); return createHash("sha256").update(JSON.stringify([route, connection])).digest("hex"); }
  status(): VoiceStatus { return { settings: this.settings, ready: Object.fromEntries((["native", "stt", "tts"] as const).map((kind) => { try { return [kind, this.verified[kind] === this.fingerprint(kind)]; } catch { return [kind, false]; } })) as VoiceStatus["ready"] }; }
  async save(settings: unknown) { this.settings = this.validate(settings); await this.persist(); return this.status(); }
  private async persist() { await mkdir(this.directory, { recursive: true }); await writeFile(path.join(this.directory, "voice.json"), JSON.stringify({ settings: this.settings, verified: this.verified }), { mode: 0o600 }); }
  require(kind: VoiceKind) { if (!this.status().ready[kind]) throw new Error("请先在设置中完成该语音模型的真实连通性测试"); }
  async request(kind: VoiceKind, suffix: string, body: BodyInit, signal?: AbortSignal, json = true) {
    const { base, key } = this.connection(this.settings[kind]);
    const response = await fetch(`${base}/${suffix}`, { method: "POST", redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90000)]) : AbortSignal.timeout(90000), headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(json ? { "Content-Type": "application/json" } : {}) }, body });
    if (!response.ok) throw new Error(`语音服务 HTTP ${response.status}；请检查模型、权限与配额`);
    return response;
  }
  async transcribe(audio: string, signal?: AbortSignal) {
    const form = new FormData(); form.set("file", new Blob([new Uint8Array(audioBytes(audio))], { type: "audio/wav" }), "recording.wav"); form.set("model", this.settings.stt.model);
    const result = await (await this.request("stt", "audio/transcriptions", form, signal, false)).json() as { text?: string };
    if (typeof result.text !== "string" || result.text.length > 12000) throw new Error("识别接口没有返回有效文字"); return result.text;
  }
  async speak(text: string, signal?: AbortSignal) {
    if (!text.trim() || text.length > 4096) throw new Error("一次朗读支持 1–4096 字符");
    const result = await this.request("tts", "audio/speech", JSON.stringify({ model: this.settings.tts.model, voice: this.settings.tts.voice, input: text, response_format: "wav" }), signal);
    const audio = Buffer.from(await result.arrayBuffer()).toString("base64"); audioBytes(audio); return audio;
  }
  async native(messages: unknown[], signal?: AbortSignal, tools?: unknown[], toolChoice?: unknown) {
    const route = this.settings.native;
    return await (await this.request("native", "chat/completions", JSON.stringify({ model: route.model, modalities: ["text", "audio"], audio: { voice: route.voice, format: "wav" }, messages, ...(tools?.length ? { tools } : {}), ...(toolChoice ? { tool_choice: toolChoice } : {}) }), signal)).json() as { choices?: Array<{ message?: { role: "assistant"; content?: string; audio?: { data: string; transcript: string }; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> } }> };
  }
  async test(kind: VoiceKind) {
    const fingerprint = this.fingerprint(kind);
    delete this.verified[kind]; await this.persist();
    // Generated silence is a public fixture, not microphone data.
    const wav = Buffer.alloc(48044); wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(48000, 40);
    if (kind === "tts") await this.speak("你好，这是汐灵的语音测试。");
    else if (kind === "stt") await this.transcribe(wav.toString("base64"));
    else { const result = await this.native([{ role: "user", content: [{ type: "text", text: "This is a silence test. Say hello." }, { type: "input_audio", input_audio: { data: wav.toString("base64"), format: "wav" } }] }]); audioBytes(result.choices?.[0]?.message?.audio?.data);
      const probe = await this.native([{ role: "user", content: [{ type: "text", text: "Call voice_probe to confirm audio-task tool support." }, { type: "input_audio", input_audio: { data: wav.toString("base64"), format: "wav" } }] }], undefined, [{ type: "function", function: { name: "voice_probe", description: "No-op connection probe", parameters: { type: "object", properties: {} } } }], { type: "function", function: { name: "voice_probe" } });
      if (!probe.choices?.[0]?.message?.tool_calls?.some((call) => call.function.name === "voice_probe")) throw new Error("该原生音频模型未通过任务工具调用测试");
    }
    if (fingerprint !== this.fingerprint(kind)) throw new Error("测试期间配置已更改，请重新测试");
    this.verified[kind] = fingerprint; await this.persist(); return this.status();
  }
}
