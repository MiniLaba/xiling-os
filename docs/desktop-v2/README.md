# XiLing OS Desktop V2

本目录记录汐灵科研桌面 V2 的全新实现。旧版网页应用冻结在 `v1-legacy-freeze` 和 `codex/legacy-v1`；V2 可以替换应用代码、页面和开发期存储，不承担旧数据兼容义务。

- [目标架构](ARCHITECTURE.md)
- [迁移与删除边界](MIGRATION.md)
- [ADR 0043](../adr/0043-greenfield-electron-desktop-v2.md)

## 当前阶段

Desktop V2 当前处于 D0/D1 技术骨架阶段：Electron 主进程、安全 Preload、沙箱化 Renderer、独立 Core Utility Process 和全新科研桌面入口已经建立。此处展示的数据仅用于验证桌面信息架构，不是旧版演示项目的迁移。
