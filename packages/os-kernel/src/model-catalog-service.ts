import { OsError, correlationFor } from "@xiling/os-domain";
import type { ModelAddress, ModelCapabilityDeclaration, OSOperationContext } from "@xiling/os-domain";
import type { KernelServices } from "./kernel-services.js";
import type { OSKernel } from "./kernel.js";

/** 持久化模型能力声明；连接密钥始终由凭据适配器单独持有。 */
export class ModelCatalogService {
  constructor(private readonly kernel: OSKernel, private readonly services: KernelServices) {}

  register(declaration: ModelCapabilityDeclaration, ctx?: OSOperationContext): ModelCapabilityDeclaration {
    validate(declaration);
    this.kernel.emit("model.registered", { declaration: structuredClone(declaration) }, correlationFor({}), ctx);
    return this.get(declaration.address)!;
  }

  remove(address: ModelAddress, ctx?: OSOperationContext): void {
    const inUse = this.services.agents.list().some((agent) => {
      const addresses = [agent.modelPolicy.preferred, ...(agent.modelPolicy.fallbacks ?? [])];
      return addresses.some((candidate) => candidate?.providerId === address.providerId && candidate.modelId === address.modelId);
    });
    if (inUse) throw new OsError("invalid_command", `模型 ${address.providerId}/${address.modelId} 正被 Agent 使用`);
    this.kernel.emit("model.removed", { address }, correlationFor({}), ctx);
  }

  get(address: ModelAddress): ModelCapabilityDeclaration | undefined {
    return this.services.models.get(address);
  }

  list(): ModelCapabilityDeclaration[] {
    return [...this.services.projection.modelDeclarations.values()].map((item) => structuredClone(item));
  }
}

function validate(declaration: ModelCapabilityDeclaration): void {
  if (declaration.address.providerId.trim() === "" || declaration.address.modelId.trim() === "") {
    throw new OsError("invalid_command", "模型提供商和模型名称不能为空");
  }
  if (!declaration.nativeInputs.includes("text")) throw new OsError("invalid_command", "模型必须支持文本指令输入");
  if (declaration.nativeOutputs.length === 0) throw new OsError("invalid_command", "模型至少需要一种原生输出");
}
