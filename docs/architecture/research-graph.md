# Research Graph 架构

## 1. 目标与边界

Research Graph 是项目科研事实、证据关系和计算溯源的唯一图事实源。它不保存 Agent 原始运行轨迹，不保存文献搜索临时结果，也不保存画布坐标。

三类图必须隔离：

| 图 | 事实源 | 产品入口 | 生命周期 |
|---|---|---|---|
| Agent Execution Graph | `agent-center.sqlite` | Chat 内“对话 / Agent 运行图” | 追加式执行事实 |
| Research Graph | `research-graph.lbdb` | 顶层科研画布、Wiki、上下文查询 | 版本化科研事实 |
| Literature Discovery Graph | Provider cache | 文献工作台 | 临时搜索/推荐结果 |

只有用户完成阅读标注并显式提升的论文与片段才能进入 Research Graph。移动画布节点只写布局仓储。

## 2. 模块结构

```text
apps/server (composition root)
  ├─ agent-center ─────────────── agent-center.sqlite
  ├─ research-graph module ────── ResearchGraphStore
  │                                  └─ LadybugResearchGraphStore
  │                                      └─ research-graph.lbdb
  ├─ workspace/wiki ───────────── knowledge.sqlite + outbox
  ├─ literature ───────────────── provider cache
  └─ workflows/runner ─────────── artifact filesystem + outbox

apps/web
  ├─ Chat / Agent Execution Graph
  ├─ Scientific Canvas projections
  └─ Literature workspace
```

`@xiling/research-graph` 不依赖 Server、Web、Pi、Runner 或具体页面。Server 是唯一组合根和唯一图写入者。

## 3. 实体模型

首版实体类型：

- 研究语义：`ResearchQuestion`、`Hypothesis`、`Claim`、`ClaimRevision`、`EvidenceAssertion`
- 文献与来源：`Paper`、`SourceFragment`
- 数据与执行：`Dataset`、`DatasetSnapshot`、`ResearchPlan`、`Approval`、`ResearchRun`
- 产物与审查：`Artifact`、`ArtifactVersion`、`LifecycleEvent`、`ReviewReport`
- 知识和主体引用：`WikiRevisionRef`、`Actor`

所有实体都必须包含 `id`、`projectId`、`kind`、版本、内容哈希和时间戳。数据库内部主键由 `projectId + id` 生成，允许不同项目安全使用相同本地 ID，所有关系端点也使用该项目作用域键匹配。外部标识符、DOI、页码、变量范围等作为类型化常用字段或 `properties` 保存，但不能用操作系统绝对路径充当 ID。

`ClaimRevision`、`DatasetSnapshot`、`ArtifactVersion`、`WikiRevisionRef` 是不可变版本实体。修订产生新节点并用 `SUPERSEDES` 连接旧版本，不原地改写已接受事实。

## 4. 关系 Schema

关系类型是数据库 Schema，不是 UI 颜色：

| 关系 | 含义 |
|---|---|
| `CONTAINS` | Project 或研究对象的显式包含关系 |
| `HAS_REVISION` / `SUPERSEDES` | 逻辑对象、版本与替代关系 |
| `HAS_FRAGMENT` / `CITES` | 论文片段与引用关系 |
| `BASED_ON` / `ASSERTS` | EvidenceAssertion 的来源和目标 Claim |
| `USED` / `GENERATED` / `DERIVED_FROM` | 计算输入、输出与派生 |
| `EVALUATES` | Reviewer 对 Run 或 Claim 的审查 |
| `HAS_VERSION` / `TRANSITIONED_BY` | Artifact 版本和生命周期事件 |
| `DOCUMENTS` | Wiki 修订所解释的科研对象 |
| `ASSOCIATED_WITH` | Run 与用户、Agent、工具或环境主体 |
| `REFERENCES` | 不改变事实语义的显式引用 |

支持、反驳、限定与证据不足不是四种裸边。它们是 `EvidenceAssertion.stance`，因为同一断言还必须承载来源定位、置信度、适用范围、创建者和审查状态。

## 5. 写入与审批

Research Graph 只接受结构化 `ResearchGraphChangeSet`：

1. 校验项目边界、实体类型、关系类型和字段范围。
2. 在同一个图事务中写实体和关系。
3. 任何端点缺失或项目不一致时整体回滚。
4. 生成内容哈希和确定性关系 ID，重复投影保持幂等。
5. 系统事实 projector 使用 durable source event 直接写入；Agent 生成的科研解释 ChangeSet 状态为 proposal，用户确认后才调用正式写入端口。

布局保存、自动整理和视口改变不经过科研事实审批，因为它们不写 Research Graph。

## 6. 查询投影

科研画布不下载整张图再自行猜关系。服务端提供受界限投影：

- `all`：项目总览；
- `literature`：Paper、SourceFragment、EvidenceAssertion、Claim；
- `evidence`：Claim 的支持/反驳/限定证据；
- `provenance`：DatasetSnapshot → Run → ArtifactVersion → Review；
- `artifacts`：Artifact 版本和生命周期。

当前只读 API 与后续写入 API 形态：

```text
GET  /api/projects/:projectId/research-graph?view=...
GET  /api/projects/:projectId/research-graph/artifacts/:artifactVersionId/lineage
POST /api/projects/:projectId/research-graph/proposals
POST /api/projects/:projectId/research-graph/proposals/:id/decision
```

模型不能提交任意 Cypher。Agent 使用稳定的 `query_research_graph` 元工具，参数只允许项目、焦点实体、视图、关系白名单、深度和返回上限。

## 7. 上下文经济

Research Graph 的价值之一是从机制上减少上下文：

```text
当前 Agent 分支
  + 用户显式选择的科研实体
  + Research Graph 1–2 跳局部邻域
  + 内容寻址的 Capsule/Artifact 引用
```

完整论文、PDF、NetCDF、日志和整张图不会进入模型。查询返回实体摘要、关系、来源 URI 与哈希；需要正文时再通过 Source Resolver 按需读取。Graph Capsule 是带查询参数和图修订哈希的派生缓存，不是证据源。

## 8. 一致性与恢复

- Server 持有单一可写 Ladybug `Database` 对象；写连接和读连接都从该对象创建，禁止第二个进程同时打开同一文件。
- 图写入通过应用级单写队列串行进入事务；读查询使用独立连接，避免与长 ChangeSet 共用事务状态。
- Agent、Knowledge、Workflow 与 Research Graph 之间不承诺跨库 ACID。Knowledge schema v2 与 `project-workflows.sqlite` 在源状态同一事务中写 durable outbox；Agent 复用追加式 `agent_events`。
- `ProjectionLedger` 与科研节点/关系在同一 Ladybug 事务内提交。稳定 projection key 内容冲突会被拒绝；相同事件重放返回 no-op。
- 启动 reconcile 重放未确认 outbox；科研图查询前也进行有界 reconcile，关闭两个典型崩溃窗口：源已提交/目标未写、目标已提交/源未确认。
- Ladybug 使用 WAL 和 Checkpoint；备份必须先暂停图写入、Checkpoint、关闭数据库，再复制数据库与 WAL，不允许应用运行时直接复制活跃文件。
- 异常退出后必须能够重放已提交 WAL；未提交事务不能出现部分实体。

## 9. Windows 与发布

Windows 11 原生加载 `@ladybugdb/core-win32-x64`，数据库位于 `%LOCALAPPDATA%\XiLingOS\workspace`，不得放在 OneDrive 或网络共享。PowerShell Doctor 检查数据目录、磁盘与可写性；macOS Apple Silicon、Linux x86_64 和 Windows x86_64 都必须运行同一离线 smoke。

## 10. RG-0～RG-5 验收

当前已自动覆盖：

- 固定 18 节点/20 关系海洋科研 fixture；
- 支持与反驳证据同时存在；
- Artifact → Run → 输入/Reviewer 反向溯源；
- 无效关系端点导致整个 ChangeSet 回滚；
- Checkpoint、关闭、重开；
- 已提交事务在进程非优雅退出后的 WAL 恢复；
- 依赖边界、MIT 许可和 SBOM 扫描。

RG-1 已把 Agent Execution Graph 切入 Chat，且不写 Research Graph。RG-2 已在本地完成：Knowledge/Workflow durable outbox、Agent event replay、目标 applied ledger、启动/查询 reconcile、Workflow JSON → SQLite，以及 Project、ResearchQuestion、Paper/SourceFragment、WikiRevisionRef、Plan/Approval、Dataset/Snapshot、Run、Artifact/Version、Review、Lifecycle 与 Agent Actor 的类型化投影。旧的 Workflow → ProjectItem/Wiki/Canvas 文件级 settlement 已删除。

RG-3 已接入顶层 Scientific Canvas：五种受限投影、自由拖动、纵向语义自动布局、曲线关系、搜索/详情/图例，以及独立 `scientific-canvas-layout.sqlite`。布局以项目和视图隔离并使用 revision 乐观并发，投影外实体不能写入布局。用户显式把实体设为 Chat context 后，Context Broker 只组装该实体、确定性的两跳有限邻域、显式引用、Capsule 与 Artifact URI，不读取整张图，也不再读取旧 Canvas。

RG-4 已完成文献闭环：真实 Provider 摘要、原文入口、阅读标注、原文摘录、精确定位、解释、局限、立场和置信度随 Evidence 捕获记录持久化；同一论文可产生多条证据。Knowledge outbox 投影 `Paper HAS_FRAGMENT SourceFragment`、`EvidenceAssertion BASED_ON SourceFragment`、`EvidenceAssertion ASSERTS ClaimRevision` 与 `EvidenceAssertion EVALUATES ResearchQuestion`。Claim 新建/修订先生成待审 proposal，用户接受后才写入不可变 ClaimRevision。

RG-5 本地架构与体验收口包括：旧 Canvas/Gate 3 产品面删除，Wiki 读统一项目概览与 Research Graph，科研画布提供自由拖动、纵向层级整理、一跳聚焦、关系筛选和来源跳转；文献发现图保持临时，只有显式证据捕获进入科研图。Hosted Linux/macOS/Windows CI 在源码候选提交后复验；真实 Windows 11 + Docker Desktop 仍是正式 Beta 发布门禁。
