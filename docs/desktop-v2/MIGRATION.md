# Desktop V2 迁移与删除边界

## 冻结基线

- 提交：`aca965a505a2c49b5ce8092fcb2117337dc0153c`
- 标签：`v1-legacy-freeze`
- 维护分支：`codex/legacy-v1`
- 新版分支：`codex/desktop-v2-foundation`

旧版只接受严重故障、安全和可恢复性修复。旧版功能不会自动成为 V2 验收要求。

## 选择性移植

保留概念和经测试接口，而不是复制旧组合方式：Pi Harness、上下文经济、模型连接器、Skill/MCP 契约、Artifact/Provenance、执行 Provider 和科学领域扩展。

## 默认重写

- 网页启动器和 localhost 主路径
- 固定侧栏式页面壳
- Fastify 作为所有前端交互中心的耦合
- 开发期数据库和示例数据
- 科研图谱中缺乏科学语义的节点与关系
- UI、Chat、Wiki、画布对同一事实的重复存储

## 禁止事项

- 不在 V2 中复制一份 `legacy/` 源码。
- 不为了旧开发数据加入长期双写或兼容层。
- 不把现有网页直接放入 BrowserWindow 后称为桌面版。
- 不允许 Renderer 直接接触 Node、Shell、文件系统或密钥。
- 不在 D0/D1 阶段大规模搬运旧功能。

## 数据策略

V2 使用独立应用标识和数据根目录。开发阶段允许清空和重建 V2 数据；旧版目录只读保留。将来如需导入真实项目，应通过显式导出/导入格式，而不是共享 SQLite 文件。
