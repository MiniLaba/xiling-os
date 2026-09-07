# 汐灵 AI 原生虚拟操作系统设计文档

> **当前范围（2026-09-07）**：按用户最新指示，以演示美学、人机功效、AIRI 默认 Hiyori 伴侣和声明式生成 UI 为优先；此前未完成的生态/发布事项暂缓。见 [ADR 0054](docs/adr/0054-demo-ui-and-airi-default-companion.md)。不要继续按历史“全部开发”条目扩大本轮范围。

> **语音增补（2026-09-07）**：两条独立通路、配置验证、按需麦克风、共享 Main Task/Session、表单回流与音频 Artifact 已接入。契约和验收边界见 [ADR 0055](docs/adr/0055-dual-voice-task-runtime.md)；不是全双工 Realtime，公网语音尚未验收。

> 当前执行计划：[三阶段最终交付路线](docs/ai-native-os/FINISH_PLAN.md)。顺序压缩，不删减权限、持久化或 App = Persistent Agent 契约。

> 2026-09-06 当前实现：官方 Harness 工具桥、官方自动压缩、显式文件输入/导出、App 委托与追问、可审阅记忆、系统文字伴侣已接入。以 [ADR 0053](docs/adr/0053-native-tools-compaction-and-companion.md) 为准；下面按批次保留的“尚未实现”是历史状态，不能当作现状。公网提供商和跨平台发布仍未验收。

> 状态：实现现状记录；产品语义以 `docs/ai-native-os/` 为准
>
> 最后核对：2026-09-04
>
> 本批提交分支：`codex/demo-dual-voice`（基于 `codex/desktop-v2-foundation`，不更新 main）
>
> 冻结旧版：`v1-legacy-freeze`、`codex/legacy-v1`

> 唯一产品规格与实施顺序：[PRODUCT_SPEC.md](docs/ai-native-os/PRODUCT_SPEC.md) · [DELIVERY_PLAN.md](docs/ai-native-os/DELIVERY_PLAN.md)。旧 Gate、D、S 编号不再驱动产品开发。

## 2026-09-05 目标纠偏

批次 9：自定义模型端点接入 Harness 配置；Main 会话可继续、任务异步返回、界面按事件刷新。三阶段路线见 FINISH_PLAN.md。仍未完成真实模型/工具交付或伴侣，不能因减少步骤而跳过完成证据。
批次 8：内置官方 DSH 最小运行组合已完成真实协议握手，默认按需启动，不再要求先安装外部运行程序。关闭 Shell/Skill 扫描/工作区扫描，工具仍未接通；详见 [ADR 0051](docs/adr/0051-bundled-text-harness.md)。运行上下文按 Session 隔离。此前“没有内置运行程序”是历史状态，真实模型与完整工具闭环仍未验收。

批次 7：现有 CredentialStore 通过只读回调接入 Harness 工厂，按任务路由取最新密钥，子进程不再继承全部父环境。提供商映射、脱敏及限制见 [ADR 0050](docs/adr/0050-selected-model-credential-bridge.md)。完整运行组合尚未真实验证，不能声称已打通 P1。

批次 6：Harness 启动改为显式程序和 JSON 参数，移除猜测的 `--profile sdk`，见 [ADR 0049](docs/adr/0049-explicit-harness-launch.md)。SDK 与完整运行程序分离；模型设置可达不代表任务执行就绪。异常清理始终释放会话锁。P1 运行组合、凭据桥和工具闭环继续保持未完成。

批次 5：独立 App 工作窗口已实现，通过 AppService.view 读取所属 Session 的任务与消息；使用同一个内部窗口管理器、任务服务及事件源。批次 4 的“尚无独立窗口”描述为历史状态。P1 真实工具闭环与 P3 委托仍未完成。新增[系统级虚拟伴侣规划](docs/ai-native-os/COMPANION_PLAN.md)，作为可关闭、懒加载的 Main 交互层，不是新运行内核或记忆库，尚未实现。

批次 4：设置页的个人 Agent 应用管理通过 `desktop:os-apps-manage` → `os.apps.manage` → AppService 接入持久化。创建/会话打开/提交/启停/卸载是真实内核命令；客户端不传 caller 身份。`AppService.submit` 复用 TaskService。入口目前在管理面板内，独立 App 窗口和委托调用尚未完成；新组件惰性加载。

批次 3：AppService 增加停用后原位升级与保留数据的卸载。升级事件同时更新包与 Agent 指令，保留用户模型/记忆/工作区策略；权限或 Runtime 变化不走原位升级。旧激活记录在升级投影中失效，下一次需重新激活。该能力目前为内核 API，并非已完成桌面安装管理体验。

批次 2 实现：`kernel.apps` 管理声明式 App 的安装、独立 Session、启停与能力发现；App 与 Agent 通过同一安装事件持久化，无额外数据库。桌面安装 UI、升级及三入口尚未完成。Runtime 现在每次执行独占进程以支持安全取消，等待消息消费回执后判定完成；当前 SDK 无工具/审批回调的部分明确拒绝。详见 ADR 0048，不将离线测试当真实运行验收。

最新目标是 App = Persistent Agent；用户直用、Main 委托及 App 间调用共用应用逻辑。固定 UI 与生成 UI 同时保留。实施顺序和状态见 [App-Agent 交付计划](docs/ai-native-os/APP_AGENT_DELIVERY.md)。下文“临时应用形态”属于旧设计，不得用于取消持久 App。产品目标优先于实现现状；测试用于证明实现，不能改变用户目标。

## 1. 文档规则

本文记录当前实现，不再把冻结网页版本或桌面壳试验当作现行产品定义。发生冲突时按以下顺序判断：

1. 自动化测试和公开代码端口；
2. `docs/ai-native-os/` 产品规格、架构和路线；
3. 本文；
4. 未被替代的 ADR；
5. 冻结旧版文档，仅作选择性移植参考。

架构变化必须在同一分支更新本文与 ADR。界面存在不等于功能完成；“已实现”必须具备真实调用路径和自动化验证。

## 2. 产品定义

汐灵是运行在现有操作系统之上的 AI 原生虚拟操作系统。人表达目标，Main Agent 组织通用 Agent、按需 Plugins、Workspace、Memory 与 Generative UI 推进任务。科研只是可安装能力方向之一。

```text
AI Native App = Agent + Memory + Plugins + Workspace + Generative UI
```

“AI 原生 OS”有四层含义：

- **交互层**：从目标开始；界面只在比较、查看、选择或审批时出现。
- **应用层**：应用形态由通用 Agent 在任务期装配能力形成，不由固定职业角色或页面列表定义。
- **专业对象层**：应用可定义带来源的专业对象；OS 只提供通用对象、事件、Artifact 与权限机制。
- **智能体层**：Harness、Skill、MCP、模型和子智能体只接收当前任务所需的有界上下文，运行过程可取消、恢复和追溯。

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
| 真实桌面文件夹 | D2 主路径已实现 | 原生目录选择、`workspace://`、目录导航、分页列表/搜索、新建、重命名、剪切移动、系统废纸篓、限量文本/图像预览、桌面图标、拖入和本机打开；专用查看器与 DOM 虚拟化待实现 |
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
- 搜索、新建文件夹与重命名在 Core 中校验路径、重名、跨平台非法字符和 Windows 保留名；移除文件由 Main 在 Core 的写权限校验后调用系统废纸篓，禁止作用于工作区根目录。
- 目录变化使用原生事件和 120 ms 去抖，不轮询。
- 工作区窗口订阅期间持有 Core lease；窗口关闭后释放，Core 可进入空闲停止。
- 双击资源由 Main 消费内部解析出的原生路径并调用系统打开；绝对路径不回传 Renderer。
- 文件夹导航和剪切移动只传递 `workspace://`；移动目标必须是同一根目录内的真实文件夹，禁止把目录移入自身。目录页每次最多向 Renderer 发送 120 项，用户按需加载后续页。文本预览最多读取 512 KB，界面默认请求 256 KB；PNG/JPEG/GIF/WebP 仅在 2 MB 内生成短生命周期 data URL。PDF、NetCDF、GRIB、Zarr 等不得冒充通用文本或整文件传入 Renderer，必须由后续独立按需查看器处理。
- 删除必须进入系统废纸篓；批量覆盖、跨卷移动和同步冲突仍需要单独审批与恢复设计。

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
- 动态 React 窗口生产包：自动回归上限 350 KB；当前 gzip 约 76 KB。
- 真实 Electron 打开工作台内部窗口并唤醒 Core 后的活动工作集：开发/CI 回归上限 520 MB；本轮最终实测约 497 MB。
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
- Unicode/空格文件、原子导入、分页、搜索、新建、重命名、同根移动、自身嵌套拒绝、限量文本/图像预览、二进制降级、重名/非法名/越界与符号链接保护；
- 原生目录变化推送和监听器关闭；
- Electron 安全不变量与无容器依赖；
- 动态窗口包未进入冷启动、包体上限；
- 真实 Electron 中实际点击程序坞、打开 React 工作台、验证缩放入口、唤醒 Core 与活动内存上限。

## 14. 后续顺序

本节由 `docs/desktop-v2/ROADMAP.md` 的 S0–S7 阶段统领；若文字冲突，以该路线和机器可读 `xiling.product.json` 为准。

1. 完成窗口系统剩余项：文档型多实例、窗口菜单、无障碍焦点环与 Core/Renderer 崩溃后的恢复提示；“关于”作为系统界面可暂留静态层。
2. 在已完成目录导航、分页、搜索、新建、重命名、剪切移动、系统废纸篓和文本/小型图像预览的基础上，补齐 PDF/科研格式独立查看器和长列表 DOM 虚拟化。
3. 在统一 `objects/relations/events/artifacts` 上实现强类型 Repository 和事务性 outbox。
4. 选择性接回 Pi Harness、上下文装配、Skill/MCP 隔离与模型权限；先做一个可恢复的真实 Agent 纵向切片。
5. 重建 Research Graph、证据提升、计算溯源和 Artifact 生命周期，并用真实小型科研任务验收。
6. 实现跨平台系统级执行沙箱；通过安全门禁后才开放模型生成代码与第三方应用。
7. 完成安装、签名、自动更新、备份恢复、低资源设备与真实三平台发布验收。

任何阶段都必须保持：一个原生 OS 窗口、真实目录、单一结构化事实源、按需资源、能力网关和科研可追溯性。
# 2026-09-06 实现补记

会话恢复和回答产物边界见 [ADR 0052](docs/adr/0052-session-resume-and-answer-artifacts.md)。内置 Harness 通过官方 JSONL 和公开 resume API 持久化，Context 避免重复历史。用户保存回答是显式产物提升，不替代自动工具执行或研究验证。
