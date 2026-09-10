# ADR 0057：Pi 是唯一科研执行者；统一科研主路径与窗口作用域

日期 2026-09-10。状态：已实施（部分验收；真实科研闭环仍需真机与凭据）。

本轮把三件事定下来，前一件是产品决定，后两件是为了让前一件成立所必需的架构收敛。

## 1. 唯一执行者：Pi

产品决定：Pi 是唯一科研执行者，DSH 不再注册、不再考虑。因此代码里没有"降级到另一个引擎"这条路径：

- `packages/os-runtime` 删除 `dsh-adapter.ts`、`tool-bridge.ts`、`harness-entry.ts`、`resumable-sdk-server.ts` 及其测试；`index.ts` 不再导出 DSH。
- 桌面宿主只注册 `pi-research`（与音频适配器 `native-audio`）。`XILING_RESEARCH_HARNESS` 不再存在。
- 启动环境的模型声明改为中立的 `XILING_MODEL_PROVIDER` / `XILING_MODEL_ID` / `XILING_MODEL_*`。
- `AgentRegistry.enableNativeMain(runtimeName, ctx)` 不再硬编码引擎名；宿主传入 `researchHarness.executor`。
- `researchHarness` 状态如实上报：`{ executor, hostTools, runtimeRegistered, reason? }`。Pi 装配失败就明确失败，不用别的引擎顶替，也不静默退化成文本轮次。

**为了让"唯一"不等于"坏掉"**，Pi 的宿主工具桥必须真正可用，否则带工具的任务会从可用变成明确失败：

- `PiResearchRuntimeAdapter` 在轮次开始前把内核投递的工具描述装入 Pi 工具循环，工具的执行权仍在内核的 `executeTool`（权限、幂等键 `taskId:runId:callId`、副作用事件都不变）。
- 会话未实现 `setActiveTools`、或内核未提供执行网关时，适配器**明确失败**，不剥离工具、不假装装上了。
- 顺带修正 `OS_TOOL.inputSchema`：原声明 `{input: string}` 与执行器实际读取的 `{op, ...}` 不一致；现在两者一致。

## 2. 统一科研主路径

`ScienceService`（os-kernel）把 Task / Approval / Artifact / Execution 的唯一归属写死：

- 一个计划 = 一个用户可见 Task + 一个以计划哈希为 `resource` 的 Approval + 一条有自己 ID 的 ExecutionRecord + 内容寻址的 Artifact。
- 计划快照随任务保存，执行前重新校验哈希：改动参数后旧审批失效。
- 模型 Scheduler 不拾取科学任务；取消按绑定类型分派（科学 → ScienceService，模型 → RuntimeManager）。
- 没有通过验收的安全执行后端时任务明确失败并给出原因，不产出产物、不宿主裸跑。

## 3. 窗口作用域与统一科研应用服务

`ResearchApplicationService` + `ProjectScopeRegistry`（apps/desktop/src/core）：

- 项目/Wiki/事项/证据/图谱投影只有一个入口，一份 KnowledgeService 数据库，一个投影宿主。
- 项目按内部窗口显式绑定并持久化；渲染器传的 `projectId` 不是授权依据，跨项目读写一律拒绝；事项与 Wiki 页面按归属校验。
- 图谱投影返回 `graphPending` 与 `graphError`，投影失败不再表现为"这个项目没有关系"。

## 期间发现的真实缺陷

建项目时允许 `researchQuestion` 为空，使图谱投影无法为项目建立"研究问题"节点，整批科研关系校验失败（`Research Graph entities require id and title`）——证据保存"成功"但图里什么都没有，outbox 永久 pending。修复：科研项目必须声明研究问题。

## 未完成（不得据此宣布交付）

- 项目/Wiki/科研画布尚未进入桌面 `window-runtime`（服务层与作用域已就绪，界面仍只有文献窗口接入）。
- 语音/伴侣尚未按科研 scope 提交。
- 真实科研闭环与执行沙箱验收未做；本机没有通过验收的系统级执行沙箱，`adapters()` 如实返回不可执行。
- `@deepseek-ai/*` 依赖已无消费者，待清理并重生成 lockfile。
