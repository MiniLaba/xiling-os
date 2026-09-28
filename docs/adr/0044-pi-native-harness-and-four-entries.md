# ADR 0044：Pi 原生 Harness、四入口与 Brain/Bot 边界

- 状态：已接受
- 日期：2026-09-27
- 替代：ADR 0022 中“自研双层循环是运行中枢”的决定；ADR 0036 的内置子智能体主路径

## 背景

Pi 0.84.2 的 `AgentHarness.prompt` 会抛出 `HarnessNotImplemented`，所以汐灵当时用 `ResearchAgentHarness` 加低层 `Agent` 组成两层循环，并用内置子智能体做委派。产品入口也因此拆成对话、关注、画布、项目、Wiki 和文献。

## 决策

1. `@xiling/pi-runtime` 将 `pi-agent-core`、`pi-ai`、`pi-coding-agent` 锁定为 0.87.1。正式在线对话走 Pi 原生 `AgentHarness` 的 lane `prompt`；离线测试仍可注入低层 `Agent` 的伪流。业务包不得直接 import Pi。
2. `ResearchAgentHarness` 只保留项目绑定、审批、SSE 转发和科研事实写入，不再成为第二套模型循环。Claim、Evidence、Run、Artifact 仍在领域库，不写入 Pi Session。
3. 每个项目只保留一条长对话。再次创建会返回这条对话，旧会话的用户/助手消息并入其中，之后不能删除。
4. 内置 `delegate_research_tasks` 和 `MultiAgentOrchestrator` 退出主路径。以后的子能力只作为 MCP Server 接入。
5. 顶栏只保留 Chat、Brain、Bot、Settings。笔记、文献和邻域图合成 Brain。Brain 提供搜索、读取来源、保存笔记、建立关系；Agent 通过这些工具或 Brain MCP 访问，不直接写 Ladybug 或 Wiki 表。会改变正式 Claim / Evidence 的关系进入 Bot 的待决定队列。
6. Bot 用 Pi 规划，执行目标只在本机、已配置 SSH 和虚拟机之间选择。选择虚拟机时，Bot 在页面内嵌入只发布到 127.0.0.1 的桌面窗口；这台桌面与一次性科研沙箱分开。OpenManus 只提供执行边界，不能绕过审批修改正式结论或下载大规模数据。
7. 模型选择仍走 `ModelRuntimeStore` / `createLiveRoute`。手动模式固定主模型；自动模式只在用户指定的提供商里选择，满足本轮输入模态且不超过费用上限，回复标明实际模型。后台运行单独开关：仅当有未完成任务且处于设定时段内才继续，空闲队列不调用模型。

## 后果

- 升级 Pi 必须继续通过 `pnpm pi:compat`，三个包保持同版本。
- 子智能体测试和设置页不再代表当前主路径。
- 科研画布、Wiki 和文献工作台成为 Brain 内部面板，项目管理成为设置中的一节。
