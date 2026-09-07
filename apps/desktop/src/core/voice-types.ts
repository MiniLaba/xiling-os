export type VoiceKind = "native" | "stt" | "tts";
export interface VoiceRoute { provider: "openai" | "custom"; model: string; voice: string; }
export interface VoiceSettings { native: VoiceRoute; stt: VoiceRoute; tts: VoiceRoute; }
export interface VoiceStatus { settings: VoiceSettings; ready: Record<VoiceKind, boolean>; }
export interface VoiceResult { text?: string; audio?: string; taskId?: string; sessionId?: string; status?: VoiceStatus; }
