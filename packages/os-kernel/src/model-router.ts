import { OsError } from "@xiling/os-domain";
import type {
  ModelAddress, ModelCapabilityDeclaration, ModelPolicy, ModelRequirement, ResolvedModelRoute,
} from "@xiling/os-domain";

const DEFAULT_ADDRESS: ModelAddress = { providerId: "runtime", modelId: "default" };

/** Kernel 只保留调度所需能力事实；密钥与完整厂商目录留在 Adapter 层。 */
export class ModelRouter {
  private readonly declarations = new Map<string, ModelCapabilityDeclaration>();

  constructor() {
    this.register({
      address: DEFAULT_ADDRESS,
      displayName: "Runtime default",
      nativeInputs: ["text"],
      nativeOutputs: ["text"],
      contextWindowTokens: 32_000,
      supportsToolUse: true,
      source: "runtime-default",
    });
  }

  register(declaration: ModelCapabilityDeclaration): void {
    if (declaration.contextWindowTokens <= 0) throw new OsError("invalid_command", "model context window must be positive");
    this.declarations.set(key(declaration.address), structuredClone(declaration));
  }

  unregister(address: ModelAddress): void {
    if (key(address) !== key(DEFAULT_ADDRESS)) this.declarations.delete(key(address));
  }

  get(address: ModelAddress): ModelCapabilityDeclaration | undefined {
    const found = this.declarations.get(key(address));
    return found === undefined ? undefined : structuredClone(found);
  }

  /** 列表接口只返回摘要，模型详情仅在精确命中时展开。 */
  catalog(): Array<{ address: ModelAddress; displayName?: string; nativeInputs: string[]; nativeOutputs: string[] }> {
    return [...this.declarations.values()].map((item) => ({
      address: { ...item.address },
      ...(item.displayName === undefined ? {} : { displayName: item.displayName }),
      nativeInputs: [...item.nativeInputs], nativeOutputs: [...item.nativeOutputs],
    }));
  }

  resolve(policy: ModelPolicy, requirement: ModelRequirement = {}): ResolvedModelRoute {
    const preferred = policy.preferred ?? parseLegacy(policy.primary);
    const candidates = preferred === undefined
      ? [...(policy.fallbacks ?? []), DEFAULT_ADDRESS]
      : [preferred, ...(policy.fallbacks ?? [])];
    const rejected: string[] = [];
    for (const address of uniqueAddresses(candidates)) {
      const declaration = this.declarations.get(key(address));
      if (declaration === undefined) {
        rejected.push(`${key(address)} 未登记`);
        continue;
      }
      const reason = incompatible(declaration, policy, requirement);
      if (reason !== undefined) {
        rejected.push(`${key(address)} ${reason}`);
        continue;
      }
      return {
        address: { ...declaration.address },
        capabilities: structuredClone(declaration),
        reason: preferred !== undefined && key(address) === key(preferred)
          ? "agent-preference" : key(address) === key(DEFAULT_ADDRESS) ? "runtime-default" : "compatible-fallback",
      };
    }
    throw new OsError("invalid_command", `没有满足原生模态要求的模型：${rejected.join("；")}`);
  }
}

function incompatible(declaration: ModelCapabilityDeclaration, policy: ModelPolicy, requirement: ModelRequirement): string | undefined {
  if (policy.allowedProviders !== undefined && !policy.allowedProviders.includes(declaration.address.providerId)) return "不在允许的提供商中";
  if (policy.privacyZone === true && declaration.local !== true) return "不能用于隐私区";
  const missingInputs = (requirement.nativeInputs ?? ["text"]).filter((item) => !declaration.nativeInputs.includes(item));
  if (missingInputs.length > 0) return `不原生支持输入 ${missingInputs.join(",")}`;
  const unverifiedInputs = (requirement.nativeInputs ?? ["text"]).filter((item) => item !== "text" && declaration.source === "user-declared");
  if (unverifiedInputs.length > 0) return `输入 ${unverifiedInputs.join(",")} 只有用户声明，尚无原生能力证据`;
  const missingOutputs = (requirement.nativeOutputs ?? ["text"]).filter((item) => !declaration.nativeOutputs.includes(item));
  if (missingOutputs.length > 0) return `不原生支持输出 ${missingOutputs.join(",")}`;
  const unverifiedOutputs = (requirement.nativeOutputs ?? ["text"]).filter((item) => item !== "text" && declaration.source === "user-declared");
  if (unverifiedOutputs.length > 0) return `输出 ${unverifiedOutputs.join(",")} 只有用户声明，尚无原生能力证据`;
  if (requirement.toolUse === true && declaration.supportsToolUse !== true) return "不支持工具调用";
  if (requirement.reasoning === true && declaration.reasoning !== true) return "不支持推理模式";
  return undefined;
}

function parseLegacy(value: string | undefined): ModelAddress | undefined {
  if (value === undefined) return undefined;
  const slash = value.indexOf("/");
  return slash > 0 && slash < value.length - 1
    ? { providerId: value.slice(0, slash), modelId: value.slice(slash + 1) }
    : { providerId: "runtime", modelId: value };
}

function uniqueAddresses(addresses: ModelAddress[]): ModelAddress[] {
  const seen = new Set<string>();
  return addresses.filter((address) => seen.has(key(address)) ? false : (seen.add(key(address)), true));
}

function key(address: ModelAddress): string {
  return `${address.providerId}/${address.modelId}`;
}
