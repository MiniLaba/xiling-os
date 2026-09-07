// Agent Plugin 清单（指南 §20）：
// OS 自己的 manifest——声明提供什么能力、需要什么、请求什么权限。
// 真正的挂载/卸载生命周期归 Cordis（PENDING→LOADING→ACTIVE→UNLOADING→DISPOSED），
// OS 只记录"哪些插件绑定到了哪个 Agent"并校验权限目录。

export interface PluginToolDescriptor {
  name: string;
  description: string;
  inputSchema?: unknown;
}

/**
 * 插件声明的 UI 组件（指南 §20 `ui` 字段）。
 * kind = "window" 时即桌面 APP：桌面端据此在程序坞注入图标并注册可打开的窗口；
 * icon 是渲染器解释的图标键（如 Oxygen 图标名），OS 层不关心其具体形式。
 */
export interface PluginUIComponentDescriptor {
  /** 组件种类："window" = 桌面 APP 窗口；其余为 GenUI primitive（§30） */
  kind: string;
  title?: string | undefined;
  /** 桌面 APP 的 appId（core 注册与程序坞 data-app 键） */
  appId?: string | undefined;
  /** dock 图标键（渲染器解析） */
  icon?: string | undefined;
  /** 窗口内的栏目题眉 */
  eyebrow?: string | undefined;
  /** 一句话描述（dock tooltip / 占位文案） */
  description?: string | undefined;
  /** 窗口默认尺寸 */
  window?: { width?: number | undefined; height?: number | undefined } | undefined;
}

export interface AgentPluginManifest {
  id: string;
  version: string;
  runtime: { entry: string };
  /** 提供的能力（进入 Capability Registry 目录，§21） */
  provides: Array<{ action: string; description?: string | undefined }>;
  /** 依赖的其他插件 id */
  requires?: string[] | undefined;
  /** 请求的权限动作（bind 时对照 Agent 的 permissionPolicy 校验） */
  permissions?: string[] | undefined;
  tools?: PluginToolDescriptor[] | undefined;
  workflows?: string[] | undefined;
  ui?: PluginUIComponentDescriptor[] | undefined;
  memory?: { read?: boolean; write?: boolean } | undefined;
}

export type PluginInstallationState = "disabled" | "enabled";

/** 插件安装是 OS 长期事实；Cordis Fiber 只是可释放的运行态。 */
export interface PluginInstallation {
  pluginId: string;
  manifest: AgentPluginManifest;
  state: PluginInstallationState;
  /** 升级前的清单栈，供显式回滚；不包含当前版本。 */
  history: AgentPluginManifest[];
  installedAt: string;
  updatedAt: string;
  lastError?: { operation: string; reason: string; at: string } | undefined;
}
