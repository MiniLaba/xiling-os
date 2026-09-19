# ADR 0043：Electron 桌面壳与 Bloub 悬浮指示球

- 状态：已接受并实现
- 日期：2026-09-14

## 背景

汐灵 OS 已有本机 Node 控制面和 Web UI，但启动形态仍是「构建后打开系统浏览器」。需要把同一套本地服务包成 macOS / Windows / Linux 桌面应用，并增加类似 Codex 桌宠的置顶指示球，外观复用开源 Bloub（Grok bot 形态），颜色改为海洋蓝。

## 决策

1. 新增 `apps/desktop` 作为 Electron 壳。它不拥有科研事实源，只负责：拉起现有 `apps/server`、加载 `http://127.0.0.1:4317`、提供无边框置顶悬浮球。
2. 桌面进程使用系统或打包附带的 **Node 二进制** 启动 Server，不用 Electron 的 `process.execPath` 跑 Fastify，以避免 LadybugDB 等原生模块的 ABI 错配。
3. 悬浮球独立 `BrowserWindow`：透明、置顶、可拖动；单击显示/隐藏主窗口；右键退出。渲染复用 vendored `jeremy-prt/bloub` 的 `src/bot` 引擎，主体颜色固定为海洋蓝 `#5EC8F8`。启动时先显示 idle/swirl 球体；Agent 忙碌时切到 orbit。
4. 安装包由 `electron-builder` 生成；当前不签名、不公证。Windows 数据目录仍是 `%LOCALAPPDATA%\XiLingOS`。
5. Web 与 Server 的模块边界、Agent Store、Research Graph 和审批模型不变。

## 被否决方案

- **只打包 `apps/web/dist` 静态文件**：没有 Server 就没有 API、SSE 和本地数据库。
- **Tauri 壳**：仍需附带 Node 运行时，第一版改动更大。
- **在主窗口 DOM 里放悬浮球**：滚动和焦点会把它带走，无法做到桌面级置顶。
- **嵌入完整 Vue Bloub 演示站**：汐灵 Web 是 React；只需无框架的 `src/bot`。

## 后果与验证

- `scripts/desktop-smoke.mjs` 检查壳文件、Bloub MIT 声明、海洋色和 pet bundle。
- 根目录 `一键启动桌面端.bat` / `pnpm desktop` 是开发期入口；`pnpm desktop:pack` 在当前平台生成安装包。
- 新增依赖 Electron、electron-builder、Bloub 记入 OSS 矩阵和第三方声明。Bloub 只授权代码，不授权 x.ai 外观设计。
