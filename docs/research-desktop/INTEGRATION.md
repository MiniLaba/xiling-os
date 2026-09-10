# Xi Ling OS——科研 OS 整合契约

2026-09-10。当前有效产品与整合计划；取代“科研降为非核心可安装插件”和“每个 App 必须是持久 Agent”的旧目标。历史设计保留追溯，不驱动本次交付。

## 基线与策略

源 main: 96d60cc；桌面源: fda5218 / codex/demo-dual-voice；整合分支 codex/research-os-integration。不直接更新 main，不删除旧分支和用户数据。Git 无冲突不等于架构完成。

产品以科学研究为核心，海洋/气候是优先模块。桌面与内部多窗口是宿主；项目、科研对话、文献、证据、计算、图谱和 Wiki 是默认能力。语音与伴侣是可选入口。

## 数据及服务唯一所有权

| 对象 | 目标负责人 | 整合约束 |
|---|---|---|
| 窗口/本机文件/后台资源 | Desktop Host | 一个原生窗口；不把路径和通用执行能力交给 Renderer |
| 用户任务/等待/取消 | Task service | Harness Run 与科学 Execution 不冒充用户 Task |
| 模型循环/历史压缩 | Harness adapter | Pi 默认科研路线；系统不重复持有模型历史 |
| 项目/Wiki/标注 | Knowledge services | 数据库权威；localStorage 只存 UI 偏好 |
| 科研关系/结论版本 | Research Graph | 证据和来源可追踪；运行日志不能自动成为科学结论 |
| 文件内容/版本/校验 | Artifact Registry | 复用流式二进制存储；OS 只引用，不建立第二份科研内容 |
| 科学执行 | Execution service | 保存参数/环境/输入输出哈希；不可信代码不得宿主裸跑 |

不同存储之间使用耐久 outbox 和幂等投影，不宣称跨 SQLite / 图数据库天然原子事务。UI 布局不是事实，文献发现图不是证据库，Wiki 是科研知识阅读入口而不是 Agent memory。

## 模块边界

系统内核不能依赖海洋、图数据库实现、Electron 或 React。科研服务通过公开端口接入；平台 IPC/HTTP 是传输适配器，不能拥有业务事实。允许保留 Web 开发入口用于回归，但最终桌面主路径不得常驻两套业务后端。

恢复主分支科研包进入工作区只是准备步骤。Task/Artifact/Approval 的重复路径必须逐项替换并测试；不得改名后宣称统一。

项目上下文必须按内部窗口/请求显式携带，跨项目访问拒绝。文件夹是 Workspace 的实际存储位置，不等于 Project。语音和伴侣遵守同一科研权限和产物登记接口。

## 设计系统

packages/ui-tokens 是主题变量权威。桌面外壳允许轻量透明效果，科研内容区域使用平静实色、清晰边框。禁止装饰性深色边条、重阴影、双重系统侧栏。统一设置入口及主题；窗口中的分隔栏必须联动内容宽度。主分支项目/Wiki/文献的已有信息结构应保留，适配窗口而不是重做产品。

## 顺序与检查清单

- [x] 核对两个基线并建立独立整合工作区；未改 main。
- [x] 更新产品规则，恢复科研包工作区与依赖方向门禁。
- [x] 恢复全部工作区依赖、编译；图谱定向回归通过（完整科研端到端仍单列）。
- [x] 抽取并连接统一科研应用服务，移除桌面证据 localStorage 写路径。
- [x] 统一 Task/Session/Artifact/Approval，接入 Pi 科研 Runtime 并使其成为唯一执行者。
- [x] 科研页面窗口化，逐窗口 ProjectScope，统一设计组件与主题。
     项目 / Wiki / 科研画布已进 window-runtime，各有程序坞入口；未绑定项目的窗口显示作用域门。
     画布只读，投影失败与待处理条数显性上报；`system.files` 这一"无窗口无图标"的死声明已移除。
- [x] 双语音/伴侣切换为科研服务入口，保留音频原生语义。
     伴侣面板按 `system.companion` 绑定项目；提交携带项目出处，由 `scopedProject` 校验
     （必须已绑定、与绑定一致、项目存在），写入 `TaskConstraints.projectId`。音频仍只是适配器。
- [x] 无 Docker 安装启动；执行适配器安全能力真实声明。
- [x] 小型真实科研闭环和窗口交互验收。
     窗口交互验收：CDP 驱动真实界面（三窗口、作用域门、看板写入、Wiki 建页、画布投影）。
     真实科研闭环：macOS seatbelt 沙箱内跑通旋转分解 → 内容寻址产物 → 科研图谱 →
     Wiki 引用产物，全程未用 fixture 成功。执行适配器 `available: true`（见 ADR 0059）。
- [ ] 新整合 PR；明确替代旧 PR #17，但不自动合并。已开 PR #18，待本轮回合推送。

## 验收

2026-09-10 第一轮（deaf6ec）证据：26 个工作区恢复，全部构建通过；桌面 typecheck 通过。共享图谱/服务投影 10 项测试通过，桌面知识持久化及 OS 内核 73 项通过。文献 localStorage 写路径已移除。

2026-09-10 续作证据（三个提交，各自当时全绿）：

- `bcaf776` Pi 适配器进入 Runtime Boundary；能力如实声明；`AgentRegistry.setRuntime` 拒绝运行中换引擎。os-runtime 20→32，os-kernel 72→76，桌面基础测试 17→21。
- `ac59617` 科学执行统一主路径（Task/Approval/Artifact/Execution 单一归属，计划哈希绑定审批，无可用沙箱即明确失败）。os-kernel 76→95。
- `76ae313` 统一科研应用服务 + 逐窗口项目作用域（跨项目读写拒绝、归属校验、重启恢复、图谱投影暴露待处理与失败原因）。桌面基础测试 21→35，smoke 与 container-independence 通过。
- 第四轮（Pi 唯一执行者）Pi 宿主工具桥接通；DSH 适配器、工具桥、内置运行入口与凭据转发模块删除；模型声明环境改为 `XILING_MODEL_*`；`researchHarness` 如实上报执行者、工具桥与注册状态。os-runtime 16（DSH 20 项随模块删除），os-kernel 92，桌面基础测试 33，smoke 与 container-independence 通过。

期间发现并修复的真实缺陷：科研项目允许空研究问题，导致科研图谱投影整批校验失败（证据保存成功但图里没有关系、outbox 永久 pending）。

2026-09-10 第五轮（科研窗口化 + 入口作用域）：

- Pi 真实运行验收（OpenRouter 免费模型 `nvidia/nemotron-3-super-120b-a12b:free`，凭据存于应用自身凭据库、未进仓库）：凭据连通 ok（1914ms）；Main 指派该模型后提交真实任务，任务 `completed` 并产出 1 个产物；回读产物为 1680 字节真实 Markdown——**产物只能经 `xiling_os` 工具产生，因此 Pi 宿主工具桥已被真实模型调用过一次**，`hostTools: true` 不再是声明。
- 项目 / Wiki / 科研画布进入 window-runtime，程序坞 10 个图标（含三个新窗口）；作用域门拦截未绑定项目的窗口。
- CDP 驱动真实界面验收：三个窗口全部打开；绑定「自由探索」后，项目看板写入一条事项（待梳理 1）、Wiki 创建页面得到 v1、画布渲染出 2 科研实体 / 1 类型化关系 / 0 待投影。
- 伴侣面板接入 `system.companion` 作用域，提交携带项目出处并由核心进程校验；`TaskConstraints.projectId` 与 `science.projectId` 语义分离。新增测试覆盖"未绑定带出处被拒 / 绑 A 声称 B 被拒 / 未知项目不可绑定"。
- `system.files` 死声明移除（无窗口 key、无 icon，注册表不该声明打不开的应用）。
- 门禁：`pnpm boundary` 通过；全量 26 工作区构建通过；桌面基础测试 35/35、smoke 与 container-independence 通过；os-kernel 92/92、os-runtime 16/16。os-domain 无独立 test 脚本（其行为由 os-kernel 与桌面测试覆盖）。

期间修正：新增测试的首版断言把"绑定后传未知项目"的预期错误码写错——该路径先撞上跨项目校验而非"项目不存在"。改为断言 `ProjectScopeError` 并单独验证绑定路径拒绝未知项目。这是测试写错，不是实现缺陷。

2026-09-10 第六轮（真实科研闭环 + 系统级执行沙箱）：

- **执行沙箱落地**：macOS seatbelt（`/usr/bin/sandbox-exec`）接入 `ScienceExecutionPort`，`scienceAdapters` 由 `available: false` 变为 `available: true`。隔离由内核执行，无 Docker/WSL 依赖，无宿主裸跑回退。隔离能力逐项声明（`enforced` / `notEnforced`），并明确三项未覆盖：内存硬上限、按主机名网络 allowlist（计划要求时**拒绝执行**）、敏感区之外的一般性读取。
- **沙箱验收 12 项**（`packages/execution/src/macos-seatbelt.test.ts`）：真实数值计算产出内容寻址产物（哈希与落盘内容复核一致）；网络连接被拒；`~/.zshrc`、`/etc/hosts`、`/Volumes` 读取被拒；scratch 外写入被拒并核实文件不存在；派生 `/bin/ls` 被拒；`while True` 被 wall-clock 终止；取消生效；声明输入落在被拒区时仍可读、同级未声明文件读不到。
- **端口验收 7 项**（`apps/desktop/src/core/science-execution.test.ts`）：哈希不符拒绝、网络 allowlist 拒绝、未知适配器拒绝、非零退出失败、无产物失败、真实计算端到端。
- **真实闭环跑通**（经应用自身 IPC，非进程内直调）：计划 → 审批（计划哈希绑定）→ `execution-4d6df532… @ macos-seatbelt` `succeeded` → 任务 `completed` → 2 个产物（`niw-report.md` 473B、`niw-rotary.json` 852B，内容为真实的近惯性振幅表与第 1 垂向模态系数 0.017107 / 残差 0.004988）→ 科研图谱 8 节点 13 关系、pending 0 → Wiki 页面 `REFERENCES` 两条指向产物版本。
- 投影链路补全：新增 `knowledge.science.artifacts.registered` 事件，产物经同一条耐久 outbox 入图（不双写）。图谱新增 4 项验收测试。

**期间发现并修复的真实整合缺陷**：Wiki 引用产物时投影整批失败、outbox 永久 pending。根因是同一份产物被两个投影各写一次不可变 `ArtifactVersion` 节点，第二写因内容哈希不同被不可变守卫拒绝。修法确立所有权规则：产物节点唯一所有者是产物登记投影，**引用方只建引用边**，不重定义事实。重启后该 pending 记录自动重试成功，同时验证了耐久 outbox。

**同时修掉一个可读性缺陷**：产物节点标题原取 URI 末段，对 `artifact://<id>/version/<n>` 得到 `"1"`，图里会显示一堆叫 "1" 的节点；改为由调用方传入产物名。

待完成的关键项：语音/伴侣的产物仅到任务归属层（未做项目级产物索引）；`recoverInterrupted()` 未接执行仓库；资源 URI 只支持 `file://`；执行适配器只支持 python3。这些不能因构建成功勾选。

同一项目：论文搜索/阅读 → 证据提升 → 数据/执行计划 → 授权 → 安全计算 → Artifact → 科研关系 → Wiki 引用。还必须验证跨项目拒绝、取消、重启恢复、产物哈希、图谱幂等和权限衰减。

缺少安全执行后端时，应显示不可执行，不能用 fixture 成功或宿主裸跑冒充验收。无真实凭据、权限或真机证据的项目不得勾选完成。
