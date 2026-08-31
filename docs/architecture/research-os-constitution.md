# 汐灵 OS 科研内核架构宪法

> 状态：有效  
> 生效版本：Research OS Modernization R0  
> 适用范围：R0–R8 及其后的领域扩展、Agent、图、执行与前端开发

## 1. 产品定义

汐灵 OS 是本地优先、证据优先、可审批、可复现并可按科学领域扩展的个人科研操作系统。它的核心价值不是“提供一个能调用很多工具的聊天界面”，而是让研究问题、证据、数据、方法、计算、产物、审查与决策成为可追踪、可恢复和可验证的科研对象。

系统必须能回答：

1. 一项结论基于哪些精确来源、数据和计算？
2. 一个产物由什么输入、代码、参数、环境和运行生成？
3. 哪些内容是事实、原文、解释、模型摘要或仍待确认的提案？
4. 一项外部下载、执行或写入由谁在何时批准，批准的确切范围是什么？
5. 新科学领域能否在不修改通用内核的前提下接入？

## 2. 永久不变量

### 2.1 三图分离

- Agent Execution Graph 只描述 Agent Session、Run、Operation、Entry、Usage、Compaction 和委派关系。
- Research Graph 只描述科研事实、证据、过程、产物、版本和溯源关系。
- Literature Discovery Graph 只描述临时搜索、推荐和论文发现关系。
- 三图可以通过稳定 URI 互相引用，但不得共享事实表、写入路径或把布局状态当成科研事实。

### 2.2 单一事实源

- 每个聚合只有一个拥有者和一个正式写入者。
- 禁止为了迁移方便长期保留双写、双读和“新存储为空时回退旧存储”。
- 跨数据库一致性使用源端 durable outbox/journal、稳定幂等键、目标 applied ledger 与 reconcile，不引入分布式事务。

### 2.3 科研事实审批

- Agent、子 Agent、Skill、MCP 和 Runner 不能直接发布科研事实。
- 它们只能产生结构化 proposal、计划、运行事实或 Artifact。
- Claim、Evidence 解释和批量 Research Graph ChangeSet 的发布必须经过可见确认；布局和纯展示偏好除外。

### 2.4 Artifact 内容寻址

- PDF、图像、音频、视频、数据、代码、环境锁、日志、图表和报告等 payload 只进入受管 Artifact/Blob Store。
- SQLite 和 Research Graph 只保存 URI、哈希、MIME、大小、版本、生命周期和关系，不保存大型 payload。
- 模型上下文默认只接收 Artifact 描述符；正文或切片必须按明确选择器读取。

### 2.5 领域中立内核

- 通用 contracts、Agent Harness、Context、Research Graph、Artifact、Workflow 和 Execution 不得包含 Ocean、Argo 或其他学科专有类型、状态或分支。
- 学科 Schema、连接器、Recipe、Viewer、Agent Role 和 Prompt 通过受审计领域包贡献。
- 新领域接入不得要求修改核心联合类型或 Server `switch`；出现这种情况视为领域 SDK 设计失败。

### 2.6 Pi 单一边界

- 所有 Pi SDK 依赖只能存在于 `packages/pi-runtime`。
- `ResearchAgentHarness` 继续拥有耐久 Run、事件、取消、恢复、Usage 和 Compaction 协调权。
- 不复制 Pi Agent Loop，不把上游私有 API 扩散到 Server 或领域包。

### 2.7 天然上下文经济

- 上下文由用户选择、Research Graph 有限邻域、显式引用、来源解析、Capsule 和能力发现组成。
- Skill、MCP 和工具只加载命中任务的元数据或 schema；不得批量常驻模型上下文。
- 不用统一 Token 硬上限替代科研判断；只有模型窗口、费用预算或异常结果需要保护阈值。
- 任何语义降级必须可见、可解释，且不得把摘要伪装成原文或证据。

### 2.8 原生模态

- 模型和 Pi 传输层都明确支持的原生模态才可启用。
- 不得用转写、抽帧、OCR 或代理模型把不支持的模态伪装成已支持模态。
- 大型原生媒体通过 Artifact 引用和流式上传处理，不使用长期 Base64 消息副本。

### 2.9 执行与外部副作用

- 下载、科研计算、外部写入和高权限 MCP 必须绑定计划哈希、Approval Receipt 和幂等 Operation Receipt。
- 科研执行必须进入受控 Linux 容器或等价沙箱，记录输入、代码、参数、随机种子、环境 digest、资源与网络策略。
- 取消使用应用级 token、Pi abort、Jupyter interrupt 和容器 API，不把 POSIX 信号作为唯一正确性机制。

### 2.10 本地优先与 Windows 边界

- 系统保持模块化单体；没有已证明的独立扩缩容或故障隔离需求时不得微服务化。
- Windows 11 原生运行 Node 控制面、数据库和项目数据；科研代码统一进入 Docker Linux 沙箱，不依赖受管 WSL 发行版。
- NTFS/OneDrive 仅作为受检导入源或显式导出目标。

## 3. 明确的非目标

- 不在当前阶段建设云端多租户、团队权限、通知和计费平台。
- 不以“图工程更先进”为理由把所有对象塞入一个图数据库。
- 不在基准证明 Graph + FTS 不足前引入向量数据库。
- 不在现有 ResearchGraphStore 跨平台、恢复或性能门禁失败前替换 LadybugDB。
- 不在通用 Artifact、Workflow 和 Execution 协议稳定前继续堆叠大量数据源和页面。
- 不允许领域包、Skill、MCP 或 Pi Extension 在主进程中获得未声明的数据库、文件系统或凭据权限。

## 4. 变更门禁

每个 R0–R8 Gate 必须同时满足：

1. 更新 `DESIGN.md`、相关架构文档和 ADR。
2. 新增或更新离线 fixture、单元测试、失败路径与 smoke。
3. `node scripts/offline-check.mjs` 通过；需要容器或真机的项目明确标为未验收，不能用“代码存在”代替通过。
4. 没有新增事实源回退、跨层深导入、Pi 边界旁路或学科词汇泄漏到通用内核。
5. 新依赖完成开源、许可证、维护状态和 Windows 原生/Docker 评估。
6. 破坏性开发期 Schema reset 可以接受，但必须同步删除兼容代码和旧测试。

## 5. 停止与回退条件

- 若一次重构需要长期双写才能上线，应缩小 Gate，而不是保留双重事实源。
- 若第二学科必须修改核心 contracts 或 Server 分支，停止领域扩展并修正 SDK。
- 若 Context 回归出现无来源内容、证据覆盖下降或静默裁切，停止性能优化并恢复上一实现。
- 若 Jupyter 会话无法确定性恢复，保留 Batch Runner 作为正式路径，Jupyter 继续实验性适配。
- 若 LadybugDB 任一首发平台、WAL 恢复或 Native Addon 门禁失败，只替换 ResearchGraphStore 适配器，不改变科研对象契约。
- 若某个新服务不能证明独立扩缩容、故障隔离或部署收益，不得从模块化单体拆出。

## 6. 完成定义

“先进通用科研 OS”不能由页面数量或领域 Manifest 数量宣告。至少要满足：

- 海洋领域完整闭环通过。
- 一个数据形态和执行方法明显不同的非海洋领域无需修改内核即可完成相同闭环。
- 任意结论和 Artifact 能在 UI 与 API 中追踪至精确来源和运行环境。
- 多智能体隔离由数据访问层强制，并通过对抗测试。
- 上下文证据覆盖、重复内容、缓存、成本与降级均可观测。
- macOS、Linux 和真实 Windows 11 + Docker Desktop 发布矩阵通过。
