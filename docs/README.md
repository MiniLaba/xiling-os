# 汐灵 OS 文档导航

本目录记录汐灵 OS 的当前架构、决策依据、质量门禁和历史验收。文档按“事实层级”组织，避免旧计划覆盖当前实现。

## 文档事实层级

发生冲突时按以下顺序判断：

1. **代码公开接口与自动化测试**：描述系统实际行为。
2. **根目录 [`DESIGN.md`](../DESIGN.md)**：当前产品和架构的首要说明。
3. **有效 ADR**：记录为什么选择当前方案，以及哪些旧方案已被替代。
4. **专题架构文档**：展开 DESIGN 中的模块、数据流和约束。
5. **质量与测试文档**：定义验收任务、失败条件和平台矩阵。
6. **Gate / Spike 文档**：历史计划、调查和阶段验收，只用于追溯。

历史文档中的数字、平台边界或状态可能已经过期。不得仅依据旧 Gate 恢复被删除的兼容层。

## 新参与者阅读路径

1. [`README.md`](../README.md)：产品是什么、怎么运行、当前边界。
2. [`DESIGN.md`](../DESIGN.md)：系统所有权、不变量、关键流程和风险。
3. [科研内核架构宪法](architecture/research-os-constitution.md)：不可破坏的设计约束。
4. [模块化单体架构](architecture/modular-monolith.md)：包、Server 模块和依赖方向。
5. [领域模型](architecture/domain-model.md)：Project、Evidence、Run、Artifact 等对象的语义。
6. [汐语灵境设计系统](design-system.md)：UI/交互的唯一参照规范与设计令牌。
7. 根据任务阅读下方专题和对应 ADR。

## 当前架构专题

| 主题 | 文档 | 回答的问题 |
| --- | --- | --- |
| 界面设计 | [汐语灵境设计系统](design-system.md) | UI 令牌、术语、布局、组件与两个图视图的交互规范是什么？ |
| 模块边界 | [模块化单体架构](architecture/modular-monolith.md) | 哪个包拥有哪项职责，依赖可以指向哪里？ |
| 科研对象 | [领域模型](architecture/domain-model.md) | Project、Claim、Evidence、Run、Artifact 如何关联？ |
| Research Graph | [科研图架构](architecture/research-graph.md) | 科研事实、证据链、溯源和画布投影如何保存？ |
| 上下文工程 | [上下文经济架构](architecture/context-budget.md) | 如何按需选择来源、Skill 和工具并避免上下文膨胀？ |
| 多智能体 | [多智能体科研编排](architecture/multi-agent.md) | 何时委派、如何隔离上下文、怎样 Handoff？ |
| 科学领域 | [科学领域扩展架构](architecture/science-domains.md) | 新学科怎样复用通用内核并接入能力？ |
| Pi 兼容 | [Pi Package 兼容策略](architecture/pi-package-compatibility.md) | Pi 如何升级，Package 哪些能安全接入？ |
| 部署与安全 | [跨平台部署设计](architecture/deployment.md) | macOS/Linux/Windows 如何运行，Docker 沙箱保护什么？ |
| 现代化状态 | [架构现代化计划](architecture/modernization-plan.md) | 已完成哪些现代化阶段，哪些仍是发布门禁？ |

## 架构决策记录

[`adr/`](adr/) 保存 Architecture Decision Record。新增或替代决策前先阅读 [ADR 索引与维护规则](adr/README.md)。重要当前决策包括：

- [嵌入 Pi SDK](adr/0001-embed-pi-sdk.md)
- [上下文经济](adr/0005-context-economy.md)
- [项目科研 Workflow](adr/0018-project-research-workflow-orchestrator.md)
- [研究 Agent Harness](adr/0022-research-agent-harness.md)
- [隔离 Pi MCP Host](adr/0024-isolated-pi-mcp-host.md)
- [Research Graph 数据库](adr/0025-research-graph-database.md)
- [Agent Execution Graph 归入 Chat](adr/0026-agent-execution-graph-in-chat.md)
- [科研画布布局与局部上下文](adr/0028-scientific-canvas-layout-and-context.md)
- [隔离子智能体与结构化 Handoff](adr/0036-isolated-multi-agent-handoffs.md)
- [真实模型路由与角色覆盖](adr/0037-real-model-routing-and-role-overrides.md)
- [原生 Windows 控制面与 Docker 科研沙箱](adr/0039-native-windows-control-plane-and-docker-sandbox.md)
- [可安装科学领域包](adr/0040-extensible-science-domain-packages.md)
- [两栏应用壳与 Chat 上下文产物面板](adr/0041-two-column-shell-and-contextual-artifact-panel.md)

## 质量、测试与合规

- [黄金科研任务与质量基线](quality/golden-research-tasks.md)：端到端科研真实性标准。
- [Smoke 测试矩阵](testing/smoke-matrix.md)：模块最短成功路径和关键失败路径。
- [OSS 评估矩阵](oss-evaluation.md)：依赖许可证、维护状态、复用与淘汰原因。
- [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md)：第三方版权和版本声明。

常用门禁：

```sh
pnpm docs:check
pnpm architecture
pnpm check:offline
pnpm check
```

## 历史与原型

- `gate-1-review.md` 至 `gate-5-review.md`：阶段验收记录。
- `gate-4.5-agent-center-correction.md`：Agent 中枢纠偏过程。
- `spikes/`：Pi、Agent Center、上下文迁移和主路径所有权调查。
- `prototypes/`：早期交互与视觉规范。

这些文件可以解释设计演进，但不得作为新增兼容代码的理由。当前实现已删除的 Gate API、旧 Canvas、Knowledge Chat 副本或 WSL2 应用后端，不应从历史文档恢复。

## 贡献与文档维护

### 何时必须更新 `DESIGN.md`

- 新增、删除或重新归属 Server/领域模块；
- 改变包依赖方向、核心对象所有者或持久化位置；
- 改变 Agent loop、Compaction、上下文装配、Skill/MCP 激活；
- 改变 Workflow、审批、Runner、凭据或网络信任边界；
- 改变 macOS/Linux/Windows 部署和数据目录；
- 接受、替代或废弃 ADR。

### 何时新增 ADR

- 方案有两个以上合理选项；
- 决策会形成长期兼容或迁移成本；
- 引入新的数据库、运行时、协议或安全边界；
- 自研替代成熟开源方案；
- 需要替代此前已接受的设计。

ADR 只解释决策，不复制字段级接口。被替代的 ADR 保留文件，在顶部明确“已替代”和替代者。

### 完成定义

文档声明、代码存在和 UI 演示均不等于完成。一个自研能力至少需要：

1. 明确所有者和稳定接口；
2. 固定离线 fixture；
3. 最短成功路径、关键失败路径、取消/清理测试；
4. 与风险相称的重启、并发、权限或平台验证；
5. DESIGN、ADR、OSS/第三方声明按影响同步更新。

无法运行的真机、容器或公网测试必须标记为“未验收”，不得写成通过。
