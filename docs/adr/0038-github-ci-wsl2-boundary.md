# ADR 0038：GitHub 合并门禁与 WSL2 支持边界

- 状态：Superseded by ADR 0039
- 日期：2026-08-28

> 本文仅保留历史决策。当前 Windows 原生 CI 与部署边界见 [ADR 0039](0039-native-windows-control-plane-and-docker-sandbox.md)。

## 背景

汐灵的 Windows 支持边界是“Windows 原生启动体验 + WSL2/Linux 后端”，不是原生 Windows Node、Python 或科研容器后端。原来的 GitHub Actions 矩阵包含 `windows-latest`，会把 PowerShell、原生 Node 和 hosted Windows 文件系统误当成产品运行时，产生错误的合并信号。

## 决策

1. 普通 GitHub hosted 合并门禁只运行 Ubuntu 与 macOS；它们验证通用代码、构建、测试、合规与平台入口文件。
2. Windows 原生 hosted runner 不作为支持目标，也不作为必需合并检查。
3. 真实 Windows 验收必须在 Windows 11 主机的 WSL2 Linux 环境完成。若接入 GitHub Actions，使用标签为 `xiling-wsl2` 的自托管 runner，并通过仓库变量 `XILING_WSL2_RUNNER=true` 显式启用。
4. WSL2 job 是发布前平台门禁；未配置自托管 runner 时跳过，不阻塞普通开发 PR，也不能被跳过结果冒充真实 Windows 验收完成。

## 约束

- PowerShell 脚本只负责 Windows Host 的检查、启动、导入导出和浏览器打开；科研服务必须在 WSL2/Linux 内运行。
- 项目数据、SQLite、Node 依赖、容器挂载目录和高频科研数据仍位于 WSL ext4，不在 `/mnt/c` 上运行。
- `docs/gate-5-review.md` 必须同时记录 hosted CI 状态和真实 WSL2 专机状态；CI 通过不等于 Windows 发布验收完成。

## 结果

合并门禁与实际产品支持边界一致：Linux/macOS 变更可以在 hosted CI 快速验证，Windows 相关发布风险集中到可复现的 WSL2 自托管环境，不再因不存在的“原生 Windows 支持”造成误判。
