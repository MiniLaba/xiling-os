# Third-Party Notices

## AI Native OS 新版运行组合（2026-09-05）

新增直接依赖 `@deepseek-ai/dsh-agent-spine-demo`、`@deepseek-ai/dsh-llm-pi-ai`、`@deepseek-ai/dsh-sdk-jsonrpc-server`，均固定 0.1.1-rc.2。发布包标注 MIT；来源 https://github.com/deepseek-ai/deepseek-harness 。许可证原文保留在安装包，各传递依赖精确版本以 pnpm-lock.yaml 为准。此处不将下方旧版候选表视为新版已安装清单。

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
| DeepSeek Cordis | Scoped plugin lifecycle and cleanup behind the runtime adapter | MIT |
| La Capitaine icon theme | Desktop dock SVG icons | GPLv3 for icon artwork; upstream license files in `apps/desktop/renderer/assets/dock-icons/la-capitaine/` |

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

### Desktop V2 Agent Runtime 固定版本

| Package | Version | License | Purpose |
|---|---:|---|---|
| @deepseek-ai/cordis | 4.0.2 | MIT | 插件 Fiber 生命周期、作用域与确定性资源清理；只位于 Runtime Adapter 边界 |

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
# 会话恢复依赖补记（2026-09-06）

新增直接使用 `@deepseek-ai/dsh-session-persistence-jsonl`、`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-llm`，固定为 0.1.1-rc.2，来自 deepseek-ai/deepseek-harness（MIT）。用于公开会话恢复接口和 JSONL 持久化；精确传递依赖见 pnpm-lock.yaml。
# 本轮新增组件（2026-09-06）

@deepseek-ai/dsh-tools、@deepseek-ai/dsh-compaction、@deepseek-ai/dsh-compaction-basic、@deepseek-ai/dsh-token-meter：均固定 0.1.1-rc.2，MIT；实际依赖及完整许可证随锁文件/发行依赖保留。该日期的原创 SVG 伴侣已被下述演示版方案取代；保留此项仅记录历史。
# 演示版新增组件（2026-09-07）

- AIRI (`moeru-ai/airi`)，参考提交 `f166736a760ccf05aafb1388e1833f1237573d8d`，MIT。默认角色选型与默认缩放设置参考上游；非完整 AIRI 移植。
- PixiJS 6.5.10、@pixi/unsafe-eval 6.5.10，MIT；pixi-live2d-display 0.4.0，MIT。各版权声明随依赖保留。
- Hiyori（桃濑日和）PRO：插画 Kani Biimu，模型 Live2D。本机原始文件和使用说明保存在 `apps/desktop/renderer/assets/companion/hiyori_pro_zh/`。受 [Live2D Free Material License](https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html) 和 [Sample Model Terms](https://www.live2d.com/eula/live2d-sample-model-terms_en.html) 约束，**不是 MIT 资产**。
- Live2D Cubism Core，SDK for Web 5-r.3，Copyright Live2D Inc.。使用独立的 Live2D Proprietary Software License；原始 LICENSE 和 RedistributableFiles 随 `assets/companion/CubismSdkForWeb-5-r.3/` 保留。仅为本地演示引入。Hiyori/Core 原始资产目录被 Git 忽略，不随此次公开源码上传；获取路径与条款见 `docs/ai-native-os/COMPANION_ASSETS.md`。公开发行含资产安装包前必须另行复核适用条款。
