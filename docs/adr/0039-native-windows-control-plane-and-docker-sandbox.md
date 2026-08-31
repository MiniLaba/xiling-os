# ADR 0039：原生 Windows 控制面与统一 Docker 科研沙箱

- 状态：Accepted
- 日期：2026-08-31
- 替代：ADR 0002、ADR 0038

## 背景

WSL2 承载整个应用虽然统一了 Linux 环境，却增加了发行版管理、跨文件系统 I/O、端口转发和故障诊断成本。Node、浏览器、SQLite 与项目元数据本身没有必须运行在 Linux 中的理由；真正需要 Linux 生态的是 Python 科研计算和官方数据客户端。

另一方面，旧 Runner 只在各调用点零散设置网络、CPU 和内存，不能保证新增执行器自动继承同一安全边界。

## 决策

1. Windows 11 x86_64 上，Web/Server、Pi Harness、SQLite、Research Graph、项目数据和 Artifact Store 使用原生 Node.js 与 NTFS 应用数据目录运行，不依赖 WSL。
2. Windows 默认数据根目录为 `%LOCALAPPDATA%\XiLingOS`，数据库只保存资源 URI；外部文件经预检后复制成内容寻址快照。
3. Python、官方数据客户端和不可信科研代码继续运行在 Docker Desktop 的 Linux 容器中。Docker 是跨平台执行端口，不是应用控制面。
4. `@xiling/execution` 拥有统一 Docker 沙箱策略。所有科研 Runner 必须使用它，至少启用：非 root 用户、capability 全部移除、`no-new-privileges`、PID/CPU/内存/文件句柄限制、独立 IPC、受限 tmpfs 和显式网络策略。
5. 分析网络默认关闭；需要访问数据源的 Connector 使用显式 egress 模式。凭据只通过 stdin 注入单次运行。精确主机 allowlist 在代理型网络执行端口完成前不得伪称已实现。
6. `pnpm start` 和 PowerShell 启动器在健康检查通过后自动打开 Web；CI 或无桌面环境使用 `--no-browser`/`XILING_NO_BROWSER=1`。
7. GitHub hosted CI 直接覆盖 Windows、macOS、Linux；真实 Windows 11 + Docker Desktop 仍是发布验收环境。

## 约束

- Server 默认只绑定 `127.0.0.1`，启动器不修改防火墙。
- 不直接在 Host 执行模型生成的 Python、Shell 或科研客户端代码。
- 容器工作区目前需要写入运行产物，因此尚未启用根文件系统 `--read-only`；迁移到显式只读输入卷和可写输出卷后再提升。
- Docker Desktop 内部是否利用 WSL2/Hyper-V 属于容器引擎实现细节，汐灵不安装、管理或调用 WSL 发行版。
- Windows ARM、Windows 10、无容器科研执行和签名安装包不在当前支持范围。

## 结果

用户获得真正的原生 Windows 应用与数据路径，同时三平台继续共享相同的 Linux 科研执行镜像。安全参数成为可测试的单一策略，新 Runner 无需自行拼装隔离参数。代价是 Windows 原生 Node/SQLite/LadybugDB 必须进入 CI 和真实机器发布矩阵。
