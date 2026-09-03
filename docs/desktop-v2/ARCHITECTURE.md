# 汐灵科研桌面 V2 目标架构

## 2026-09 基础边界

Desktop V2 只有一个原生 Electron 窗口。桌面、Dock、系统界面和应用窗口都位于同一个 Renderer 中；打开应用只创建受管的内部窗口，不创建新的 `BrowserWindow`。

首个基础纵向切片确立五个稳定端口：

1. `SystemStore` 维护唯一的 `system.sqlite`。规范化事实表覆盖工作区、科研对象与关系、事件流、Artifact、Agent Session/Run、显式记忆、应用清单、权限和内部窗口布局。全文、向量和图投影均为可重建派生索引。
2. `WorkspaceFileService` 将用户选择的真实目录呈现为不透明的 `workspace://` 资源。Renderer 不需要获得原生绝对路径；导入采用临时文件后原子改名，避免覆盖且不跨越符号链接。
3. `LazyResource` 为 Core、Agent、索引器和科学运行时提供统一的获取、释放和空闲停止生命周期，避免登录即常驻。
4. `AppManifest` 与 App Registry 描述声明式应用及其能力请求。在系统级应用沙箱完成前，拒绝可执行第三方入口和模型生成的任意代码。
5. Capability Gateway 是内部应用访问文件、网络、Artifact 或 Agent 的唯一通道；UI 组件不获得 Node 原语。

当前 `node:sqlite` 实现完全封装在 `SystemStore` 后方。即使 Node 的实验性 API 以后需要替换，也不会改变领域与 UI 契约。

工作区操作遵循同一边界：导航、分页、搜索和限量文本/小图像预览由 Core 校验 `workspace.read`；新建、重命名与同根移动校验相对路径、目标目录、跨平台名称与 `workspace.write`，并拒绝目录移入自身；系统废纸篓必须先由 Core 解析已授权且非根目录的资源，再由 Main 调用原生 API。Preload 只返回成功/失败、分页 `WorkspaceEntry` 与有界预览，不向 Renderer 泄露绝对路径或通用文件系统能力。PDF 与科学数据格式必须进入独立动态查看器/Worker，不得把完整二进制经 IPC 注入 Renderer。

### 资源预算

- 冷启动仅启动原生壳；Core 和 Worker 首次使用时获取。
- 内部窗口是 Renderer 组件，不是操作系统进程。
- 重型窗口最小化并空闲后必须卸载内容。
- 文件列表和科研时间线必须虚拟化。
- 发布参考设备目标：总空闲内存低于 250 MB、空闲 CPU 低于 1%；十个空闲内部窗口新增内存不超过 80 MB。
- 禁止用轮询读取文件或 Agent 状态，改用去抖文件事件和 Core 推送事件。

当前实现将 React 多窗口包保持为动态导入：冷启动 HTML 不引用该包，第一次从程序坞打开工作台、对话、研究、文献、数据或设置时才加载。工作台已经从静态 DOM 迁入该运行时；最小化后的窗口只保留轻量状态并卸载内容。真实目录监听发生在 Core，经过 120 ms 去抖后以事件推送至 Renderer；工作台卸载时释放监听 lease，Core 可在空闲后退出。

窗口坐标、尺寸、层级和状态写入 `desktop_windows`，并通过独立纯函数完成视口收敛、恢复合并与键盘焦点选择。它们是桌面显示状态，不得混入科研对象与关系。当前默认一个应用一个窗口；文献、Artifact、数据预览等文档型多实例尚未实现，未来必须以稳定资源 URI 作为实例键。

自动门禁把动态窗口生产包限制在 350 KB 以内，并在真实 Electron 启动中使用固定的 1040×700 验收视口，实际点击程序坞、确认工作台文件工具栏、面包屑、预览区与缩放入口出现、唤醒 Core，稳定一秒后检查总活动工作集不超过 520 MB。当前最终实测约 497 MB。该开发/CI 回归线上限来自 Electron 44 在 macOS 上包含 Browser、GPU、Network Service、Renderer 和 Core Utility Process 的真实五进程基线；它不替代发布设备上 250 MB 的空闲目标，D2 结束前还需按进程优化并收紧。

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
