# 汐灵 OS 黄金科研任务与质量基线

> 这些任务用于验证科研 OS 的端到端正确性，不是 UI 演示脚本。所有场景必须有固定离线 fixture；公网 Provider 只作为额外验收。

## G1：证据到主张

用户从文献工作台选择论文片段，保存精确摘录、定位、解释、局限和立场，提出或修订 Claim，并在科研画布中追踪：

`Paper → SourceFragment → EvidenceAssertion → ClaimRevision`

验收：

- 原文、用户解释和 Agent 摘要有不同来源等级。
- Claim 发布前必须存在 proposal。
- 同一论文可支持多个不同 ClaimRevision。
- 任何缺少 locator 的“精确原文”被拒绝。

## G2：审批式数据获取

Agent 产生数据切片计划，系统展示变量、空间、时间、深度、预计体积、许可和目标目录。用户只批准当前计划哈希，下载后形成 DatasetSnapshot Artifact。

验收：

- 未审批不能下载。
- 修改任一范围后旧 Approval 失效。
- 重试不产生重复下载或重复 Artifact 版本。
- 取消与重启后的状态明确且可恢复。

## G3：可复现计算

以固定输入执行计算并生成图表和报告。

验收：

- 保存输入 Artifact、代码快照、参数、随机种子、环境 digest、资源/网络策略和输出清单。
- 相同规范产生可比较的结果哈希。
- 修改代码、参数或环境产生新 Run/ArtifactVersion，不覆盖旧版本。
- Reviewer 结果和限制可从 Artifact 反向追踪。

## G4：上下文经济与来源完整性

项目包含多条对话、多个科研分支、重复引用的 Artifact、大 Wiki 和无关 Skill/MCP。

验收：

- 当前活动实体、有限邻域和显式引用进入 ContextPlan；兄弟子图和 Agent Execution Graph 不进入。
- 相同 Artifact payload 不重复发送。
- 未命中 Skill/MCP/tool schema 不进入模型请求。
- 超出窗口时先使用 Capsule 和结构化视图；所有降级在 trace 中可见。
- 精确证据块来源覆盖率为 100%。

记录指标：有效内容 tokens、重复 tokens、原文/摘要/schema 比例、缓存命中、未使用 ContextBlock、每项结论的来源覆盖。

## G5：隔离多智能体审查

Director 委派文献检索、执行审计和 Blind Reviewer。Reviewer 只获得待审对象与证据包。

验收：

- 子 Agent 不继承父会话全文和兄弟输出。
- Blind Reviewer 无法通过 `project.read`、Artifact reader、MCP 或 URI 猜测读取被禁止对象。
- Handoff 符合 JSON Schema，不能用自然语言正则冒充结构化结果。
- 子结果只能进入 proposal，不能直接写 Wiki 或 Research Graph。
- 父级总预算、取消和失败传播可审计。

## G6：恢复与用户定位

在 Agent、Workflow、Runner 和 Research Graph 不同阶段模拟浏览器断开、Server 重启、Runner 失败和磁盘不足。

验收：

- 已落盘 Agent 事件可从游标重放。
- 外部副作用通过 Operation Receipt 去重。
- 用户在三次交互内找到 Claim 的精确证据。
- 用户在五次交互内找到 Artifact 的输入、代码、环境并发起受控重跑。
- 待审批、可恢复失败、证据缺口和上游变化集中进入“需要关注”视图。

## G7：第二科学领域

接入一个数据形态和分析方法不同于海洋 NetCDF 的独立领域模块。

验收：

- 领域包贡献 Schema、连接器/导入器、Recipe、Viewer、Agent Role 和测试。
- 不修改通用核心联合类型、Agent Harness、Research Graph Store 或 Server 工具分支。
- 禁用领域包后，历史 Research Object 和 Artifact 仍可用通用查看器读取。
- 安装、升级、禁用和不兼容版本均有明确结果。

## 基线记录

R0 本地基线：

- 架构包：13
- 测试文件：31
- 测试项：135
- 依赖合规扫描：401 个包
- Research Graph fixture：19 节点、20 关系
- 本地 Docker Runner：未验收，Docker daemon 不可用
- 真实 Windows 11 + Docker Desktop：未验收，属于发布阻塞项

2026-08-28 R7 本地回归：

- 架构包：17
- 测试文件：33
- 测试项：145
- 依赖合规扫描：401 个包
- G2：海洋 Workflow 继续覆盖未审批拒绝、计划绑定、下载/分析/Reviewer 与 Artifact 注册。
- G3：表格实验领域覆盖计划哈希不匹配、CSV 输入物化、确定性统计、幂等重试和内容寻址输出。
- G4：Context trace 新增 token 组成、精确来源覆盖率和重复历史合并计数。
- G5：严格 JSON Handoff、Manifest allowlist、盲审/执行隔离、工具预算、超时和父级取消已覆盖。
- G6：“需要关注”聚合审批、失败 Workflow、证据定位缺口、Research Graph proposal 与 Agent 失败。
- G7：`domain-tabular` 在不修改核心类型、Harness 或图存储的情况下注册并通过纵向切片。
- macOS arm64 Docker Desktop 29.5.3 已从固定基础镜像构建 Runner，并以 `--network none` 通过基础 xarray/RO-Crate、Argo 8-profile 分析/Reviewer 和四连接器适配器 smoke。
- 真实 Windows 11 + Docker Desktop、签名介质和真实科研任务仍未验收，不能由 macOS 容器回归替代。

后续 Gate 不得只更新数字；需要说明新增覆盖了哪个黄金任务和哪个失败路径。
