# 汐灵 OS：AI 原生虚拟操作系统实施计划

> 本文只保留已经落地的内核技术记录，不再作为产品或阶段顺序来源。当前唯一产品定义与实施顺序分别见 [PRODUCT_SPEC.md](../ai-native-os/PRODUCT_SPEC.md) 和 [DELIVERY_PLAN.md](../ai-native-os/DELIVERY_PLAN.md)；旧 D/S 编号不得覆盖 V0–V7 路线。

状态：执行中（D2.5–D4 完成；D5.1 持久化、D5.2 记忆检索完成）
适用代码线：Desktop V2（Electron 单窗口、内部多窗口）
目标依据：《AI 原生虚拟操作系统：一套新的应用与协作范式》

## 1. 产品定义

汐灵 OS 不是替代 macOS、Windows 或 Linux 的硬件操作系统，而是运行在现有桌面系统之上的 AI 应用运行环境。用户表达目标，Main Agent 负责理解、拆解、发现能力、安排执行、请求关键确认并交付可追溯产物。

核心关系必须保持：

```text
Agent = 长期身份与策略
Activation = Agent 此刻是否占用运行资源
Session = Runtime/Harness 的一次连续交互轨迹
Task = OS 可调度、等待、委托、取消和恢复的工作单元
Context = 某一轮为完成当前任务而编译的临时输入
Memory = 按 Agent 命名空间保存、可检索且可追溯的长期知识
Workspace = 用户明确授权的真实文件范围
Plugin = 工具、工作流、权限和受信 UI 组件的能力包
Artifact = 版本化、内容寻址、带来源链的结果
UISurface = 从受信组件集合中选择的声明式任务界面
```

## 2. 当前事实基线（2026-09-04）

| 能力 | 当前状态 | 结论 |
|---|---|---|
| 原生桌面与系统内多窗口 | 已实现 | 保留；不退回浏览器式多页面外壳 |
| 用户文件夹映射、导入、拖放 | 已实现 | 保留 `workspace://`，禁止 Renderer 获得任意路径 |
| 统一桌面 SQLite | 已实现 | 负责桌面设置、窗口和应用注册 |
| OS Domain / Kernel | 已有可测试骨架 | Agent、Task、Memory、Plugin、A2A、Artifact、Approval、UI Surface 均已建模 |
| DeepSeek Harness | 已有适配器 | 只在 Adapter Boundary 内依赖；真实运行仍需安装运行时和配置模型 |
| 事件持久化与恢复 | SQLite WAL 追加事件表 + 内容寻址 Blob 表 | 已完成；旧 JSONL 首次启动幂等导入，投影继续由事件重建 |
| Context Compiler | 已实现预算和 provenance | 本轮接入对话、输入 Artifact、已绑定插件及工具；后续补检索和压缩策略 |
| Main Agent 用户入口 | 仅有状态探针 | 本轮加入目标提交、任务快照、审批和最小可用对话界面 |
| 动态 Agent 与真实 A2A | 内核可表达，桌面不可操作 | D3 实现 |
| Generative UI | 有声明式模型，无完整组件注册表 | D4 实现 |
| Plugin 安装/卸载 | 安装、启停、升级、回滚与 Cordis 生命周期已实现 | 包来源校验、签名信任与设置界面仍待接入 |
| 资源控制 | Core、索引、科学 Runtime 已惰性加载 | 保持；Agent Activation 空闲自动挂起 |

## 3. 不可偏离的架构约束

1. **目标优先**：首页核心入口是目标，而不是让用户先挑工具或应用。
2. **Harness 不重造**：模型循环、会话轨迹、工具执行、运行时审批、作业与沙箱由 Harness/Cordis 承担；OS 只保存领域事实和所有权。
3. **上下文天然节省**：不强行压低 token；通过 Context Compiler 的按需能力、摘要引用、Artifact URI、独立 Agent 命名空间和 A2A 最小包，使无关内容根本不进入模型。
4. **隔离默认开启**：不同 Agent 不共享私有 Session 或 Memory；协作只通过带权限衰减的 Task、ContextBundle 与 ArtifactRef。
5. **事件是长期事实**：任何任务、审批、记忆、产物和授权变化都先形成事件，再更新投影；重启不得改变事件身份或重复副作用。
6. **生成式 UI 不执行任意代码**：模型只能选择版本化的受信组件并提供结构化数据；所有 UI 动作回到命令总线重新鉴权。
7. **文件授权清晰**：只操作用户选择的 Workspace；内部持久化 URI，外部路径只在核心进程短暂解析。
8. **低资源冷启动**：启动时只加载桌面 Shell 和轻量 Core；模型、索引、科学计算、插件 Runtime 在任务需要时激活，空闲释放。
9. **领域可扩展**：海洋科学是第一套能力包，不得写进内核概念和调度逻辑。
10. **自研必测**：每个自研内核边界至少覆盖成功路径、拒绝路径、重启恢复和资源释放。

## 4. 实施顺序与验收

### D2.5 — Main Agent 真实入口（本轮）

- 修复 Event Store 恢复重复追加，保留原 eventId/seq/occurredAt。
- Context Compiler 接入已绑定插件、工具、最近对话和输入 Artifact 摘要。
- Runtime 的人类可读消息提升为 OS 领域事件；不复制 Harness 的逐步轨迹。
- Core 暴露 `submitGoal`、`snapshot`、`decideApproval` 三个窄接口。
- 对话应用展示目标、任务状态、Agent 回答、审批和产物数量。

验收：恢复历史不会增长事件日志；用户从桌面提交目标后可看到任务终态；真实 Runtime 消息可在重启后恢复；未经用户决定的审批不能继续。

### D3 — 动态能力与多 Agent 协作

- **D3.1 已完成**：Capability Resolver 的常驻目录不含工具 schema；按任务相关性最多命中四个插件，只有命中插件的工具进入 Runtime 请求。
- **D3.1 已完成**：同类上下文片段共享预算桶，插件数量增加不会线性放大系统上下文。
- **D3.1 已完成**：内核可创建临时 Worker Agent；只能继承委托方已绑定的插件，默认独立 Memory、禁止额外挂载 Workspace，并通过显式 ContextBundle 委托。
- **D3.1 已完成**：授权衰减同时受委托方现有 Grant 和 Worker 自身权限策略约束。
- **D3.2 已完成（OS 边界）**：A2A 标准适配器已具备可替换传输端口、流式进度、关联校验、取消和 ArtifactRef 校验；OS Router 可为指定 Agent 注册外部端口，远端与本地 Worker 使用同一状态回流路径。
- **D3.2 已完成（生命周期）**：父任务保存真实子任务依赖；本地 Worker 终态产生 A2A 回执；远端 `input-required` 进入可恢复的 `waiting_input`；子任务取消会回收任务授权并唤醒父任务重新规划。
- **D3.2 上游待接**：把动态 Worker 创建/委托暴露为 Harness 模型可调用的 OS 工具。当前 DeepSeek Harness TypeScript SDK 尚不提供客户端工具回调/运行中请求通道，因此不以关键词规则或伪工具实现替代；能力保持在 Adapter Boundary，待上游正式 API 后接入。
- **D3.2 部署待接**：按实际对端选择 HTTP/WebSocket/进程内 A2A Transport，并在组合根注入；协议客户端和 OS Kernel 均不绑定具体网络库。
- **D3.3 已完成（生命周期）**：Plugin Manager 的安装、启停、升级、回滚、失败恢复和卸载均形成可重放事件；禁用插件不会进入能力解析，仍绑定 Agent 的插件不能卸载。
- **D3.3 已完成（Cordis 边界）**：`CordisPluginLifecycleHost` 只接收调用方已经校验并加载的模块；`prepare` 不激活插件，显式启用才创建 Fiber，停用/失败会等待资源清理。
- **D3.3 待完成（供应链）**：实现安装包来源、完整性哈希、签名信任、权限差异审批和设置页操作；在此之前不允许根据 manifest 的入口字符串直接动态执行第三方代码。
- **D3 模型路由内核已完成**：模型地址为开放的 `providerId + modelId`，不使用封闭枚举；Main/Worker 的 `ModelPolicy` 是独立、可重放领域事实，任务可声明输入、输出、推理与工具要求。
- **D3 原生模态双重门禁已完成**：任务进入 `running` 前同时校验模型声明与 Runtime Adapter 的真实传输能力；任一层不支持图像、音频、视频或图像输出即直接拒绝，不抽帧、不转写、不降级伪装。当前 DSH SDK 适配器明确只开放文本输入/输出，待其实现真实附件块后再扩展。
- **D3 模型上下文与审计已完成**：Context Compiler 使用解析后模型的真实窗口上限；收据只保存模型地址、能力来源、模态、预算和命中工具，不复制上下文正文或凭据。Harness 按模型路由隔离并复用实例，避免 Worker 仍偷偷使用启动时固定模型。
- **D3 模型配置基础 UI 已完成**：设置页可登记任意提供商/模型名、模型级原生输入输出、窗口、工具与推理能力，并可分别给 Main/动态 Worker 指定模型；目录和 Agent 策略均可重放，运行记录显示实际模型。
- **D3 模型连接基础闭环已完成**：设置页覆盖 OpenAI、Anthropic、Gemini、OpenRouter、DeepSeek、xAI、Mistral、Kimi、智谱、Groq 与一个自定义兼容端点；密钥由既有 AES-256-GCM 凭据存储持有，Renderer 只能看到字段是否配置。连接测试经 Core 直接调用 Pi Runtime，带 20 秒取消与错误脱敏。
- **D3 原生能力证据第一步已完成**：精确命中 Pi 运行时模型目录时，Core 以目录中的窗口和原生模态覆盖手工输入，并记录 `provider-catalog + verifiedAt`；未知/自定义模型继续标记为 `user-declared`。路由器拒绝仅凭用户声明执行任何非文字模态，连接成功也不会修改模态。真正的图像、音频、视频与图像输出探针仍需在对应 Runtime Adapter 能原生收发该模态后逐项接入，不能用转码或文本替代通过探测。
- **D6 凭据加固待完成**：发布前将本地 master key 封装到 macOS Keychain、Windows Credential Manager 与 Linux Secret Service；文件加密格式保留为迁移/恢复边界，模型目录永远不能存储 API Key。

验收：一个复合目标至少拆为两个隔离子任务；Worker 看不到 Main 私有会话；授权严格衰减；禁用插件不会污染启动上下文。

### D4 — 生成式界面与任务控制中心

- **D4.1 已完成**：建立 v1 可信 UI Component Registry，覆盖审批、表单、比较、差异、表格、基础图表、Artifact 与 Task Board；`custom` 和未知版本默认拒绝。
- **D4.1 已完成**：Runtime 只提交 `UISurface` 数据；Kernel 校验组件数据/action/schema，Renderer 再次校验版本与注册类型后渲染，不执行任意模型代码。
- **D4.1 已完成**：受信组件动作只通过窄 IPC 回到 Core；action 输入依照声明 schema 校验。审批动作会重新检查待审批事实，成功后关闭 Surface 并恢复调度，过期动作不产生副作用。
- **D4.2 已完成（对话内控制中心）**：任务默认按“结果/等待/风险/下一步”展示，顶部汇总进行中、等待、风险与完成数量；模型、插件、上下文、协作状态、旧消息和任务 ID 收进运行详情。默认只展示最近八项，历史按需展开。
- **D4.3 已完成（核心命令）**：`task.submit_input`、`agent.message`、`task.approve/reject`、`tool.confirm` 与 `artifact.select` 均由 Kernel 类型化分派。输入形成可重放 Task 事实并进入下一轮 Context Compiler；Artifact 校验真实 ID/版本；成功动作关闭对应临时 Surface。无处理器、非用户发起、状态过期或超限输入均拒绝，不能只记录点击后假装成功。
- **D4.4 已完成（独立任务中心）**：原“研究”占位应用改为按需加载的任务中心；按状态筛选并呈现等待/风险，取消非运行任务、调整优先级、为失败或取消任务创建带血缘的新重试任务。所有变更经 Core 命令、领域事件和 Projection，界面通过 `os.changed` 订阅刷新，不轮询、不直接篡改状态。运行中任务在 Runtime 尚未声明安全中断能力时明确禁用取消，避免伪取消。
- **D4.5 已完成（Artifact 查看与无障碍）**：任务产物可从任务中心直接打开轻量原生查看器，内容读取经 ArtifactService 边界、限制为 200 KB 预览并展示类型、版本与 lineage；查看器支持 Escape 关闭和键盘滚动。可信组件补充 region/alert 语义和可读标签。
- **D4 完成约束**：不执行模型生成代码；大内容不注入 Renderer；运行中取消须等 Runtime 明确支持 interrupt 后才能开放。

验收：同一任务状态可确定性重建相同界面；恶意命令、未知组件和过期动作均被拒绝。

### D5 — 持久化、检索和科研能力包

- **D5.1 已完成**：JSONL 迁移为 SQLite WAL 追加事件表和可重建投影；Artifact 正文进入独立内容寻址 Blob 表，新事件只保存元数据与 `storageRef`。旧 JSONL 在 SQLite 为空时一次性导入，重复 eventId 去重、旧断裂 seq 归一化，随后不再写回 JSONL。
- **D5.2 已完成（记忆检索契约）**：Memory 保持 episodic/semantic/procedural 三类和 Agent 命名空间隔离；`retrieve()` 返回确定性词法相关度、记录置信度、时效状态、命中词与完整 provenance。过期项默认不进入结果，任务来源记忆必须引用真实 Task，Artifact 来源必须引用真实 Artifact。Context Compiler 使用带分数的命中项，而非无差别注入最近记忆；当前相关度明确是词法指标，不伪装为向量相似度。
- 科研通用包提供文献、证据、数据、计算、审查与可复现导出；海洋包只实现领域连接器与专用查看器。
- Artifact lineage 与研究图采用同一 ID/边语义，避免并行真相库。

验收：断电模拟后无假完成、无重复外部副作用；任一结论可追到证据、工具调用、数据版本与创建 Agent。

### D6 — 发布质量

- macOS、Windows 原生和 Linux 的安装、更新、签名、备份恢复。
- 冷启动、空闲内存、长任务资源回收和大目录响应性能预算。
- 威胁建模、依赖/许可证/SBOM、插件供应链与凭据隔离。
- 黄金任务覆盖普通办公和跨领域科研，防止产品重新退化成“海洋科研聊天网页”。

验收：三平台真实机器通过安装升级；默认无任务时不启动模型/索引/科学 Runtime；关键任务可恢复且结果可审计。

## 5. 当前非目标

- 不实现新的硬件内核、驱动、虚拟机或窗口服务器。
- 不允许模型生成并直接执行任意 Renderer JavaScript。
- 不在 OS Kernel 中复制 Harness 的消息轨迹、工具循环或插件运行时。
- 不为展示“智能”而默认创建大量常驻子智能体。
- 不把所有 Skill、MCP 或工具 schema 塞进基础提示；MCP 接入在能力命中后才解析具体工具。

## 6. 变更纪律

- 本文件是 Desktop V2 AI 原生架构的实施主线；完成一项必须更新状态和验证证据。
- 改变上述十条约束必须新增 ADR，不得只在界面代码里隐式改变架构。
- 旧版 Web 科研 OS 只作为可复用领域模块来源，不能重新成为 Desktop V2 的状态真相层。
- 开发期允许破坏性数据迁移，但任何破坏必须显式版本化，不能静默丢弃用户选择的 Workspace 文件。
