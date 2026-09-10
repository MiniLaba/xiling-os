# ADR 0047：持久 App 与真实执行边界

状态：采纳；2026-09-05。

背景：旧设计偏向 Main 入口和临时应用，真实适配层又按 Activation 复用会话，导致产品 Session 与运行轨迹边界不一致。

决定：App 实例绑定持久 Agent，三种调用入口共用服务；Session 映射到 Harness Session，缺少 Session 的旧任务按 Task 隔离，禁止按 Activation 混合任务历史。运行流必须逐事件交付并在退出时关闭订阅。产品宿主不得使用模拟成功作为降级。

替换边界：领域层只依赖 Runtime port，不引入 SDK 对象。SDK 工具注册与审批仍需独立真实验证，事件映射不能冒充执行前授权。

自研必要性：上游不定义本产品 App、Task 与权限所有权；这些属于 OS 领域适配。冒烟覆盖 Session 隔离、跨 Activation 连续性、即时事件、静默超时和订阅清理。完整计划见 ../ai-native-os/APP_AGENT_DELIVERY.md。
