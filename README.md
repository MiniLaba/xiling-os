<p align="center">
  <img src="docs/assets/xiling-logo.png" alt="汐灵 XiLing" width="180" />
</p>

<h1 align="center">Xi Ling OS——科研 OS</h1>

> **科研桌面整合开发中（2026-09-10）**：以项目、文献、证据、计算、图谱和 Wiki 为核心，保留原生桌面、文件管理、多内部窗口与可选语音伴侣。当前分支正在统一科研服务和桌面内核，尚不代表所有界面与后端已完成接线。最新状态以 [整合契约](docs/research-desktop/INTEGRATION.md) 为准，下面旧版目标仅供历史参考。

<p align="center">
  从“操作软件”转向“表达目标”。<br />
  人提出目标，AI 按需组织 Agent、能力、工作空间与界面，并在关键节点请人决策。
</p>

> 当前活动产品是 AI Native Virtual OS（V3）。`apps/desktop` 是当前原生宿主路径，不代表产品仍以桌面仿真为中心。旧版网页科研 OS 冻结在 `v1-legacy-freeze` 与 `codex/legacy-v1`；此前的 Desktop V2 桌面壳只作为可复用宿主基础。

## 产品目标

汐灵不是给聊天网页套一层桌面外观，也不是复刻 macOS。它要实现：

- 用户从目标开始，而不是先挑选 App、Agent 角色或工作流。
- Agent 是长期存在的通用运行单元，通过任务期加载插件形成 AI 原生应用。
- Agent、Session、Context 与 Memory 分离；多个 Agent 默认隔离，只通过 A2A 交接必要信息和成果。
- 比较、选择、地图、日历和审批等界面按任务状态出现，并只使用可信组件。
- 用户可选择电脑上的真实文件夹作为桌面目录，文件在汐灵内外保持一致，也可从系统文件管理器直接拖入。
- Agent、索引、科学运行时和应用内容按需启动；关闭或最小化后释放资源，不因“像一个 OS”而常驻一套沉重服务。
- 专业应用可以定义自己的对象；科研、文献与海洋能力属于插件，不进入通用 OS 内核。
- Skill、MCP、模型和科学领域能力通过版本化端口装配，只有当前任务命中的能力进入 Agent 上下文。

## 当前已经实现

- 系统级文字与语音伴侣：顶部栏或设置开启，与 Main 共用会话，能提交目标、选择文本文件、取消任务和预览结果；不默认监听麦克风。
- 官方 Harness 的按需进程、会话恢复和自动压缩；受限原生工具支持内部产物、App 协作与追问，界面支持显式输入和导出。
- 两条独立语音通路：原生音频输入/回复，或独立 STT 识别后提交文字任务、独立 TTS 朗读。设置 → 语音与对话填写模型/音色并真实测试后启用；不自动降级，不默认监听。详见 [语音设计](docs/adr/0055-dual-voice-task-runtime.md)。
- Hiyori 显示与设置复用 AIRI 默认角色方案；模型与 Cubism Core 是独立许可的本地资源，不随 Git 仓库再分发。克隆后按 [伴侣资源配置](docs/ai-native-os/COMPANION_ASSETS.md) 安装；未配置角色不影响文字、语音和任务功能。
- **Pi 是唯一科研执行者**：内核只依赖 `AgentRuntime` 端口，Pi 在反腐适配层后面；宿主工具桥把内核投递的工具装入 Pi 工具循环，工具执行权（权限、幂等键、副作用事件）仍在内核。DSH 已从产品移除，Pi 装配失败即明确失败，不降级到别的引擎也不静默退化为纯文本轮次。
- 科研执行走单一主路径：计划 → 审批（资源 = 计划哈希）→ 执行记录 → 内容寻址产物 → 科研图谱投影。没有通过验收的系统级执行沙箱时如实返回"不可执行"，不宿主裸跑、不用 fixture 冒充。
- 项目、事项、Wiki、证据与科研图谱读取只有一个统一入口；项目作用域按内部窗口显式绑定并持久化，跨项目读写被拒绝。
- 当前验证为真实 Pi SDK + 真实内核装配 + 离线路由 fixture；公网模型、真人麦克风/扬声器和跨平台发布验收尚未完成。模型凭据缺失时运行会明确失败，不会模拟成功。

- Electron 单实例、安全协议、沙箱化 Renderer、最小 Preload 和独立 Core Utility Process。
- 一个操作系统原生窗口内的多内部窗口；React 窗口运行时首次打开应用时才动态加载，最小化即卸载内容。
- `system.sqlite` 统一存储端口及首版 schema：工作区、科研对象/关系、事件、Artifact、Agent Session/Run、显式记忆、应用、权限与窗口布局。
- App Manifest、Registry 与 Capability Gateway；“声明能力”和“用户授权”分离。
- 真实目录工作区：Unicode/空格文件名、原子导入、重名保护、符号链接越界防护、事件式目录监听、桌面文件显示与本机默认应用打开。
- Core 与目录监听的获取/释放/空闲停止生命周期。
- 无容器依赖检查、基础层离线测试、真实 Electron + Dock 点击启动测试、动态窗口包体与活动工作集回归门禁。

当前仍是集成中的开发基线：项目、文献、证据、计算与图谱的服务层已经归一并有测试，但科研页面**尚未全部窗口化**（项目/Wiki/科研画布仍是空状态占位），语音/伴侣尚未按科研 scope 提交，真实科研闭环与执行沙箱验收未做。界面中的空状态不会用示例数据伪装成已完成能力。

## 核心模型

```text
AI Native App = Agent + Memory + Plugins + Workspace + Generative UI
```

## 架构

```text
一个 Electron BrowserWindow
└─ 沙箱化 Renderer
   ├─ 轻量桌面 / Dock（冷启动）
   └─ 按需 React 内部窗口运行时
      ├─ 对话
      ├─ 研究
      ├─ 文献
      ├─ 数据
      └─ 设置

最小 Preload / 强类型 IPC
└─ Desktop Main
   ├─ 原生窗口、文件对话框、系统打开与应用生命周期
   └─ LazyResource
      └─ Core Utility Process
         ├─ OS Kernel（Task / Session / Artifact / Approval / Science / Plugin）
         ├─ Pi Research Runtime（唯一模型执行者；宿主工具桥 → 内核 executeTool）
         ├─ Research Application Service（项目/事项/Wiki/证据/图谱 + 逐窗口作用域）
         ├─ Capability Gateway
         ├─ Workspace File Service
         └─ 持久化（os-state.sqlite / knowledge.sqlite / project-scopes.sqlite）
```

### 存储原则

- 真实文件内容以用户选择的目录为准；数据库不复制一棵虚拟文件系统。
- Renderer 只看到 `workspace://` 等不透明资源标识，不获得原生绝对路径、Node、通用 IPC 或密钥。
- `system.sqlite` 保存结构化事实；全文、向量与图索引都是可删除、可重建的投影。
- 旧版的多套开发数据库、记忆库和网页缓存不进入 V2 运行路径，也不做长期双写。
- 开发期允许重建 V2 数据；旧版内容仍由冻结标签和分支保留，无人值守任务不得物理删除。

### 资源原则

- 冷启动不启动 Core，也不加载 React 应用窗口包。
- 文件变化和任务状态使用事件推送，禁止轮询。
- 发布参考设备目标：空闲总内存低于 250 MB、空闲 CPU 低于 1%；十个空闲内部窗口新增内存不超过 80 MB。
- 当前自动回归上限：动态窗口生产包小于 350 KB；真实 Electron 打开窗口并唤醒 Core 后活动工作集小于 450 MB。

## 快速开始

要求 Node.js `>=22.19.0`、Corepack 与 Git。无需 Docker 或 WSL2。

```sh
git clone https://github.com/MiniLaba/xiling-os.git && cd xiling-os && corepack pnpm install --frozen-lockfile && corepack pnpm start
```

开发与验证：

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @xiling/desktop typecheck
corepack pnpm --filter @xiling/desktop smoke
corepack pnpm start
```

`pnpm start` 构建后直接打开原生桌面，不启动 localhost Web 服务。

## 安全边界

Desktop V2 已去除容器依赖，但“独立进程”不等于“安全沙箱”。在 macOS、Windows 和 Linux 的系统级沙箱适配器通过文件越权、网络越权、逃逸和资源耗尽测试前：

- 不执行模型生成的任意代码；
- 不加载可执行第三方应用；
- 仅允许声明式内置应用和锁版本、参数受限的内置科研配方；
- Agent、网络和外部写入能力必须经过 Capability Gateway 与明确权限决定。

## 文档

- [当前产品规格](docs/ai-native-os/PRODUCT_SPEC.md)
- [当前目标架构](docs/ai-native-os/ARCHITECTURE.md)
- [当前唯一实施路线 V0–V7](docs/ai-native-os/DELIVERY_PLAN.md)
- [Desktop V2 宿主历史文档](docs/desktop-v2/README.md)
- [迁移与删除边界](docs/desktop-v2/MIGRATION.md)
- [ADR 0043：原生桌面 V2](docs/adr/0043-greenfield-electron-desktop-v2.md)
- [ADR 0044：无容器执行边界](docs/adr/0044-container-free-native-execution.md)
- [ADR 0045：统一存储与按需应用运行时](docs/adr/0045-unified-desktop-system-store-and-app-runtime.md)

## 旧版

旧版网页科研 OS 的代码与历史可从以下位置查看：

- 标签：`v1-legacy-freeze`
- 维护分支：`codex/legacy-v1`

V2 只选择性复用经验证的领域契约、Pi 适配思想、上下文经济、科研溯源与连接器边界，不复制旧版页面壳、Docker Runner、开发示例或多存储耦合。

## 开发约束

- 所有变更通过 `codex/` 功能分支和 Pull Request 提交，不直接推送主分支。
- 不提交 `.env`、凭据、真实研究数据、`system.sqlite`、缓存或构建产物。
- 自研端口必须有离线测试；架构边界变化必须同步更新 ADR 与 Desktop V2 文档。
