# ADR 0059：科研执行采用 macOS seatbelt 沙箱

2026-09-10。状态：已实施。补齐 INTEGRATION.md 中"真实科研闭环缺系统级执行沙箱"这一阻塞项。

## 背景

`ScienceService` 的规划—审批—执行—产物主路径在第一轮整合时就完成了，但执行端口一直返回
`available: false`，理由是"本机尚未接入通过安全验收的系统级执行沙箱（无 Docker/WSL 回退）"。
因此"论文 → 证据 → 计划 → 审批 → 安全计算 → 产物 → 图谱 → Wiki 引用"这条闭环**从未真正跑通过一次**。

约束（AGENTS.md，不可协商）：

- 不引入 Docker/WSL 依赖。
- 不得用宿主裸跑替代隔离。
- 没有通过验收的沙箱就如实显示"不可执行"，不能用 fixture 成功冒充验收。
- 缺安全执行后端时必须显式失败。

## 决策

用 **macOS seatbelt（`/usr/bin/sandbox-exec`）** 作为隔离后端。它是 macOS 自带的强制访问控制机制
（与 App Sandbox 同源），隔离由**内核**执行，不依赖被测进程自我约束，且不增加任何安装依赖。

代码分层：

| 位置 | 职责 |
|---|---|
| `packages/execution/src/macos-seatbelt.ts` | 通用 OS 级隔离：策略生成、解释器探测、受限执行。不依赖 Electron，不依赖科研领域类型 |
| `apps/desktop/src/core/science-execution.ts` | 把沙箱接到 `ScienceExecutionPort`：物化并校验哈希、映射产物、留档日志 |
| `apps/desktop/src/os-kernel-host.ts` | 装配：`new OSKernel({ scienceExecution })` |

### 隔离策略：允许根 + 显式拒绝，而不是枚举允许路径

最初按"枚举解释器需要读哪些目录"写（`/usr`、`/System`、`/Library`…）。这条路**极其脆弱**：
只要漏掉一个路径，解释器就在启动阶段被内核杀掉，表现为 `SIGABRT` 且 **stderr 全空**，
而排查过程中很容易越放越宽，最终把隔离"修"没了。

改为三段式（SBPL 后匹配规则优先）：

```
(deny default)                                   ;; 一切默认拒绝
(allow sysctl-read) (allow file-read-metadata) (allow mach-lookup)
(allow process-exec <白名单>)
(deny process-fork)
(allow file-read* (subpath "/"))                 ;; 1. 允许根读：不必枚举解释器内部依赖
(deny  file-read* <敏感区>)                       ;; 2. 显式拒绝敏感区
(allow file-read* <声明的输入> <设备文件>)         ;; 3. 再放行调用方声明的输入
(allow file-write* <scratch> <设备文件>)           ;; 写只落 scratch
(deny network*)                                  ;; 网络显式拒绝
```

敏感区默认清单：`/Users`、`/Volumes`、`/Applications`、`/private/etc`、`/private/tmp`、
`/private/var/root`、`/cores`。第 3 段放在拒绝之后，因此运行目录即使位于被拒区
（生产布局正是如此：`~/Library/Application Support/XiLing OS Desktop/science-runs/`）
也仍然可读——但同级未声明的文件读不到，有测试专门守着这条语义。

### 四个必须记住的坑

1. **seatbelt 用解析后的真实路径匹配。** `mkdtemp` 给 `/var/folders/…`，内核看到的是
   `/private/var/folders/…`。不 realpath 化，放开项形同不存在。
2. **设备文件必须用 `(literal …)`。** `(subpath "/dev/null")` 永远不命中——`/dev/null` 是设备
   文件不是目录。这一条错了会静默失去放开项。
3. **`/bin/sh` 与 `/usr/bin/python3` 都是转发桩。** `/bin/sh` 要 exec `/bin/bash`；
   `/usr/bin/python3` posix_spawn 的**不是** `sys.executable`
   （`…/Versions/3.9/bin/python3.9`），而是
   `…/Versions/3.9/Resources/Python.app/Contents/MacOS/Python`。
   只白名单桩路径会得到 `posix_spawn: … Operation not permitted`（或 SIGABRT）。
   因此解释器真实路径由解释器自己回答（`sys.executable`），并额外放行整个 framework
   版本目录（其内只有 Python 自身二进制，不扩大可执行面到任意宿主程序）。
4. **漏掉系统读取路径的失败是静默的。** `(deny default)` 下缺一项放开不会报错，
   只会 SIGABRT 且 stderr 为空。这正是改投 deny 模型的直接原因。

### 真实能力边界（逐项声明，不允许营销化改写）

`ScienceExecutionAdapterDeclaration.isolation` 新增 `enforced` / `notEnforced` 两个字符串数组
——只给四个布尔值会让读者把"有超时"读成"有内存上限"，那是另一种形式的假声明。

强制执行的：写入仅限 scratch；拒绝读取上述敏感区；网络全部拒绝；exec 白名单；
默认禁止 fork；wall-clock 超时 + `RLIMIT_CPU` + 每流输出字节上限。

**不覆盖**的：内存硬上限（seatbelt 无此能力，`RLIMIT_AS` 在 Darwin 不生效）；
按主机名的网络 allowlist（**计划要求 allowlist 时直接拒绝执行**，而不是悄悄放宽网络）；
敏感区之外的一般性读取限制（默认允许读根）。

### 计划一致性

执行前对代码与每个输入**重新校验 sha256**，不符即拒绝——批准过的东西和实际执行的东西必须
是同一个。退出码非 0、或退出码为 0 但没有任何产物，都判失败，不因为"跑完了"就算成功。
每次执行在 `science-runs/<executionId>/` 下留 `execution.log`（环境摘要、策略指纹、产物哈希、stdout/stderr）。

## 验证

`packages/execution/src/macos-seatbelt.test.ts` 12 项全过，含真实执行与隔离断言：
真实数值计算产出内容寻址产物（哈希与落盘内容复核一致）；网络连接被拒；
`~/.zshrc`、`/etc/hosts`、`/Volumes` 读取被拒；scratch 外写入被拒（并核实文件不存在）；
派生 `/bin/ls` 被拒；`while True` 被 wall-clock 终止；取消信号生效；
声明输入落在被拒区时仍可读、同级未声明文件读不到。

`apps/desktop/src/core/science-execution.test.ts` 覆盖端口层：哈希不符拒绝、
网络 allowlist 拒绝、未知适配器拒绝、非零退出失败、无产物失败、真实计算端到端。

## 闭环打通后的投影所有权规则

真实闭环跑起来后立刻暴露一个整合缺陷：Wiki 引用产物时**整批投影失败、outbox 永久 pending**。
根因是同一份产物被两个投影各写一次不可变 `ArtifactVersion`：科研执行投影写的是带溯源的版本，
Wiki 投影又写一次更"瘦"的版本，第二写因内容哈希不同被不可变守卫拒绝。

确立的规则：**产物节点的唯一所有者是产物登记投影**（`knowledge.science.artifacts.registered`）。
其它投影（Wiki、以及将来任何引用产物的投影）只建立引用边（`REFERENCES`），不重定义事实。
引用一个从未登记的产物 URI 时，图里会出现一条指向不存在节点的边——画布对两端缺一的边本来就不绘制，
这比"整批投影永久失败"是明确更小的代价。

## 端到端验证（经应用自身 IPC，非进程内直调）

```
scienceAdapters → [{ id: "macos-seatbelt", available: true, enforced: 6 条, notEnforced: 3 条 }]
计划            → task_20df8974f0b44e73，planHash 7009882c38250dc1…
审批            → apr_… → approved（资源 = plan://<planHash>）
执行            → execution-4d6df532-… @ macos-seatbelt：succeeded
任务            → completed
产物            → niw-report.md 473B（text/markdown）
                  niw-rotary.json 852B（application/json，含 mode1=0.017107、residual=0.004988）
图谱            → 8 节点 / 13 关系 / pending 0 / 无错误
                  Project ─CONTAINS→ Artifact ─HAS_VERSION→ ArtifactVersion ─EVALUATES→ ResearchQuestion
                  WikiRevisionRef ─REFERENCES→ ArtifactVersion ×2
```

产物版本节点带 `executionId` / `adapterId` / `planHash` / `recipe` / `sha256` / `kind` / `mimeType`，
因此"这个数字是哪次执行、哪个计划、在哪种隔离里算出来的"可以直接从图上回答。

## 仍未完成

- 内存硬上限未实现。
- `recoverInterrupted()` 目前返回 0：执行记录未落独立仓库（任务状态本身由内核持久化），
  崩溃中断的执行不会自动标记，只在磁盘上留下 `science-runs/<executionId>/` 作为证据。
- 只支持 `file://` 与绝对路径的资源 URI；尚未接 `artifact://`（因此"用上一个产物作为下一次计算的输入"还做不到）。
- 解释器固定为 `python3`；其他语言运行时需要各自探测真实二进制。
- 尚无科研计划的**创作界面**：计划目前由宿主/Agent 提供，UI 只能看到任务与审批。
