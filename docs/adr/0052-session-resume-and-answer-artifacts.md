# ADR 0052 — Harness 会话恢复与用户保存回答

状态：实施中，2026-09-06。

官方 JSON-RPC 的创建接口不会自动恢复历史。内置 Harness 使用官方 JSONL persistence 和公开 agents.resume/create，复用原有事件协议与 Agent 循环。每个 Agent/Session 使用稳定 ID 和独立哈希目录；进程结束释放，历史留存。损坏的已提交记录不能通过新建空会话悄悄覆盖。外部 Harness 保留其自行管理历史的边界。

内置 runtime 声明 ownsSessionHistory 后，Context 编译器不再次附加近期对话；任务与权限上下文仍由 OS 提供。当前未接通自动压缩，不承诺无限长会话。跨进程恢复已用真实子进程及本地固定模型响应验证，不等于真实提供商验收。

用户可将已完成任务的 assistant 消息保存为不可变 Markdown 产物。IPC 仅接收消息 ID，后端读取内容并检查用户身份、消息角色和任务状态；按消息去重。元数据记录原消息、Run、user-saved-answer 和保存者。它不改变任务执行结果，不补做输出合同，不代表事实经过验证，也不是模型工具调用。任务中心复用既有产物读取接口。

替换边界：会话协议桥位于 os-runtime；产物提升位于 ArtifactService；界面通过窄 preload 调用。后续官方 SDK 提供原生 resume 时可替换协议桥。Agent 自动产物工具仍须在副作用之前经过权限检查，不能借用户保存接口绕过。

定向验证：harness-history.smoke.test（真实进程、固定响应、重启历史）、answer-artifact.test（拒绝、快照、去重、任务关联）。
