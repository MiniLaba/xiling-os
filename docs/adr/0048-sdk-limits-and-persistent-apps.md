# ADR 0048：SDK 能力限制与持久 App 身份

日期：2026-09-05；状态：采纳，真实交付仍待验收。

## 已核实依据

本地 @deepseek-ai/dsh-sdk-client 与 dsh-sdk-protocol 0.1.1-rc.2 的 README、client.d.ts 和 SDK 实现：wire 只有 initialize、session/prompt、shutdown；无单 prompt cancel，无已实现的远端审批应答。prompt 回执是入队 ID，SDK 通过 agent/inbox/spliced.data.inserted 匹配 ID 后才收集到 idle。

## 决策

- 每次执行独占 Harness 进程；取消及超时释放该进程，不能影响同模型其他任务。结束后不常驻，代价是后续启动开销。Session ID 连续不等于已验证跨进程历史恢复，恢复需要独立真实测试。
- 严格匹配消费回执；根 Session 才能贡献本任务结果，不将子 Session 输出冒充根输出。
- 尚未接通的 OS 工具在启动前拒绝。审批事件若无应答通道则失败并停止，不产生可以假续行的审批。默认运行配置也仍需验证工具/沙箱边界，不能因此宣称具备隔离执行。
- 任务取消等待 Runtime 处置，并忽略迟到完成事件；不支持的 Runtime 不提供运行中取消入口。
- P1 的工具与审批桥不能靠虚构 SDK 方法完成。后续评估受控的 Harness 进程内插件桥或新协议版本，保持 Runtime port；不得另写一套模型工具循环绕过 Harness。

## 持久应用基础

P2 的独立身份部分可并行于 P1 接口研究：AppPackage 是声明，AppInstance 绑定 Agent；单个 app.installed 事件原子记录二者。直接打开只建立 Session，不启动进程。停用保留数据并拒绝 Agent 激活。有未完成工作时拒绝停用，不偷偷取消。

初始 API 只接受用户发起的本地声明式包；能力发现不等于授权，不支持任意代码、签名商店或可执行插件。升级、卸载、三入口和桌面安装 UI 仍待实施。测试默认离线，不能据此宣布 App 真实工作闭环完成。

批次 3 更新：升级/卸载内核 API 已实现。原位升级禁止权限与 Runtime 变化，保留用户配置和全部工作数据；卸载是保留事实的移除状态，不能再激活。三入口和桌面安装 UI 仍待实施。
