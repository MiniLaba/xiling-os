# ADR-0002：Windows 11 使用 WSL2 后端

- 状态：Superseded by ADR 0039
- 日期：2026-08-23

> 本文仅保留历史决策。当前有效边界见 [ADR 0039](0039-native-windows-control-plane-and-docker-sandbox.md)。

## 背景

物理海洋科研依赖 Linux 成熟的 Python、Jupyter、NetCDF、GRIB 和容器生态。完全原生 Windows 后端会扩大依赖、路径、权限和进程取消差异。

## 决策

Windows 首版提供原生 PowerShell 安装/诊断/启动体验，Node 服务、SQLite、活动数据和科研 Runner 运行在 WSL2/Linux 容器中。活动数据存放于 WSL ext4，NTFS 只用于导入和导出。

## 结果

- 三平台共享同一 Linux 科研执行环境。
- Windows 用户必须启用 WSL2 和可用容器引擎。
- 需要自研 Path Bridge、Doctor 和导入/导出 smoke。
- Windows ARM、Windows 10 和完全原生计算后端不在首版范围。

## 退出策略

容器控制通过 `ContainerEnginePort`，路径交换通过 `ImportPort`；未来可加入 Podman 或完全原生 Runner，而不改变科研领域模型。
