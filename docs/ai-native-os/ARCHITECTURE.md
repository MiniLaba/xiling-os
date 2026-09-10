# AI 原生虚拟操作系统目标架构

## 分层

```text
Human Interaction Plane
  ├─ App Launcher / independent App UI
  ├─ Goal Composer
  ├─ Decision Inbox
  ├─ Result / Artifact Views
  └─ Trusted Generative UI Renderer
                 │ typed command
OS Control Plane │
  ├─ App Package / App Instance → persistent Agent
  ├─ Main Agent Coordinator
  ├─ Agent / Session / Task lifecycle
  ├─ Context Compiler / Memory policy
  ├─ Capability Resolver / Plugin lifecycle
  ├─ A2A Router / permission attenuation
  ├─ Artifact / provenance
  └─ Event Store / projections / recovery
                 │ stable ports
Runtime Plane    │
  ├─ Pi Research Runtime（唯一模型执行者，工具桥接入内核 executeTool）
  ├─ Audio Adapter（语音原生输入/输出，不是第二个模型后端）
  ├─ Sandbox / approval enforcement
  └─ local or remote execution providers
                 │
Science Plane    │
  ├─ Research Graph（类型化科研关系，投影自知识库 outbox）
  ├─ Literature discovery（可丢弃的发现投影，不是证据库）
  ├─ Science Execution（受审批的计算，无沙箱即不可执行）
  └─ Artifact Registry（内容寻址，OS 只引用）
                 │
External Plane
  ├─ Models
  ├─ Files and services
  └─ installed capability packages
```

## 事实所有权

- Pi Harness 拥有某次模型运行的细粒度事件与工具循环。
- OS 拥有 Agent 身份、Session 边界、Task 状态、权限、Memory、Artifact 和用户决策。
- Renderer 只拥有窗口位置、焦点、展开状态等显示投影；项目作用域不属于它。
- Plugin 拥有领域模型和领域视图，不得反向污染 OS Kernel。

### 每个对象只有一个权威（不得改名后宣称统一）

| 对象 | 权威 | 说明 |
| --- | --- | --- |
| 用户工作单元 | `TaskService` | Harness Run 与科学执行都不得冒充用户 Task |
| 本次是否允许 | `ApprovalService` | 资源 = 计划哈希；模型任务与科学执行共用同一审批服务 |
| 计算过程 | ExecutionRecord（自己的 ID） | 科学执行有独立记录，不别名成任务 |
| 科研内容 | `ArtifactService` | 内容寻址 + lineage；OS 不建立第二份正文 |
| 项目/事项/Wiki/证据 | KnowledgeService 数据库 | 窗口只传作用域，不拥有事实 |
| 科研关系/结论版本 | Research Graph | 由知识库 durable outbox 投影，可重建 |
| 窗口绑定 | ProjectScopeRegistry | 按内部窗口显式绑定并持久化 |

科学执行不被模型 Scheduler 拾取，取消按绑定类型分派；计划快照在执行前重新校验哈希，改动参数后旧审批失效。

## 科研执行平面

- 一个计算计划 = 一个用户可见 Task + 一个以计划哈希为资源的 Approval + 一条 ExecutionRecord + 内容寻址 Artifact。
- 执行适配器必须如实声明隔离能力（文件系统/网络/资源上限/进程上限）。没有通过验收的系统级沙箱时返回"不可执行"，任务明确失败：不得用 fixture 成功、宿主裸跑或"仅进程隔离"冒充。
- 图谱投影失败必须暴露（待投影条数 + 失败原因），不得让空图看起来像"这个项目没有关系"。

## 窗口作用域

- 项目上下文按内部窗口/请求显式携带，跨项目访问拒绝。
- 渲染器传的 `projectId` 不是授权依据；授权依据只有核心进程持久化的绑定。
- 文件夹是 Workspace 的实际存储位置，不等于 Project。

## 上下文编译

Context 不是数据库表的整行导出，而是每次运行生成的短生命周期包：

1. 固定且短的 Agent 身份和系统约束。
2. 当前 Task、用户最新输入和明确约束。
3. 通过检索命中的少量 Memory 摘要及引用。
4. 输入 Artifact 的摘要、URI 和 provenance，不含大型正文。
5. 仅命中插件的工具定义。
6. A2A 委托时仅加入显式 ContextBundle。

所有装入项形成 Context Receipt，但 Receipt 不复制正文或密钥。压缩用于延续 Session；Memory 写入必须经过独立选择，不把压缩摘要自动当事实。

## Agent 与 A2A

- Main Agent 与 App 均为普通通用 Agent；Main 额外拥有协调能力，用户不必通过 Main 才能工作。
- 持久 App Agent 可独立打开或被调用；临时 Worker 仅用于短期隔离任务，不能替代 App 模型。
- 每个 Agent 有独立 Session、Context、Memory 和权限上限。
- A2A 包含 Task、最小 ContextBundle、期限、输出契约、衰减后的权限和 ArtifactRef。
- 完整 Session、私有 Memory、凭据和整个 Workspace 不通过 A2A 传播。

## Generative UI

固定 App UI 与系统生成 UI 共用任务与产物服务。用户、Main、其他 App 调用只改变 Caller、输入和权限，不分叉应用逻辑。

模型只返回版本化声明：`component + data + actions + lifecycle`。内核先校验，Renderer 再校验。动作回到命令总线重新鉴权。

首批可信组件：比较、表格、表单、日历、地图、图表、Diff、Artifact、审批、任务状态。未知组件和任意 HTML/JavaScript 一律拒绝。

## 资源模型

- 默认只有 Shell 常驻；Core、Harness、插件宿主和索引器按需启动。
- Agent Identity 长期存在不等于进程长期存在；Activation 可挂起和回收。
- Session/Task 状态事件化持久化；运行进程可丢失并恢复。
- 不轮询任务或文件状态，使用事件推送。
