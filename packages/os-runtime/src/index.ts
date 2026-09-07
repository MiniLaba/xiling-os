// @xiling/os-runtime：Runtime Boundary。
// OS 内核只 import 这里的接口；具体引擎（DeepSeek Harness 等）在适配器后面。

export * from "./port.js";
export * from "./scripted-adapter.js";
export * from "./dsh-adapter.js";
export * from "./plugin-lifecycle.js";
