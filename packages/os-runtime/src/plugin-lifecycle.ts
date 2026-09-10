// 插件 Runtime 生命周期端口。OS Kernel 保存安装事实；具体运行框架在此边界之后。

import type { AgentPluginManifest } from "@xiling/os-domain";

export interface PluginLifecycleHost {
  prepare(manifest: AgentPluginManifest): Promise<void>;
  activate(manifest: AgentPluginManifest): Promise<void>;
  deactivate(pluginId: string): Promise<void>;
  remove(pluginId: string): Promise<void>;
}
