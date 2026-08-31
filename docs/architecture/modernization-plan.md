# 架构现代化执行状态与历史计划

> 状态核对：2026-08-31。本文保留 R0–R8 的执行背景和验收状态；当前架构事实以根目录 [`DESIGN.md`](../../DESIGN.md) 为准。Canvas/科研事实与持久化部分已由 [ADR 0025](../adr/0025-research-graph-database.md)、[ADR 0026](../adr/0026-agent-execution-graph-in-chat.md)、[ADR 0027](../adr/0027-durable-research-graph-projection.md) 和 [Research Graph 架构](research-graph.md)替代。当前开发期不迁移旧数据，也不保留双写兼容。

## 评估结论

原 Gate 计划正确建立了产品闭环、审批、容器、跨平台和上下文经济原则，但“按 Gate 追加功能”的实现方式已经不适合继续扩展。主要风险是：单一 Server 文件承载过多领域、前后端重复协议、JSON 画布并发覆盖、SQLite 无显式迁移、KnowledgeService 暴露面过宽，以及开发时 workspace 源码/产物混用。

本轮选择模块化单体，不改成微服务。原因是汐灵仍是本地优先的个人科研工作台，拆服务会增加跨平台安装、端口、升级和故障诊断成本，却不能解决现阶段的边界问题。

## 执行阶段

1. **构建边界**：workspace 包在运行时只暴露 `dist`；开发先构建再并行 watch；增加依赖方向门禁。
2. **共享协议**：建立 `api-contracts`，前后端共享 Zod 契约；统一 JSON 客户端与 SSE 解码。
3. **服务端模块化**：按 workspace、literature、research-graph、connectors、workflows、settings、MCP 与 agent-center 注册路由；旧 Canvas 与 Gate 3 产品路由/聚合包已删除，`app.ts` 只保留装配和跨模块 Agent/投影编排。
4. **持久化可靠性**：Knowledge 数据库使用版本迁移和窄 ports；Scientific Canvas 布局使用独立 SQLite 与 revision，科研事实使用 Research Graph。
5. **上下文机制纠偏**：使用用户选择的 Research Graph 活动实体、有限两跳邻域、显式引用、Capsule、按需 Skill/tool、组装缓存和 TokenLedger；不把循环科研图当成对话树，也不引入正常任务固定 token 上限。
6. **回归门禁**：新增 API 契约、SSE 分片、迁移版本、画布并发与架构依赖测试；运行全量 typecheck/test/build/smoke/compliance。

## 2026-08-28 R0–R8 收口状态

本节是现行执行清单；上面的旧 Gate 修订保留决策背景，不再用 Gate 编号组织代码。

| 阶段 | 状态 | 已完成的可验证结果 | 尚未满足的边界 |
|---|---|---|---|
| R0 架构宪法与黄金任务 | 完成本地验收 | 三图分离、单一事实源、领域中立、Pi 边界和上下文经济成为自动门禁 | 无 |
| R1 组合根与遗留清理 | 完成本地验收 | 正式 API 使用 `/api/v1`；Chat 只有 Agent Store；运行数据目录改为 `workspace`；领域安装集中在单一组合点 | 历史测试脚本名只作验收记录，不是产品 API |
| R2 Artifact Registry | 完成本地验收 | SHA-256 URI、项目隔离、分段读取、完整性、生命周期、Workflow 导入和 Web Viewer | 发布备份/垃圾回收策略仍需真实数据规模验证 |
| R3 通用执行内核 | 完成参考纵向切片 | Plan/Spec/Approval/Receipt、SQLite 幂等、超时/取消；表格领域端到端使用 | 海洋 Workflow 仍是领域适配器，后续向 Execution port 收敛；真实容器 digest 未验收 |
| R4 上下文质量 | 完成本地验收 | token 组成、来源覆盖、重复历史合并、按需 Skill/tool/MCP、证据 locator 缺口可见 | 真实模型的长任务质量/成本回归需独立凭据验收 |
| R5 多智能体隔离 | 完成本地验收 | 独立 Session、Manifest allowlist、严格 JSON Handoff、工具/时间/成本预算、父取消 | 真实 Provider 并发与限流需凭据验收 |
| R6 Attention UX | 完成代码与集成测试 | 审批、失败、证据缺口、待审提案和 Agent 异常聚合到“需要关注” | 发布前仍需正式可用性走查 |
| R7 第二科学领域 | 完成参考纵向切片 | 表格实验 Manifest、CSV/TSV 导入、统计 Recipe、Viewer 描述、失败测试和 Artifact 输出 | 安装/禁用/升级 UI 仍是后续插件化能力 |
| R8 发布级验证 | 部分完成 | 确定性离线检查全部通过；macOS arm64 上构建固定基础镜像并以 `--network none` 通过基础、Argo 和四连接器 smoke | 真实 Windows 11 + Docker Desktop、签名安装介质和真实科研任务仍是发布阻塞项 |

收口规则：本地测试通过不能替代 R8 外部环境验证；同样，R8 的平台工作不能反向引入领域分支、双写或把大 payload 放回上下文。

## 对旧计划的修订

- Gate 1–4 不再作为代码目录的长期架构；它们只保留为产品验收记录。
- `Gate3ResearchService`、旧 `/api/gate3/*` 与旧 ResearchView 已删除；`ProjectWorkflowService` 是唯一科研闭环。
- “SQLite/Drizzle”修订为“SQLite + 明确 Repository/Port 边界”。当前实际适配器使用 Node SQLite；在没有迁移收益前不强行引入第二套 ORM。
- 旧 Canvas 项目图文档已经删除；Scientific Canvas 是 Research Graph 的表现投影，布局保存不能伪装成科研事实版本史。
- 固定 token 数字只保留为安全和模型窗口保护；优化目标是上下文拓扑、去重、按需加载与可观测性。
- Gate 5 源码候选与本地架构收口已完成；[Gate 4.5](../gate-4.5-agent-center-correction.md) 已把短命 Agent、前端结果持久化、Compaction 和旧 Canvas 来源截断问题收拢到服务端 Research Agent Harness。后续不再设置普通开发确认点，真实 Windows + Docker、签名和外部发布权限仍按发布门禁处理。

## Gate 4.5 补充阶段（历史）

1. **事实验证**：核对固定 Pi 版本的 Agent、Session、Compaction 与 Harness 实际能力，不按目标文档假设实现已经可用。
2. **服务端中枢**：建立耐久 session/run/operation、单写者、snapshot/event subscription、取消与恢复。
3. **双层上下文**：Pi Compaction 管理对话和工具轨迹；Scientific Capsule 管理科研语义和证据引用。
4. **无损引用**：Canvas 展示摘要通过 source entry 引用完整消息，不复制截断正文作为事实源。
5. **主路径切换**：Web 不再持久化 Agent 结果或编排工具业务状态；迁移必须先 dry-run、备份并经用户确认。

本节解释 Agent 中枢形成过程，不是当前迁移要求。当前实现和数据所有权以 DESIGN 为准；详细历史确认点见 Gate 4.5 文档。

## 完成标准

- 架构依赖门禁通过；共享包可独立构建。
- Chat、画布、项目、Wiki、文献、连接器与 Workflow 现有集成测试不回退。
- 并发画布更新不会静默覆盖；开发期已删除的数据格式不保留兼容读取或双写。
- 文档中的类型、主闭环和发布状态与代码一致。
