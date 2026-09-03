# 汐灵科研桌面 V2 设计文档

> 状态：当前有效的 living design document
>
> 最后核对：2026-09-03
>
> 当前分支：`codex/desktop-v2-foundation`
>
> 冻结旧版：`v1-legacy-freeze`、`codex/legacy-v1`

## 1. 文档规则

本文描述 Desktop V2 的当前产品与架构，不再把冻结网页版本当作现行系统。发生冲突时按以下顺序判断：

1. 自动化测试和公开代码端口；
2. 本文；
3. 未被替代的 Desktop V2 ADR；
4. `docs/desktop-v2/` 专题文档；
5. 冻结旧版文档，仅作选择性移植参考。

架构变化必须在同一分支更新本文与 ADR。界面存在不等于功能完成；“已实现”必须具备真实调用路径和自动化验证。

## 2. 产品定义

汐灵是面向广泛科学领域的本地优先 AI 科研操作系统。海洋与气候是首个重点领域，但桌面、Agent、对象关系、应用接口和执行边界必须保持领域中立。

“科研 OS”在 V2 中有四层含义：

- **桌面层**：打开应用即进入一个完整科研桌面；多个应用在一个原生窗口内并行工作。
- **应用层**：对话、研究、文献、数据、设置以及未来领域应用都通过 Manifest、窗口和能力端口接入。
- **科研事实层**：问题、论文、证据、数据、运行、断言和产物形成可审计关系，而不是散落在聊天或页面缓存中。
- **智能体层**：Pi Harness、Skill、MCP、模型和子智能体只接收当前任务所需的有界上下文，运行过程可取消、恢复和追溯。

### 不做什么

- 不模拟一套与真实文件脱节的虚拟磁盘。
- 不为“多窗口”创建多个 Electron 操作系统窗口。
- 不让 Renderer、应用组件或模型直接获得 Node、任意原生路径、凭据或通用 IPC。
- 不用后台轮询和常驻全部服务换取表面实时性。
- 不把聊天文本、画布坐标、模型摘要或临时文献推荐自动升级为科研事实。
- 系统级沙箱完成前，不执行模型生成的任意代码或可执行第三方应用。

## 3. 当前交付状态

| 能力 | 状态 | 事实依据 |
| --- | --- | --- |
| 原生桌面壳 | 已实现 | Electron 单实例、安全 `xiling://` 协议、CSP、沙箱化 Renderer |
| 应用内多窗口 | 基础已实现 | 一个 `BrowserWindow`；React Window Manager 按需载入、拖动、缩放、聚焦、最大化、最小化卸载、键盘切换与布局恢复 |
| 真实桌面文件夹 | 基础已实现 | 原生目录选择、`workspace://`、列表、桌面图标、拖入、重名保护、变化事件、本机打开 |
| 统一结构化存储 | schema/端口已实现 | `SystemStore` 与 `system.sqlite` v1；完整科研仓储 API 尚待实现 |
| 应用能力系统 | 基础已实现 | Manifest、Registry、Capability Gateway、显式 allow/deny |
| 资源生命周期 | 基础已实现 | Core 和目录监听的 acquire/release/idle-stop；Agent/索引/运行时待接入 |
| 工作台 | 基础已迁移 | 真实文件夹、拖入、本机打开和桌面文件投影均由受管 React 窗口承载 |
| 对话、研究、文献、数据、设置 | 窗口入口已实现 | 设置已有程序坞尺寸；其余仍为空状态/能力占位，不宣称旧版功能已迁移 |
| Pi Harness 与上下文 | 待选择性接回 | 复用旧版经验证端口，不复制旧组合根和多存储耦合 |
| Research Graph | 待 V2 重建 | 以统一对象/关系事件为事实源，图索引为派生投影 |
| 科学执行 | 禁用任意代码 | 仅允许未来的签名、锁版本、参数受限内置配方 |
| 第三方应用 | 禁用可执行入口 | 系统沙箱、签名和权限 UX 未完成 |

## 4. 运行架构

```text
Operating System
└─ XiLing Electron Main（唯一原生窗口）
   ├─ 原生生命周期 / 单实例 / 文件对话框 / 系统打开 / 更新
   ├─ LazyResource<Core Utility Process>
   └─ BrowserWindow
      ├─ sandbox: true
      ├─ contextIsolation: true
      ├─ nodeIntegration: false
      └─ Renderer
         ├─ 冷启动桌面 / Dock / 背景
         └─ 首次打开应用后动态加载 React Window Manager

Preload（版本化最小能力）
└─ Desktop Main IPC
   └─ Core RPC
      ├─ SystemStore
      ├─ App Registry
      ├─ Capability Gateway
      └─ Workspace File Service
```

### 进程职责

| 边界 | 拥有 | 禁止 |
| --- | --- | --- |
| Renderer | 显示状态、内部窗口、用户手势 | Node、绝对路径、密钥、业务事实写入 |
| Preload | 逐项暴露的强类型调用 | 暴露 `ipcRenderer`、shell 或通用 invoke |
| Desktop Main | 原生能力、可信发送方校验、Core 生命周期 | 科研领域规则、模型工具循环 |
| Core Utility Process | 存储、能力授权、工作区和未来 Agent/图服务 | 直接把任意本机能力交给应用 |
| Execution Host（未来） | 受批准科研配方 | 在 Main/Core 内执行不可信代码 |
| Plugin/MCP Host（未来） | 隔离第三方协议与工具 | 常驻完整工具目录、绕过 Capability Gateway |

## 5. 单窗口与内部多窗口

用户所说的多窗口是汐灵桌面内部的窗口，不是多个 OS 窗口。

- Electron 始终维持一个主 `BrowserWindow`。
- 内部窗口由 React Window Manager 管理 `open/minimized/maximized`、坐标、尺寸、层级和轻量 payload。
- Dock 首次打开受管应用时才动态加载 React 生产包；冷启动不支付其内存与解析成本。
- 最小化窗口不渲染内容，只保留轻量窗口状态；重型查看器以后必须独立动态分块。
- 窗口布局写入 `desktop_windows`；布局不是科研事实。
- 每个内部应用默认单实例；文献、文件和 Artifact 等文档型多实例必须使用稳定资源 URI 作为实例键。

工作台已迁入 React Window Manager；静态层只保留桌面外壳与“关于”系统界面。新增应用必须进入 React Window Manager，不再扩展静态 DOM 窗口。

当前窗口模型把视口约束、恢复合并和键盘焦点选择抽离为可单测纯函数。`⌘/Ctrl + \`` 在已打开窗口间切换，`⌘/Ctrl + W` 最小化当前窗口；拖动标题栏、右下角缩放与双击最大化复用同一窗口状态，并在交互结束后持久化。

## 6. 真实工作区与文件系统

用户选择的本机目录是汐灵桌面文件内容的事实源：

```text
真实目录（文件字节）
  ↕ Workspace File Service
workspace://primary/<encoded path>（Renderer/领域引用）
  ↕ SystemStore
对象元数据、关系、窗口与科研状态
```

约束：

- Renderer 不接收原生绝对路径。
- 所有相对路径必须做根目录包含校验；不得通过 `..`、绝对路径或编码绕过。
- 默认不遍历符号链接、junction 或 reparse point。
- 拖入先复制到同一根目录的临时名，成功后原子改名；重名使用稳定的编号后缀，不覆盖用户文件。
- 目录变化使用原生事件和 120 ms 去抖，不轮询。
- 工作区窗口订阅期间持有 Core lease；窗口关闭后释放，Core 可进入空闲停止。
- 双击资源由 Main 消费内部解析出的原生路径并调用系统打开；绝对路径不回传 Renderer。
- 后续删除必须进入系统废纸篓；批量覆盖、跨卷移动和同步冲突需要单独审批与恢复设计。

## 7. 统一存储

V2 使用一个 `system.sqlite` 结构化事实源，避免旧版多个 SQLite、图数据库和前端缓存之间的双写与漂移。

### v1 表族

| 表族 | 责任 |
| --- | --- |
| `workspace_roots` | 用户选择的真实目录，仅 Main/Core 可读取原生路径 |
| `objects` | 领域中立科研对象及版本化正文 |
| `relations` | 对象之间的类型化、有属性关系 |
| `events` | 可重放状态变化与投影输入 |
| `artifacts` | 产物 URI、哈希、媒体类型和生命周期 |
| `agent_sessions` / `agent_runs` | Agent 会话、父子运行、状态与摘要 |
| `memories` | 显式、带来源的工作/长期记忆，不保存无边界聊天转储 |
| `apps` / `permissions` | Manifest、启用状态与能力决定 |
| `desktop_windows` | 内部窗口布局和轻量 payload |

### 所有权规则

- `SystemStore` 是唯一可以依赖当前 `node:sqlite` API 的实现；领域和 UI 只依赖端口。
- SQLite 当前 Node API 为实验性，因此替换风险由适配器吸收。
- 全文、向量和图数据库均为可重建派生索引，不成为独立事实源。
- 文件字节留在真实工作区或未来内容寻址 Artifact 区，不塞入 SQLite。
- 旧版开发数据库和记忆库已断开但不由无人值守任务物理删除。
- V2 开发期允许破坏性重建 schema，不做旧数据兼容层或长期双写。

## 8. 应用模型与能力网关

每个应用由版本化 Manifest 描述：稳定 ID、名称、版本、声明式入口、所需能力与是否内置。

首版能力：

- `workspace.read` / `workspace.write`
- `artifact.read` / `artifact.write`
- `agent.invoke`
- `network.access`

Manifest 中声明能力不等于获得能力。Capability Gateway 的规则是：

1. 应用必须存在且声明该能力；
2. 显式 deny 永远拒绝；
3. 显式 allow 才允许高风险能力；
4. 仅内置应用的本地工作区/Artifact 基础能力可使用安全默认值；
5. Agent 与网络默认要求明确权限决定；
6. 系统级沙箱前只接受 `builtin://` 声明式入口。

未来应用接口必须通过 Gateway 扩展，不得新增一组直接 IPC 捷径。能力授权需要范围、期限、资源选择和审计事件，而不是永久布尔值。

## 9. Agent、Pi 与上下文的重建约束

V2 后续接回 Pi 时保留以下内核，不搬回旧版组合方式：

- Pi 的模型调用、流式事件、工具循环、取消、会话树与 Compaction 原语；
- Pi 反腐适配层，业务包不得到处直接依赖 Pi；
- Durable Session/Run/Entry/Usage/Compaction 语义；
- Skill 索引常驻、正文按任务命中后读取；
- MCP Server/工具目录留在隔离 Host，只按 search/describe 激活命中 schema；
- 大型 PDF、数据、日志和历史留在文件/Artifact，只把 URI、摘要和必要片段送入模型；
- Research Graph 只投影当前任务相关的确定性局部邻域；
- 科研事实独立于聊天压缩长期保存。

不设武断的全局 token 硬上限；通过对象引用、阶段能力、内容寻址、隔离子任务和结构化 Handoff 让系统天然减少无关上下文。

## 10. 科研对象与图工程方向

Research Graph 将建立在统一对象/关系/事件之上，回答“科学上哪些来源、证据、计算和产物支持哪个结论”。它与以下两类图分离：

- Agent Execution Graph：回答 Agent 如何完成一次任务；来自 Session/Run/Event。
- Literature Discovery Graph：回答检索阶段哪些论文在引用或主题上相关；属于可丢弃发现投影。

正式 Research Graph 至少需要 Paper、ClaimRevision、EvidenceAssertion、DatasetSnapshot、Run、ArtifactVersion、Method、Tool、Decision 与 Review 等对象，以及支持、反驳、派生、自某版本生成、使用输入、审查、替代等类型化关系。

画布只保存视口、坐标、折叠和筛选；移动节点不得改写科研事实。图引擎用于查询与布局加速，不再成为第二写入真相。

## 11. 资源预算

- 冷启动：目标低于 3 秒，仅启动 Main、Preload 和轻量桌面。
- 空闲总内存：发布参考设备低于 250 MB。
- 空闲 CPU：低于 1%。
- 十个空闲内部窗口：新增内存不超过 80 MB。
- 动态 React 窗口生产包：自动回归上限 350 KB；当前 gzip 约 74 KB。
- 真实 Electron 打开工作台内部窗口并唤醒 Core 后的活动工作集：开发/CI 回归上限 520 MB；本轮实测约 495 MB。
- 文件列表、日志、文献、事件和图节点必须虚拟化/有界查询。
- Core、Agent、索引器、Python、MCP 和领域运行时必须接入统一生命周期，禁止登录即全开。

250 MB 是空闲产品目标，520 MB 是当前 Electron 44 多进程活动场景的临时防退化上限，两者不得混用。D2 结束前必须按进程复测并收紧该门槛，不能把临时基线当作发布标准。

## 12. 安全与跨平台

Desktop V2 目标平台为 macOS、Windows 11 x86_64 与主流 Linux，均原生运行控制面，不依赖 WSL2 或 Docker。

当前已完成 Electron Renderer 沙箱与进程隔离，但尚未完成执行不可信代码所需的系统级沙箱。未来需要分别实现并验证：

- macOS App Sandbox/seatbelt 与签名权限；
- Windows AppContainer、受限令牌/Job Object 等合适边界；
- Linux namespace/seccomp/portal 等合适边界；
- 文件白名单、默认断网、资源限额、取消、超时、输出收集与逃逸测试。

在三平台安全适配器验收前，不得用普通子进程、Electron Utility Process 或 Python venv 冒充安全沙箱。

## 13. 自动化验证

```sh
pnpm --filter @xiling/desktop typecheck
pnpm --filter @xiling/desktop test:foundation
pnpm --filter @xiling/desktop smoke
XILING_DESKTOP_LAUNCH_SMOKE=1 pnpm --filter @xiling/desktop start
```

当前测试覆盖：

- 统一 schema 初始化、应用与窗口状态恢复；
- 窗口视口约束、显式打开与已保存几何合并、键盘焦点切换；
- Manifest 校验与显式能力 allow/deny；
- LazyResource 共享实例、最后 lease 后停止；
- Unicode/空格文件、原子导入、重名保护、路径越界与符号链接；
- 原生目录变化推送和监听器关闭；
- Electron 安全不变量与无容器依赖；
- 动态窗口包未进入冷启动、包体上限；
- 真实 Electron 中实际点击程序坞、打开 React 工作台、验证缩放入口、唤醒 Core 与活动内存上限。

## 14. 后续顺序

1. 完成窗口系统剩余项：文档型多实例、窗口菜单、无障碍焦点环与 Core/Renderer 崩溃后的恢复提示；“关于”作为系统界面可暂留静态层。
2. 补齐文件新建、重命名、移动、系统废纸篓、搜索、预览和大目录虚拟化。
3. 在统一 `objects/relations/events/artifacts` 上实现强类型 Repository 和事务性 outbox。
4. 选择性接回 Pi Harness、上下文装配、Skill/MCP 隔离与模型权限；先做一个可恢复的真实 Agent 纵向切片。
5. 重建 Research Graph、证据提升、计算溯源和 Artifact 生命周期，并用真实小型科研任务验收。
6. 实现跨平台系统级执行沙箱；通过安全门禁后才开放模型生成代码与第三方应用。
7. 完成安装、签名、自动更新、备份恢复、低资源设备与真实三平台发布验收。

任何阶段都必须保持：一个原生 OS 窗口、真实目录、单一结构化事实源、按需资源、能力网关和科研可追溯性。
