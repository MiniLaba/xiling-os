# 汐灵科研桌面 V2 目标架构

## 产品定义

汐灵是应用内的科研工作操作系统，而不是模拟 Windows 或 macOS 的装饰性桌面。桌面负责组织项目空间、科研任务、智能体、文献、数据、计算、证据和产物；科学事实仍由结构化存储与可验证溯源拥有。

## 进程边界

1. **Desktop Main**：应用生命周期、单实例、窗口、原生菜单、文件对话框、通知、更新和系统凭据。
2. **Preload Bridge**：版本化、逐项暴露、参数校验的最小能力桥；不得暴露通用 IPC、Node 或文件系统。
3. **Renderer**：沙箱化界面，只持有显示状态；不得成为科研事实源。
4. **Core Utility Process**：承载 Pi Harness、项目服务、上下文装配、Research Graph 投影和任务状态。核心崩溃不得带走界面进程。
5. **Execution Provider**：本机受管 Python 与后续远程执行；不可信代码不进入 Main/Core。跨平台系统级沙箱完成前，只运行签名、锁版本、参数受限的内置科研配方。
6. **Plugin/MCP Host**：独立进程、显式权限、按任务启用，故障和上下文与核心隔离。

## 不变量

- 正式版本不打开浏览器、不暴露 localhost 地址。
- Renderer 使用 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。
- UI、IPC、HTTP 只能调用同一 Application Service，不复制业务规则。
- Chat、Agent 运行图、科研图谱和文献发现图各自有明确事实源。
- 科研结论必须回链到来源、数据、运行或 Artifact。
- 上下文通过对象引用和任务包装配，不把整个项目或工具目录常驻模型窗口。
- 新科学领域、模型、Skill 与 MCP 不要求修改 Desktop Main。
- 应用代码、用户项目、缓存、日志和凭据使用不同目录和生命周期。
- Desktop V2 不安装、调用或要求容器引擎。
- 进程隔离不等于安全沙箱；未完成平台安全适配器前，禁止执行模型生成的任意代码。

## 目录目标

```text
apps/desktop        Electron 生命周期与安全桥
apps/core           无 HTTP 假设的科研应用核心
apps/web            可选浏览器客户端，不再拥有核心架构
packages/contracts  领域与 IPC 契约
packages/*           Pi、上下文、科研图谱、产物、执行和连接器
```

## 阶段

- D0：冻结产品、进程、权限和迁移边界。
- D1：可启动的原生壳、独立核心、单实例、崩溃恢复。
- D2：项目空间、Dock、分栏、命令面板、任务中心和状态恢复。
- D3：统一 Application Service 与强类型 IPC，Fastify 降为适配器。
- D4：科研语义数据 V2 和可追溯 Research Graph。
- D5：后台 Agent、权限、插件/MCP 隔离和恢复。
- D6：原生科研查看器、安装、签名、更新与发布。
