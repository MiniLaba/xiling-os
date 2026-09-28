# ADR 0036：隔离子智能体与结构化 Handoff

- 状态：已替代，2026-09-27。内置子智能体退出主路径，见 [ADR 0044](0044-pi-native-harness-and-four-entries.md)。
- 日期：2026-08-28

## 背景

科研多智能体的价值来自独立检索、竞争假说、执行审计和盲审，而不是复制父会话。若子智能体继承项目全文、兄弟输出或任意读取工具，所谓盲审失效，也会造成上下文膨胀和越权读取。

## 决策

1. 每个子任务使用独立 Session 和显式 `ContextManifest`；`blind` 与 `execution` 模式不继承项目标题、研究问题、父/兄弟历史或科研图邻域。
2. 子智能体只能读取 Manifest 声明的 `sourceUris`。工具调用和返回 Handoff 中的受管 URI 都再次校验 allowlist。
3. Handoff 是严格 JSON 对象，只允许 `summary`、`sourceUris`、`artifactUris`、`limitations`；禁止用正则从自然语言猜测结构化结果。
4. 调度器强制最大持续时间、工具调用数、成本、并发数和父级取消传播；子智能体禁止递归委派。
5. 子结果是候选输入，进入 Wiki、Research Graph 或正式科研结论前仍经过 proposal/approval。

## 验收

离线测试覆盖隔离上下文、禁止的项目/Artifact 读取、额外字段和 prose Handoff 拒绝、超时、预算、父级取消以及允许来源的成功 Handoff。

