# ADR 0022：Research Agent Harness 与 Pi 内核边界

## 状态

**已替代，2026-09-27。** 由 [ADR 0044](0044-pi-native-harness-and-four-entries.md) 取代“自研 ResearchAgentHarness 为模型循环中枢”的部分。领域事实仍然不进入 Pi Session。

## 背景

本 ADR 立项时，汐灵直接使用 Pi `Agent` 执行单次 HTTP 请求内的模型与工具循环，Chat 消息、工具结果投影和运行状态分散在 Web、Server 与进程内对象中。Gate 4.5-D 后，正式 Chat/Canvas 已迁移到耐久 `ResearchAgentHarness`；本段保留为决策背景。

固定依赖 `pi-agent-core@0.84.2` 已导出 Agent、Session、Compaction 和 AgentHarness 类型；其中低层 Agent、Session primitives 和 Compaction functions 可评估复用，而该版本 `AgentHarness` 的主要运行操作尚不能直接作为正式产品中枢。

## 提议决策

1. 新增服务端 `ResearchAgentHarness` 作为唯一 Agent 运行所有者。
2. 保留 Pi Agent Core、provider、工具循环、事件、取消、Skill、Compaction primitives、Session/Entry 语义和 telemetry。
3. Project、Canvas、Wiki、Evidence、Workflow、Approval、Runner 和 Artifact 继续由汐灵领域层拥有。
4. 对话 Compaction 与科研 Context Capsule 分层；任何摘要都不得成为原始证据的替代品。
5. Agent Session 记录执行事实，Canvas 记录科研组织语义，通过 source entry/run/domain URI 映射。
6. Web 降为 command/snapshot/event 客户端，不持久化 Agent 最终结果，不负责把工具事件转成业务状态。
7. Gate 4.5-A 先比较“当前 Pi primitives + 薄宿主协调层”和“经验证的新版 Pi Harness”；在二次确认前不冻结实现选择。
8. `ResearchAgentHarness` 只协调运行，不拥有 Canvas、Wiki、Evidence、Workflow 或 Artifact 的领域事实。
9. 引入 `SourceContentResolver`，按稳定 source entry/domain URI 回取完整来源；Canvas `body` 仅为可编辑展示摘要。
10. Canvas 与 Pi Session Tree 不做 1:1 镜像：位置、布局、手工语义边和投影删除不得改写追加式执行事实。
11. Wiki 继续是项目百科域；Agent 只能生成带 source/run/evidence 溯源的草稿或差异，发布必须经过用户确认。
12. 领域投影只能消费已持久化的 Agent Event；投影结果使用独立事件、稳定幂等键和启动 reconcile，不得在浏览器或 Pi Runtime 内隐式写业务状态。
12. 旧数据迁移保留既有 `messageId`、Canvas `body` 与领域主键，采用 dry-run、备份、dual-read、完整性核验和可回滚切换。

## 不变量

- 同一 Agent session 同时只有一个写入者。
- 接受的用户 prompt 必须先获得耐久 run identity，再发起 provider 请求。
- 完整 assistant message、tool call/result、usage 和终态由 Server 写入。
- 客户端断开不等于运行记录消失。
- 原始工具成功事件必须先落盘；Workflow projector 最多自动创建待审批 `draft`。
- 每次 provider 请求和工具继续回合都经过 compaction-aware context assembly。
- Canvas 展示文本不是消息事实源。
- Wiki/Canvas/Evidence 只按目录与检索命中进入上下文，不整体常驻注入。
- Source resolver 必须校验项目作用域、允许类型和读取上限。
- MCP 不在本 ADR 范围内。

## 备选方案

### 保持当前短命 Agent

拒绝。它无法可靠解决断线、崩溃恢复、多回合 usage、Compaction 和单写者问题。

### 直接把 Canvas 当 Pi Session Tree

拒绝。Canvas 是用户编辑的科研语义图，Pi Session 是追加式执行事实；合并两者会导致移动/摘要/编辑操作改变运行历史。

### 立即切换固定版本 AgentHarness

拒绝。必须先以实际 API 和恢复测试验证，而不能依据目标设计文档假设实现完成。

### Fork Pi

拒绝。优先使用上游公开内核、端口和存储接口，通过薄适配保持未来替换能力。

## 影响

- Server 将新增明确的 Agent 应用层，但不新增微服务。
- Knowledge/Agent Session 持久化需要迁移和旧数据映射。
- Chat/Canvas 前端会变薄，现有产品视图与领域对象可以保留。
- 现有 Canvas 自由组织与 Wiki 百科交互属于受保护的产品语义，不接受为适配 Harness 而降级。
- Gate 5 在 Gate 4.5 完成前继续暂停。

## 验证

验证与确认点以 [Gate 4.5](../gate-4.5-agent-center-correction.md) 为准。本 ADR 只有在 Gate 4.5-A 样例完成并经用户确认后才能改为“已接受”。

Gate 4.5-A 已验证固定版本的 Session/JSONL/Compaction primitives 可用，`AgentHarness` 运行操作不可用；Pi 官方 `0.84.3` 仍保持相同未实现边界。用户已确认不升级依赖，选择“0.84.2 primitives + 薄 `ResearchAgentHarness`”。详见 [隔离样例报告](../spikes/gate-4.5-a-pi-runtime.md)。Pi 升级与 Package 边界由 [ADR 0023](0023-pi-upgrade-and-package-compatibility.md) 约束。

Gate 4.5-B 已实现 Pi 无关的 `@xiling/agent-harness`、独立耐久 run store、单写者、可重放事件、取消/恢复、全回合 usage 和可审查 Compaction。4.5-C 已迁移正式 Chat/Canvas 与旧来源；4.5-D 已删除旧写路径并完成 durable-first Workflow 投影。详见 [4.5-B 报告](../spikes/gate-4.5-b-agent-center.md)、[4.5-C 报告](../spikes/gate-4.5-c-context-migration.md)和 [4.5-D 报告](../spikes/gate-4.5-d-main-path-ownership.md)。
