# ADR 0054：演示优先、声明式生成界面与 AIRI 默认角色

日期：2026-09-07。状态：已实现，验收记录见交付计划。

## 本轮范围

用户明确将当前目标收敛为演示：提升美学与人机功效、复用上游默认伴侣形象、实现生成式 UI。生态、沙箱、签名、发布与全面真机验证后置；不因此宣称产品整体完成。

## 决策

- 保持一套桌面/内部窗口，不重建业务内核。设置按伴侣、模型连接、应用记忆、桌面外观分组；对话优先显示回答与需要用户处理的状态，诊断信息折叠。
- 新增 `xiling_os` 的 `ui.present` 操作，模型提供种类、标题、数据，由宿主校验并渲染表单、表格、对比、图表、差异或看板。动作由宿主固定，忽略模型传入的命令；不接收 HTML/JS。
- 表单字段生成类型约束。用户提交经过原 UISurfaceService，回到同一个 Task 的 submittedInputs，再由原调度器继续；没有第二套聊天或事实源。
- 图表使用 SVG，区分柱状、折线、散点，基线包含负值。当前契约是标签—数值序列，不宣称任意科学绘图库。
- 伴侣采用 AIRI 的默认 `preset-live2d-1`：Hiyori（Pro），不是原创角色，不是 VRM 示例。复用原模型文件及 Idle 动作，通过和上游相同的 pixi-live2d-display 渲染。并非完整移植 AIRI 应用。
- 默认缩放 1，与 AIRI view-control 一致。保留原始自动眨眼/物理动作/视线跟随；界面提供缩放、恢复默认、动态开关。麦克风/摄像头/屏幕读取不自动开启。
- 角色依赖懒加载，分辨率上限 1.5，渲染上限 30fps，关闭时释放 WebGL；后台停止更新。Pixi 官方 `@pixi/unsafe-eval` 提供禁用 eval 环境的解释实现，不放宽 CSP。

## 来源与许可

AIRI 参考提交 `f166736a760ccf05aafb1388e1833f1237573d8d`：
`packages/stage-ui/src/stores/display-models.ts`、`stores/settings/stage-model.ts`、
`packages/stage-ui-live2d/src/stores/view-control.ts`、`apps/stage-web/vite.config.ts`。

默认模型来自 AIRI 官方构建配置指向的 `https://dist.ayaka.moe/live2d-models/hiyori_pro_zh.zip`，只引入 runtime 和 ReadMe，不包含大体积编辑源文件。
Cubism SDK 使用上游下载插件指定的 `https://cubism.live2d.com/sdk-web/bin/CubismSdkForWeb-5-r.3.zip`，只引入 Core 可再分发文件及许可证。
模型作者及独立许可见 THIRD_PARTY_NOTICES.md；不能将 AIRI MIT 许可套用于 Live2D 模型/Core。公开再分发前须按实际主体和用途复核条款。

## 替换边界与验收

`apps/desktop/renderer-src/apps/hiyori.tsx` 只负责角色显示，可独立替换，不持有 Agent 业务。
`runtime-tools.ts` 是生成 UI 的权限入口；`TrustedSurface` 是受信渲染器。
自动化冒烟覆盖禁止 HTML、非法图表、幂等、宿主动作用于表单、非法枚举拒绝、提交回流和重复提交拒绝。
真实公网模型交付须单独记录；本地结构化测试不可冒充模型已经完成演示任务。
