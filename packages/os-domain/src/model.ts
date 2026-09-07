/** 模型路由领域契约：只描述模型自身的原生能力，不把厂商能力冒充为模型能力。 */
export type NativeInputModality = "text" | "image" | "audio" | "video";
export type NativeOutputModality = "text" | "image" | "audio";

export interface ModelAddress {
  providerId: string;
  modelId: string;
}

export interface ModelCapabilityDeclaration {
  address: ModelAddress;
  displayName?: string | undefined;
  nativeInputs: NativeInputModality[];
  nativeOutputs: NativeOutputModality[];
  contextWindowTokens: number;
  maxOutputTokens?: number | undefined;
  supportsToolUse?: boolean | undefined;
  reasoning?: boolean | undefined;
  /** 本地模型可满足 privacyZone；远程模型不得伪装成本地。 */
  local?: boolean | undefined;
  source: "provider-catalog" | "native-probe" | "user-declared" | "runtime-default";
  verifiedAt?: string | undefined;
}

export interface ModelRequirement {
  nativeInputs?: NativeInputModality[] | undefined;
  nativeOutputs?: NativeOutputModality[] | undefined;
  toolUse?: boolean | undefined;
  reasoning?: boolean | undefined;
}

export interface ResolvedModelRoute {
  address: ModelAddress;
  capabilities: ModelCapabilityDeclaration;
  reason: "agent-preference" | "compatible-fallback" | "runtime-default";
}
