<p align="center">
  <img src="docs/assets/xiling-logo.png" alt="汐灵 XiLing" width="180" />
</p>

<h1 align="center">汐灵科研桌面 · XiLing Science OS</h1>

<p align="center">
  面向广泛科学领域的本地优先 AI 科研操作系统。<br />
  海洋与气候是首个重点领域，但系统内核、应用模型和科研对象不绑定单一学科。
</p>

> 当前分支：Desktop V2 开发版。它是全新的原生桌面应用，不依赖 Docker、WSL2 或浏览器启动。旧版网页产品冻结在 `v1-legacy-freeze` 与 `codex/legacy-v1`，不会与 V2 混合运行。

## 产品目标

汐灵不是给聊天网页套一层桌面外观，而是把研究者每天使用的文件、应用、智能体和科研事实放进同一个可恢复工作环境：

- 一个原生应用窗口就是完整科研桌面；对话、研究、文献、数据和设置以应用内窗口并行打开。
- 用户可选择电脑上的真实文件夹作为桌面目录，文件在汐灵内外保持一致，也可从系统文件管理器直接拖入。
- Agent、索引、科学运行时和应用内容按需启动；关闭或最小化后释放资源，不因“像一个 OS”而常驻一套沉重服务。
- 论文、证据、数据、运行、断言和产物最终进入可追溯科研关系模型；聊天与画布只是它们的工作视图，不是事实源。
- Skill、MCP、模型和科学领域能力通过版本化端口装配，只有当前任务命中的能力进入 Agent 上下文。

## 当前已经实现

- Electron 单实例、安全协议、沙箱化 Renderer、最小 Preload 和独立 Core Utility Process。
- 一个操作系统原生窗口内的多内部窗口；React 窗口运行时首次打开应用时才动态加载，最小化即卸载内容。
- `system.sqlite` 统一存储端口及首版 schema：工作区、科研对象/关系、事件、Artifact、Agent Session/Run、显式记忆、应用、权限与窗口布局。
- App Manifest、Registry 与 Capability Gateway；“声明能力”和“用户授权”分离。
- 真实目录工作区：Unicode/空格文件名、原子导入、重名保护、符号链接越界防护、事件式目录监听、桌面文件显示与本机默认应用打开。
- Core 与目录监听的获取/释放/空闲停止生命周期。
- 无容器依赖检查、基础层离线测试、真实 Electron + Dock 点击启动测试、动态窗口包体与活动工作集回归门禁。

当前仍是架构基础版：对话、文献、数据和研究应用已经拥有窗口与能力入口，但完整科研工作流正在重新实现。界面中的空状态不会用示例数据伪装成已完成能力。

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
         ├─ Pi Harness（后续选择性接回）
         ├─ Capability Gateway
         ├─ Workspace File Service
         └─ SystemStore → system.sqlite
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

- [Desktop V2 文档入口](docs/desktop-v2/README.md)
- [目标架构](docs/desktop-v2/ARCHITECTURE.md)
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
