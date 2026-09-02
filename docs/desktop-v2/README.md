# XiLing OS Desktop V2

本目录记录汐灵科研桌面 V2 的全新实现。旧版网页应用冻结在 `v1-legacy-freeze` 和 `codex/legacy-v1`；V2 可以替换应用代码、页面和开发期存储，不承担旧数据兼容义务。

- [目标架构](ARCHITECTURE.md)
- [迁移与删除边界](MIGRATION.md)
- [ADR 0043](../adr/0043-greenfield-electron-desktop-v2.md)

## 当前阶段

Desktop V2 已完成 D0/D1 基础纵向切片：一个 Electron 原生窗口承载应用内桌面与多内部窗口；安全 Preload 只暴露版本化能力；Core Utility Process 按需启动并在空闲后退出；`system.sqlite` 统一保存应用、权限、科研对象、关系、事件、Agent 状态和窗口布局；用户可选择真实电脑文件夹作为桌面目录，并将文件直接拖入而不向 Renderer 暴露绝对路径。

当前桌面工作区与旧版存储完全断开。旧数据和源码仍由冻结标签/分支保存，自动实施阶段不物理删除。模型生成的任意代码和可执行第三方应用仍保持禁用，直到系统级沙箱通过安全验收。

## 本阶段验证

- `pnpm --filter @xiling/desktop test:foundation`：统一存储、Manifest、资源生命周期、Unicode 文件导入、覆盖保护和符号链接越界。
- `pnpm --filter @xiling/desktop smoke`：构建、安全不变量和无容器依赖。
- `XILING_DESKTOP_LAUNCH_SMOKE=1 pnpm --filter @xiling/desktop start`：真实 Electron、Renderer、按需 Core 和 SQLite 启动后自动退出。
