# 开源复用与许可证矩阵

## 决策规则

采用顺序：直接依赖 → 兼容协议/格式 → 参考交互/算法 → 自研。任何自研项必须新增 ADR 和 smoke 测试。依赖在正式引入前固定版本、校验许可证并生成 SBOM。

| 能力 | 候选项目 | 许可证 | 使用方式 | Gate 1 结论 |
|---|---|---|---|---|
| Agent 内核 | earendil-works/pi | MIT | SDK 嵌入，外包一层适配器 | 采用 |
| MCP 适配 | pi-mcp-adapter | MIT | 在独立 Pi Coding Agent Host 子进程中复用单代理工具、惰性连接、目录缓存与审批拦截；Server 不直接加载 Extension | 采用（2.27.0） |
| Chat UI | assistant-ui | MIT | Custom Runtime 接 Pi 事件 | 采用 |
| Chat 产品参考 | LibreChat | MIT | 仅参考会话、附件、Artifact 交互 | 参考 |
| 科研画布基础 | XYFlow / React Flow | MIT | 无限画布、节点、边、缩放、选择、MiniMap；不使用其工作流模板语义 | 采用 |
| 画布产品参考 | Flowith Canvas 官方文档 | 专有产品/公开文档 | 参考空间化对话、Follow-up、Quote、自由节点、批量分支和动态 Recipe，不复制代码与视觉资产 | 参考 |
| 文献图前端 | Cytoscape.js | MIT | 图布局、过滤、交互与分析 | 采用 |
| 文献图后端 | NetworkX | BSD-3-Clause | 局部引文网络指标 | 采用 |
| 文献算法参考 | Inciteful docs | 文档许可需复核 | 只参考公开描述，独立实现公式 | 参考 |
| Wiki 编辑器 | Milkdown | MIT | Markdown/ProseMirror 编辑器 | 采用 |
| 项目管理参考 | Plane | AGPL-3.0 | 不复制代码，只参考信息架构 | 参考限定 |
| 计算内核 | Jupyter Kernel Gateway | BSD-3-Clause | 执行、流式输出、中断 | 未采用（2026-08-31 评审后移除：宿主直接驱动一次性容器入口，不再暴露长驻监听） |
| 科学计算 | xarray/Dask/pandas/SciPy | Apache/BSD | 直接依赖 | 采用 |
| 海洋制图 | Cartopy/Matplotlib/Plotly | LGPL/PSF/MIT | 容器内生成与 Web 展示 | 逐项核验 |
| ERDDAP | erddapy | BSD-3-Clause | 元数据和子集请求；固定 3.3.0，Argo 私有导入兼容垫片隔离在 Runner | 采用 |
| Argo | argopy | EUPL-1.2 | 隔离在 Runner/Connector 层并保留替换接口 | 许可证复核 |
| Copernicus | copernicusmarine | EUPL-1.2 | 官方客户端，隔离 Connector | 许可证复核 |
| NASA | earthaccess/Harmony-Py | BSD-3-Clause | 官方检索、认证、子集客户端 | 采用 |
| 溯源 | RO-Crate/ro-crate-py | Apache-2.0 | 标准科研包与 manifest | 采用 |
| 地图 | MapLibre GL/deck.gl | BSD/MIT | Web 地图与图层 | 采用 |
| PDF | PDF.js/pypdf | Apache-2.0/BSD | 渲染与抽取 | 采用 |
| 数据库 | SQLite/Drizzle/FTS5 | Public Domain/Apache | 元数据、迁移、全文搜索 | 采用 |
| Research Graph | LadybugDB | MIT | 嵌入式类型化属性图、Cypher、ACID/WAL 与图算法；RG-0 技术门禁通过后采用 | 有条件采用（0.19.1） |
| Research Graph 回退 | Neo4j Community | GPL-3.0 | 仅在 Ladybug 跨平台或恢复门禁失败时作为隔离容器适配器，不与默认实现同时维护 | 备选 |
| Windows 后端 | 原生 Node + Docker Desktop Engine API | 平台组件/Apache Go SDK | 原生控制面与隔离科研执行 | 采用 |

## 明确自研项及原因

| 自研项 | 无法直接复用的原因 | 替换边界 | 必要验证 |
|---|---|---|---|
| Pi Runtime Adapter | Pi 事件需映射到科研领域事件和 Web 状态 | `AgentRuntimePort` | 模拟流式、工具、取消、恢复 |
| Context Broker | 需实现活动分支投影、跨节点引用、增量胶囊、能力发现和缓存 | `ContextProvider`、`CapabilityCatalog` | 投影、去重、失效与泄漏 smoke |
| Unified Research Model | 现有项目/Wiki/文献系统没有统一科研溯源对象 | REST schema + domain package | CRUD、迁移、重启恢复 |
| Canvas Context Projection | XYFlow 不理解对话分支、跨节点引用和上下文胶囊 | `CanvasContextResolver` | Follow-up、Quote、分支合并、胶囊失效 |
| Canvas Patch Approval | XYFlow 不提供 Agent 覆盖修改审批语义 | `CanvasPatch` | 覆盖修改预览、拒绝、确认、撤销 |
| Windows Path Bridge | 需在浏览器、Windows 与容器间保持稳定资源 URI | `ResourceUri`、`ImportPort` | 中文、空格、盘符、非法名、越界 |
| Token Ledger | 需统一不同提供商、检索与工具 schema 成本 | `UsageRecord` | 预算、缓存、费用计算 |
| MCP Host Boundary | 需把 Pi Extension 与外部 stdio 进程隔离在 Server 之外，并适配汐灵凭据、路由和生命周期 | `PiMcpGatewayManager` JSONL port | 真实离线 MCP 连接、搜索、调用、取消和清理 |

## 暂不引入

- 不 Fork LibreChat、Open WebUI、Plane 或 Wiki.js。
- 不在首版引入独立向量数据库；先使用 SQLite FTS5，可选本地嵌入索引后置。
- 不自研 Jupyter 协议、NetCDF/GRIB 解析、图布局或 Markdown 编辑器。
- 不复制许可证不明的文献相似度实现；算法必须有独立公式、fixture 和解释。
