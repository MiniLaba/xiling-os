<p align="center">
  <img src="docs/assets/xiling-logo.png" alt="汐灵 XiLing" width="240" />
</p>

<h1 align="center">汐灵 OS · XiLing Science Intelligence</h1>

<p align="center">
  面向科学研究的本地优先 AI 工作台：把问题、证据、数据、计算与产物组织成可追踪、可审批、可复现的研究闭环。
</p>

<p align="center">
  <a href="DESIGN.md">设计文档</a> ·
  <a href="docs/architecture/modular-monolith.md">架构说明</a> ·
  <a href="docs/oss-evaluation.md">开源复用清单</a> ·
  <a href="docs/testing/smoke-matrix.md">测试矩阵</a>
</p>

> 当前版本是开发阶段 Beta 候选。首个深度领域为物理海洋与气候科学，稳定内核通过受审计的领域包预留向地学、天文、生物信息、化学材料等科学领域扩展的边界。

## 它解决什么问题

科学研究不是一次问答，而是一条需要反复验证的链路：

```text
科研问题 → 文献与证据 → 数据检索/切片 → 隔离计算
        → 图表与报告 → Reviewer 审查 → Artifact/溯源 → 项目知识沉淀
```

汐灵 OS 将这条链路放进同一个项目空间。模型可以协助检索、规划和执行，但下载、计算和外部写入都必须经过可读的审批计划；论文摘录、数据快照、运行日志和图表以结构化对象保存，而不是被一段聊天记录替代。

## 五个工作面，共享一套科研事实

| 工作面 | 作用 | 用户看到的重点 |
| --- | --- | --- |
| Chat | 提出问题、分解任务、审批和跟进 | 流式回答、引用、Artifact、当前 Agent 运行链 |
| Agent 运行图 | 以 Flowith 风格节点理解当前或项目内 Agent 运行 | 输入、回答、分支和 follow-up，不展示噪声级工具日志 |
| 科研画布 | 查看项目的 Research Graph | Claim、Evidence、Paper、Dataset、Run、Artifact、Wiki 的关系与溯源 |
| 项目 | 管理目标、事项、里程碑和实验 | 可审批的科研 Workflow 与状态 |
| Wiki / 文献工作台 | 像浏览百科一样理解项目，搜索和阅读论文 | 双向链接、证据提升、批注、论文关系发现 |

画布中的科研事实不等同于 Agent 对话记录：前者由 Research Graph 持久化，后者由 Agent Harness 持久化；两者通过显式的项目、来源、证据和产物 ID 连接，避免把模型上下文误当成科学事实。

## 架构要点

- **可恢复的 Agent 中枢**：Pi Runtime 负责模型、流式事件、工具循环和压缩；`@xiling/agent-harness` 负责耐久 Session、Run、Operation、Entry、Usage、取消和重连。
- **Research Graph**：使用 LadybugDB 保存类型化实体与关系；论文、证据断言、数据集、运行、Artifact 和 Wiki 通过稳定 ID、版本和内容哈希连接。
- **天然节省上下文**：上下文按项目、当前任务和显式选中的图邻域组装；Skill 只加载索引命中项，MCP 只通过一个惰性代理接入，完整 PDF/NetCDF/日志只以 Artifact URI 流动。
- **科学执行沙箱**：Python、xarray、Dask、SciPy、Cartopy、Jupyter Kernel Gateway 等运行在统一的最小权限 Linux 容器中；Server 不直接执行科研代码。
- **领域可扩展**：`packages/science-domains` 以 Manifest 注册领域能力、角色、连接器和查看器；通用内核不复制，未选择的领域不会进入当前项目上下文。
- **跨平台边界**：macOS、Linux 和 Windows 11 均原生运行 Web/Node/SQLite；三平台的科研计算统一进入 Docker Linux 沙箱。

详细的模块所有权、数据模型、不变量和演进规则以 [活设计文档](DESIGN.md) 为准。

## 当前能力

- Chat 与 Agent 运行图：流式事件、会话历史、分支、取消、恢复和轻量运行节点。
- 科研画布：节点自由拖动、曲线连线、视图切换、自动整理、Research Graph 投影和布局恢复。
- Research Graph：Paper、Claim、Evidence、Dataset、Run、Artifact、Wiki 等实体的关系查询与证据闭环。
- 项目/Wiki：研究目标、任务、实验记录、版本化 Markdown、反向链接和 Artifact 定位。
- 文献工作台：Semantic Scholar / OpenAlex 适配、关系发现、论文阅读、标注和证据提升。
- 数据连接器：本地 NetCDF、GRIB、Zarr、CSV，以及 ERDDAP、Argo GDAC、Copernicus Marine、NASA Harmony 的预检/审批边界。
- 多智能体基础：受控角色、TaskPacket、并发/递归约束、上下文隔离、Handoff 和父子运行血缘。
- 设置：模型提供商、原生输入/输出模态、连通性测试、凭据状态、Skill 与 MCP Host 配置。

## 快速开始

### 环境要求

- Node.js `>=22.19.0`
- pnpm `11.19.0`（可使用 Corepack）
- Python 3.12（仅运行本地 Runner smoke 时需要）
- Docker（仅运行隔离科研 Runner 时需要）

```sh
corepack enable
pnpm install
pnpm dev
```

开发模式：

- Web：<http://127.0.0.1:4318/>
- Server：<http://127.0.0.1:4317/>

正式构建由 Server 托管 Web：

```sh
pnpm start
# 健康检查通过后自动打开 http://127.0.0.1:4317/
```

无桌面或 CI 环境使用 `pnpm start:no-browser`。

默认连接器使用离线 fixture，不会因为填写凭据就自动访问公网。真实连接器需要显式设置 `XILING_CONNECTOR_MODE=live`，并在应用内完成预检和审批。

### Windows 11（原生应用 + Docker 科研沙箱）

Node 服务、Pi Harness、SQLite、Research Graph、项目与 Artifact 原生运行并保存在 `%LOCALAPPDATA%\XiLingOS`，不要求安装或管理 WSL 发行版。Python 科研代码和数据客户端进入 Docker Desktop Linux 容器沙箱。PowerShell 启动后会等待健康检查并自动打开默认浏览器：

```powershell
.\scripts\windows\xiling-doctor.ps1
.\scripts\windows\install.ps1
.\scripts\windows\xiling-start.ps1
```

完整的数据布局、端口、沙箱和恢复策略见 [跨平台部署设计](docs/architecture/deployment.md)。

## 验证与开发命令

```sh
pnpm check          # 架构、Pi 兼容、类型、测试与统一 smoke 总门禁
pnpm architecture   # 模块边界 + 设计文档链接检查
pnpm pi:compat      # Pi 适配与上游兼容性检查
pnpm smoke          # 离线最短成功/失败路径
pnpm compliance     # 许可证、依赖完整性检查
pnpm sbom:generate  # 生成 SPDX/CycloneDX 相关清单
```

Runner 的离线闭环：

```sh
docker build -t xiling-runner:dev services/runner
docker run --rm xiling-runner:dev python smoke.py
```

所有自研模块都应使用固定 fixture，覆盖启动、最短成功路径、关键失败路径、取消和资源清理；新增能力必须补充 ADR、稳定接口和 smoke 测试。

## 仓库导航

```text
apps/web/                 React + TypeScript 产品界面
apps/server/              Fastify 组合根与领域 API
packages/contracts/       领域类型事实源
packages/context/         上下文投影、Capsule、缓存与组装
packages/pi-runtime/      Pi SDK、模型路由、Skill、MCP Host 适配
packages/agent-harness/   耐久 Agent Session/Run/Event 中枢
packages/multi-agent/     角色、TaskPacket、调度与 Handoff
packages/research-graph/  Research Graph 与 LadybugDB 适配
packages/science-domains/ 可审计科学领域 Manifest 与注册表
packages/knowledge/       SQLite/FTS5 知识存储
services/runner/          Python 科研计算与容器 Runner
scripts/                  smoke、架构、合规与跨平台脚本
docs/                     ADR、架构、Gate、测试与开源评估
DESIGN.md                 当前架构与产品决策的首要入口
```

## 设计与贡献约定

开始开发前请先阅读 [DESIGN.md](DESIGN.md)，再根据任务阅读相关 [ADR](docs/adr/) 和 [架构文档](docs/architecture/)。开源复用、许可证和替换边界记录在 [OSS 评估矩阵](docs/oss-evaluation.md)，第三方版权记录在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

提交代码前至少运行 `pnpm check`。任何跨模块依赖、数据所有权、Pi 兼容层、上下文装配或执行权限变化，都必须先更新设计文档/ADR，并补充相应的离线 smoke。

## 状态与边界

这是个人研究者优先的本地 Beta 候选，不是云端多租户协作平台。模型生成的科研代码不会在 Windows Host 原生执行；R、SSH/Slurm、多人协作、中国受限数据源、Windows ARM 和签名/WinGet 正式安装包仍是后续工作。真实 Windows 11 + Docker Desktop 专机验收完成前，不应将本仓库视为生产发布版。
