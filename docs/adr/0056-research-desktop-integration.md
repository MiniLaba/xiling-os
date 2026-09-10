# ADR 0056：科研 OS 与桌面系统整合

日期 2026-09-10。状态：分阶段实施；不宣称全部统一。

用户批准将 main 的科研 OS 与 codex/demo-dual-voice 的桌面系统整合，定位恢复为 Xi Ling OS——科研 OS。旧“科研不是核心产品”边界失效；App 不必都创建常驻 Agent。保留原生桌面、内部多窗口、真实文件、惰性资源和可选语音。

目前先合并源码基线、恢复科研模块编译和依赖边界；桌面文献证据改用 KnowledgeService 并显式选择项目。knowledgeRecordToChangeSet 从 HTTP 宿主移入共享 Research Graph 包，两宿主使用同一投影函数。桌面 outbox 顺序处理、图谱成功后才确认，失败保留 pending。此步骤不代表系统 Task / Artifact / Harness 已完成统一。

桌面主题 CSS 从 packages/ui-tokens 生成，初步覆盖科研面板；禁止复制一套主题色。设置持久记录灵境/破晓/系统。既有视觉细节仍需真机逐页验收。

无必需 Docker/WSL 启动依赖。保留主分支可选 Runner 资源，避免 Git 合并无意删除已有后端；Web 兼容宿主启动清理 Docker 容器必须显式 XILING_ENABLE_DOCKER_ADAPTER=1。这不是新原生隔离执行后端，不能把它标作已完成。

数据目录没有破坏性迁移，原 localStorage 证据不自动导入、不删除。当前桌面科研库在其系统数据目录 research/workspace，Web 可独立使用其原数据根；桌面/网页并发访问同一图数据库的产品支持尚未建立，不能声称跨宿主同步。最终单宿主服务归一见整合检查清单。

边界与剩余任务：docs/research-desktop/INTEGRATION.md。旧 PR #17 不自动合并；整合完成后通过新的 main 目标 PR 发布。
