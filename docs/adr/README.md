# 架构决策记录（ADR）

本目录保存汐灵 OS 的重要架构决策。ADR 解释决策背景、选择、备选方案和后果；当前系统全貌仍以根目录 [`DESIGN.md`](../../DESIGN.md) 为准。

## 状态约定

- **提议**：尚未成为实现约束。
- **已接受**：当前有效，应由代码和测试落实。
- **已接受并实现**：主要路径已落地，但仍可能有明确发布门禁。
- **已替代**：保留用于追溯，不得作为当前实现依据；必须链接替代 ADR。
- **已废弃**：不再适用且没有直接替代方案。

## 编号与文件规则

1. 文件名使用四位递增编号与小写连字符，例如 `0041-example-decision.md`。
2. 编号一经提交不得复用；发现重复编号时保留时间较早者，另一项使用新编号。
3. 标题、状态和日期放在文件顶部。
4. 替代旧 ADR 时不删除旧文件，在旧文件中注明替代者，并在新 ADR 中说明取代范围。
5. ADR 不保存大段代码或字段定义，引用 package 公开接口和测试事实源。

## 当前关键决策

| 范围 | ADR |
| --- | --- |
| Agent/Pi | [0001 嵌入 Pi SDK](0001-embed-pi-sdk.md)、[0022 研究 Agent Harness](0022-research-agent-harness.md)、[0023 Pi 升级兼容](0023-pi-upgrade-and-package-compatibility.md) |
| Context/能力 | [0005 上下文经济](0005-context-economy.md)、[0019 Context Assembler](0019-context-assembler-and-lazy-skills.md)、[0024 隔离 MCP Host](0024-isolated-pi-mcp-host.md) |
| Research Graph | [0025 图数据库](0025-research-graph-database.md)、[0027 耐久投影](0027-durable-research-graph-projection.md)、[0028 画布布局与局部上下文](0028-scientific-canvas-layout-and-context.md)、[0030 Claim/Evidence 来源解析](0030-claim-evidence-source-resolution.md) |
| 多智能体 | [0032 受控 Pi 多智能体](0032-controlled-pi-multi-agent-orchestration.md)、[0036 隔离 Handoff](0036-isolated-multi-agent-handoffs.md) |
| 科研内核 | [0034 内容寻址 Artifact](0034-content-addressed-artifact-registry.md)、[0035 通用执行与领域组合](0035-generic-execution-and-domain-composition.md)、[0040 可安装科学领域包](0040-extensible-science-domain-packages.md) |
| 模型 | [0015 多模态模型连接器](0015-extensible-multimodal-model-connectors.md)、[0037 真实模型路由与角色覆盖](0037-real-model-routing-and-role-overrides.md) |
| 平台 | [0039 原生 Windows 与 Docker 沙箱](0039-native-windows-control-plane-and-docker-sandbox.md) |

## 已替代的主要决策

- [0002 Windows WSL2 后端](0002-windows-wsl2-backend.md)已由 [0039](0039-native-windows-control-plane-and-docker-sandbox.md)替代。
- [0038 GitHub CI 与 WSL2 边界](0038-github-ci-wsl2-boundary.md)中的当前平台结论已由 [0039](0039-native-windows-control-plane-and-docker-sandbox.md)替代。

完整历史按文件编号浏览。若 ADR 状态与实现明显不符，应先修正文档并补充验证，不应静默绕过。
