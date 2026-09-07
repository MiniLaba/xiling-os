# @xiling/os-runtime — Runtime Boundary（复用对照）

DeepSeek Harness（`deepseek-ai/deepseek-harness`，"Everything is a Plugin"，Cordis 内核）
是本系统的 Runtime Engine。本包是指南 §2.8 要求的 **Adapter Boundary**：
OS 领域层（`@xiling/os-domain` / `@xiling/os-kernel`）只依赖本包导出的 `AgentRuntime`
端口，绝不 import harness 的任何类型。

## 包的角色

```
AI Native OS (os-kernel)
      │  只依赖 AgentRuntime 端口
      ▼
os-runtime
      ├── port.ts                    # 稳定端口（activate/run/interrupt/suspend/resume）
      ├── dsh-adapter.ts             # DeepSeekHarnessSdkRuntimeAdapter（唯一 import harness 的文件）
      └── scripted-adapter.ts        # 确定性脚本引擎（离线开发/测试/回放）
```

## 复用对照表（谁拥有什么）

| 能力 | DeepSeek Harness 提供 | OS 侧实现 | 决策 |
|---|---|---|---|
| Agent Loop / 模型调用 | `ctx.agentLoop` / `ctx.llm` / adapter seam | — | **复用**：适配器只投递 prompt、收集事件 |
| 工具注册与执行 | `core/tools`（scoped registry + guarded pipeline） | — | **复用**：工具来自 profile 组合 |
| 会话轨迹 / 持久化 / 重放 / fork | `core/session` + `session-persistence-*` | OS 只保存确定性 sessionId（`xiling-<activationId>`） | **复用**：OS 不复制 trajectory（指南 §36） |
| 会话投影 | `dsh-session-projection` | OS 域投影（os-kernel/projection.ts） | **分层**：Runtime truth vs Domain truth（§7） |
| 审批原语 | `approval/*` 会话事件 + approval seam | `os-kernel/approval-service.ts`（任务级 waiting_approval） | **桥接**：`approval/asked` → `RuntimeEvent approval.requested` |
| 子代理（同运行时委托） | `dsh-subagent` + providers（spawn/ACP/SDK/Codex/Claude） | `os-kernel/a2a-router.ts`（跨 Agent 委托协调） | **协调在 OS**：授权衰减/上下文隔离是 OS 职责（§11），执行通道将来映射 subagent provider |
| Workflow 编排 | `dsh-workflow`（模型写的编排脚本） | — | **复用**：OS Task Graph 在其上一层（§41） |
| 后台任务 | `ctx.jobs` + `jobs-local` | — | **复用**：会话内后台工作归 jobs；OS Scheduler 只管跨 Agent 任务图 |
| 沙箱 / 进程隔离 | `ctx.sandbox` + `sandbox-*` | — | **复用**：WorkspaceMount 将来落为 sandbox/fs provider 配置 |
| 凭据 | `dsh-credentials` + authorization | — | **复用**：Agent 只拿 CredentialHandle（§26） |
| 系统提示词组装 | `core/system-prompt` | — | **复用**：Agent.systemInstructions 经 prompt 组装进入上下文 |
| Compaction（上下文压缩） | `dsh-compaction` | — | **复用**：与 OS 长期记忆是不同东西 |
| **Agent 身份 / 激活** | （`identity` 仅匿名用户 ID） | `os-kernel/agent-registry.ts` | **OS 拥有**（§2.1） |
| **任务图 / 跨 Agent 调度** | （jobs 是单会话内后台任务） | `os-kernel/task-service.ts` + `scheduler.ts` | **OS 拥有**（§8/§42） |
| **能力授权 / 衰减** | （`guard` 是超时/提醒策略，非权限系统） | `os-kernel/capability-service.ts` | **OS 拥有**（§23/§24，`delegated ⊆ owned`） |
| **长期记忆** | （compaction ≠ 记忆） | `os-kernel/memory-service.ts` | **OS 拥有**（§13–16，provenance 必填） |
| **产物注册表 / lineage** | （attachment 是消息图片） | `os-kernel/artifact-service.ts` | **OS 拥有**（§27） |
| **A2A 协议** | （subagent 授权是父子 session 域） | `os-kernel/a2a-router.ts` | **OS 拥有**（§10–12），外部标准走 future adapter |
| **Generative UI 协议** | （Conversation 节点是 harness 自己的 UI） | `os-kernel/ui-surface-service.ts` | **OS 拥有**（§28–32） |
| **OS 域事件存储** | （session log 是 Runtime truth） | `os-kernel/event-store.ts` | **OS 拥有**（§2.6/§7） |

## 接入方式

- **新版桌面默认**：`harness-entry.ts` 内置官方 Agent Spine、Pi LLM 与 JSON-RPC 服务端；按任务懒启动，关闭 Shell、Skill 扫描和工作区扫描。已验证真实进程握手，尚未验收真实模型交付；详见 ADR 0051。
- **离线/测试**：`ScriptedRuntimeAdapter`（零网络零模型，整条 OS 链路确定性可回放）。
- **外部运行程序覆盖**：`DeepSeekHarnessSdkRuntimeAdapter` + `createDefaultHarnessFactory()`。
  SDK 不包含运行程序。桌面端设置 `XILING_DSH_ENABLED=1`，并用 `XILING_DSH_BIN` 指定已安装的运行程序；
  `XILING_DSH_ARGS` 为 JSON 字符串数组，逐参数传递，不使用 shell，不自动添加 `--profile`。
  若启动 Node 运行入口，BIN 指向 Node，ARGS 包含实际入口文件及经验证的配置路径。
  `XILING_DSH_PROVIDER` / `XILING_DSH_MODEL` / `XILING_DSH_CWD` 为可选路由和工作目录配置。
  外部程序的工具和权限独立审查；内置文字组合不代表完整工具闭环已经完成。

## 已知边界（来自 harness 官方 Known Limitations）

- SDK wire **没有 prompt 取消方法**：每次运行独占进程，`interrupt()` 关闭该次运行，不共享进程取消。
- OS 使用 Agent + Session 稳定映射；无 Session 的旧任务按 Task 隔离，不按 Activation。跨进程历史恢复仍需真实运行组合验收。
- OS 工具注册和审批续行尚未打通，当前显式拒绝，不用提示词冒充工具能力。上方复用表是目标分工，不是完成清单。
- DeepSeek Harness 处于 developer preview，breaking changes 只允许影响本包的适配器文件。
