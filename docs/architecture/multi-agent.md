# 多智能体科研编排架构

## 1. 责任边界

```text
Research Director (durable root run)
  -> delegate_research_tasks (lazy meta tool)
  -> MultiAgentOrchestrator (Pi-independent)
      -> AgentRoleRegistry
      -> ContextManifest / TaskPacket
      -> bounded scheduler
      -> isolated child Agent Sessions
  -> structured Handoff
  -> synthesis / proposal / user approval
```

Pi Agent Core 负责每个 Agent 内部的模型与工具循环、事件和取消。`ResearchAgentHarness` 负责所有父子 session/run 的耐久运行事实。`MultiAgentOrchestrator` 只负责任务级编排，不拥有 Wiki、Evidence、Workflow、Artifact 或 Research Graph 科研事实。

## 2. 委派策略

委派必须具备可独立验收的输出契约，并至少满足一项：两个以上独立任务前沿；盲审价值；不同工具/权限边界；主上下文可自然拆为 TaskPacket。简单问答、紧耦合连续推理、最终综合、用户审批和科研事实接受不委派。

模型只能提出委派；宿主校验角色、任务数、依赖、预算、权限和未决审批。首版单层、最多并发 3、每个父任务最多 6 个子任务。

角色目录保持最小：Research Explorer、Domain Executor、Independent Reviewer。宿主再按本轮意图只把命中的角色写入委派工具 schema；证据、复现、方法和反方审查以动态 rubric 表达，不增加常驻 Agent。领域 Manifest 贡献提示、能力和工具，不复制“海洋分析员”“统计方法员”等人格。

## 3. 上下文协议

`ContextManifest` 只记录项目、项目简报版本、显式科研实体、受管来源 URI 与 projection hash。子 Runtime 重新通过 Context Broker 解析该清单，不复制父对话历史。每个子 session 独立压缩，完整输出保留在 Agent Store；父 Agent 只接收结构化摘要、来源、Artifact、局限与 usage。

Blind Reviewer 可以读取待审 Claim/Run 及其证据，但不能读取主 Agent 的偏好性解释和兄弟 Agent 输出。Execution isolation 还要求 Runner/容器和 capability token。

## 4. 存储

`agent-center.sqlite` schema v5 新增 `agent_delegations`，保存 root/parent run、child session/run、role、isolation、ContextManifest hash、budget、status、result 和错误。既有 `agent_sessions`、`agent_runs`、`agent_entries`、`agent_usage` 和 `agent_compactions` 继续保存子运行本身。

取消从父工具的 `AbortSignal` 级联到子 Harness Run。子预算通过 run context 下沉到 Harness，并取系统全局限制与子限制中的较小值。

## 5. 图和产品投影

Agent Execution Graph 增加 `delegation` 节点与 `delegated` 边。Chat 的低密度画布显示主 Prompt/Response、一个子任务卡和子 Prompt/Response；Model、Tool、Result、Usage 仍折叠。

Research Graph 不加入 Delegation 节点。被接受的子结果通过原有投影生成 `Actor ASSOCIATED_WITH ResearchRun`、Evidence、ArtifactVersion 或 ReviewReport。这样 Agent 工作方式和科研事实仍是两张图。

## 6. Pi 兼容

上游 subagent 的 single/parallel/chain 行为用于兼容回归；运行时不加载任意第三方 Extension。角色定义允许后续导入经审计的 Pi Markdown/YAML 元数据，但 system prompt、工具权限与动态角色仍需宿主校验。Pi 升级只修改 `@xiling/pi-runtime` 与兼容测试。

## 7. 后续阶段

- MA-3：将动态 Evidence/Reproducibility/Methods rubric 与 proposal/Runner 结果契约进一步结构化连接。
- MA-4：允许用户从经审计基础角色 + 领域 Skill + capability allowlist 创建一次性动态角色。
- MA-5：模型多样性、盲审相关性评测、真实 Windows + Docker 负载与恢复验证。
