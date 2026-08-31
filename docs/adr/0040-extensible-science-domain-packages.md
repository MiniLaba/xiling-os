# ADR 0040：通用科研内核与可安装领域包

- 状态：已接受并实现基础设施
- 日期：2026-08-27
- 原编号：0033（因历史文件编号冲突，于 2026-08-31 仅重编号，决策内容未改变）

## 背景

汐灵 OS 以物理海洋与气候研究率先验证闭环，因此早期数据切片工具、部分角色和系统提示直接包含海洋语义。Research Graph、Evidence、Artifact、Wiki、Agent Harness 与审批本身是跨学科机制；若继续把生物、化学、天文或地学能力直接追加到这些核心模块，工具 schema、提示、依赖和数据模型会迅速耦合，且无法维持按需上下文。

## 决策

1. 产品定位为面向广泛科学领域的通用科研操作系统；海洋与气候只是当前优先完成的官方领域模块，不构成产品学科边界。
2. `@xiling/science-domains` 提供 Pi 无关、执行器无关的 `ScienceDomainManifest` 与注册表。
3. `general-science` 永远参与项目组合，提供证据、复现、文献、审查与通用科研规则；`ocean-climate` 与 `tabular-experiment` 是按项目启用的领域模块，前者当前优先完善。
4. Project 显式保存 `domainIds`。Agent 每轮只解析当前项目的领域包，并据此装配提示片段、Capability Catalog 和子智能体角色。
5. 领域清单可贡献能力元数据、角色、连接器类型、Artifact 类型和 Schema namespace，但不能携带可执行代码或自动获得权限。
6. 工具实现必须由 Server 组合根显式注册 adapter；下载、计算、外部写入和科研事实接受继续经过既有审批。
7. Research Graph 核心实体与溯源关系保持跨学科稳定；领域特有字段进入 namespaced properties 或经 ADR 晋升为稳定核心类型。
8. Skill、MCP 与领域包相互独立：领域包只提供匹配元数据，正文/schema 仍按当前任务惰性加载。

## 后果

- 新学科不需要 fork Agent Harness、Context Broker、Research Graph 或 Wiki。
- 项目不会获得未选择领域的工具和角色，天然减少上下文与权限面。
- 安装新的领域包仍需许可证、安全、fixture、adapter 和 smoke 审核；Manifest 不是插件执行沙箱。
- 海洋 Workflow 是官方领域 adapter；表格实验直接复用通用 ExecutionCoordinator，证明新增领域无需复制执行内核。
