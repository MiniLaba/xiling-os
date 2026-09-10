# ADR 0051：内置最小真实 Harness

状态：已实现启动链路，真实模型/工具交付未验收。日期：2026-09-05。

## 决策与证据

核查 npm 发布的 0.1.1-rc.2：DSH CLI 确实支持 --profile，但仅 web/headless 自动初始化，没有默认 sdk profile。ADR 0049 的显式外部覆盖仍有效，其“不猜测启动参数”不等于 CLI 不支持 profile。

活动运行入口为 os-runtime/src/harness-entry.ts：使用官方 Cordis Context、dsh-agent-spine-demo、dsh-llm-pi-ai、dsh-sdk-jsonrpc-server。复用完整官方 Agent Loop 与 JSON-RPC，不自研工具循环；不安装完整 CLI 的 Web/Shell 依赖。已审阅官方 jsonrpc-demo 启动器，采用同一根 Fiber 释放机制，但无需将该启动器作为额外运行依赖。

默认延迟启动该 Node 子进程；Electron 宿主通过 ELECTRON_RUN_AS_NODE 启动同一执行入口。XILING_DSH_ENABLED=0 可禁用，显式 BIN/ARGS 可覆盖。启动时按任务路由读取凭据与模型；旧 scripted 身份仍不静默替换。

## 安全及未完成边界

- 关闭 bash、jobs 工具、goals、Skill 文件扫描和 workspaceContext；不安装本地文件执行器，不自动读取工作区指令。角色表达仍由 OS 编译上下文传入。
- 只支持当前适配器实际传输的文本。未打通 OS 工具回调时，含工具的请求仍在启动前失败。
- 当前不挂持久化插件/压缩插件；不能宣称跨进程恢复全部 Harness 历史。OS 最近消息上下文已按 Session 隔离，不能沿用仅按 Agent 过滤的旧逻辑。
- 未宣称文件系统沙箱，HOME 仍存在。外部自定义运行程序仍需独立审查。自定义端点和 deepseek-official 别名未接入内置 Pi 路由，不静默改名。

## 实际验收

运行真实内置子进程，使用虚拟密钥和临时目录，仅 initialize 握手后 shutdown：成功。未发送 prompt，未访问模型 API。通过 TypeScript 构建及 3 项 Session 定向测试。P1 尚未完成，下一步为真实文字交付、工具网关、完整历史及审批恢复。
