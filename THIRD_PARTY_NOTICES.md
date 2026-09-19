# Third-Party Notices

本文件在 Gate 1 记录计划采用或参考的第三方项目。Gate 2 已固定首批纵切依赖；后续由 SBOM 自动生成流程补充传递依赖的精确版本、版权和许可证文本。

## 计划直接依赖

| Project | Purpose | License |
|---|---|---|
| Pi Agent Harness | Agent runtime and provider abstraction | MIT |
| assistant-ui | React chat primitives | MIT |
| XYFlow / React Flow | Research canvas | MIT |
| Cytoscape.js | Literature graph UI | MIT |
| NetworkX | Graph analysis | BSD-3-Clause |
| Milkdown | Markdown editor | MIT |
| Jupyter Kernel Gateway | Scientific kernel protocol | BSD-3-Clause |
| RO-Crate / ro-crate-py | Research provenance package | Apache-2.0 |
| SQLite | Local metadata database | Public Domain |
| LadybugDB | Embedded Research Graph database | MIT |

### Gate 2 已固定版本

| Package | Version |
|---|---:|
| @earendil-works/pi-agent-core / pi-ai | 0.84.2 |
| @earendil-works/pi-coding-agent | 0.84.2 |
| @assistant-ui/react | 0.15.16 |
| @xyflow/react | 12.11.3 |
| Fastify | 5.12.1 |
| React | 19.2.8 |
| xarray | 2024.7.0 |
| Jupyter Kernel Gateway | 3.0.1 |
| RO-Crate | 0.15.1 |

### Gate 4 已固定版本

| Package | Version | License | Purpose |
|---|---:|---|---|
| Cytoscape.js | 3.34.1 | MIT | 按需加载的文献关系图渲染与交互 |
| @milkdown/kit | 7.22.1 | MIT | Wiki CommonMark/ProseMirror 编辑、历史与变更监听；按视图懒加载 |
| drizzle-orm | 1.0.0-rc.4 | Apache-2.0 | Node 22 原生 SQLite 的类型化项目/Wiki/证据查询 |
| xarray | 2025.9.0 | Apache-2.0 | Gate 4 连接器与科学数据结构；替代 Gate 2 的 2024.7.0 |
| NumPy | 2.1.3 | BSD-3-Clause | Copernicus Marine 2.4.1 兼容的数值基础 |
| erddapy | 3.3.0 | BSD-3-Clause | ERDDAP 请求；argopy 1.4.0 的旧私有导入由 Runner 内可删除垫片兼容 |
| argopy | 1.4.0 | EUPL-1.2 | Argo GDAC 区域/时间/深度切片，隔离在 Runner |
| copernicusmarine | 2.4.1 | EUPL-1.2 | Copernicus Marine 官方 subset 客户端，隔离在 Runner |
| harmony-py | 1.5.0 | BSD-3-Clause | NASA Harmony 官方异步作业客户端 |

### Gate 4.5 MCP 固定版本

| Package | Version | License | Purpose |
|---|---:|---|---|
| pi-mcp-adapter | 2.27.0 | MIT | 独立 Host 内的单 MCP 代理工具、惰性连接、元数据缓存与审批拦截 |
| @earendil-works/pi-coding-agent | 0.84.2 | MIT | 仅在隔离 MCP Host 子进程中提供 Extension API；不作为 Web Server 插件宿主 |

### Research Graph RG-0 固定版本

| Package | Version | License | Purpose |
|---|---:|---|---|
| @ladybugdb/core | 0.19.1 | MIT | 嵌入式属性图、Cypher、ACID/WAL/Checkpoint；RG-0 通过后作为科研关系事实源 |

### 桌面壳固定版本

| Package | Version | License | Purpose |
|---|---:|---|---|
| electron | 44.3.0 | MIT | 桌面主窗口、托盘与置顶悬浮球 |
| electron-builder | 26.15.3 | MIT | Windows NSIS / macOS DMG / Linux AppImage |
| jeremy-prt/bloub `src/bot` | vendored 2026-09-14 | MIT | Grok bot 形态的 SVG 引擎；主体色覆盖为 `#5EC8F8` |

## 计划参考但不复制代码

| Project | Reference scope | License consideration |
|---|---|---|
| LibreChat | Conversation and artifact interaction | Verify current repository license before any reuse |
| Flowith Canvas documentation | Spatial conversation, Follow-up/Quote, free nodes and dynamic Recipe interaction | Product/interaction reference only; no code or visual assets copied |
| Plane | Project/wiki information architecture | AGPL-3.0; no code copied into the core product |
| Inciteful documentation | Public literature graph concepts | Independently implement and test formulas |

## 发布要求

- 固定每个直接依赖的版本和完整性哈希。
- 收录所有传递依赖和容器镜像组件。
- 生成 CycloneDX/SPDX SBOM。
- 将许可证扫描设为发布阻断项。
- 对 EUPL、LGPL、MPL、AGPL、SSPL 和自定义许可证依赖单独评审。
