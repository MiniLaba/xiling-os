// @xiling/a2a-adapter-standard：内部 A2A 领域模型 ↔ 公开 A2A Protocol 1.0.0 的纯映射（指南 §12）。
// 内部协议保持零外部绑定；Capability Grant / Workspace Mount / Credential Delegation /
// Memory Export 永远是内部 Extension（只出现在 metadata，不进标准字段）。

export * from "./a2a-mapping.js";
export * from "./a2a-transport.js";
