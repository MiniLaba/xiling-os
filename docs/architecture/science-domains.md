# 科学领域扩展架构

## 组合模型

```text
Project.domainIds
  -> ScienceDomainRegistry
     -> general-science（始终启用）
     -> selected domain manifests
  -> ResolvedScienceDomain
     -> bounded prompt fragments
     -> capability metadata -> explicit Server tool adapters
     -> Agent role contributions -> MultiAgentOrchestrator
     -> connector/artifact/schema declarations -> UI and validation
```

稳定科研内核包括 Project、Research Question、Claim/Revision、EvidenceAssertion、Paper/SourceFragment、Dataset/Snapshot、ResearchRun、Artifact/Version、Review、Wiki、审批、溯源和 Agent 执行事实。领域包不得复制这些对象。

## Manifest 边界

`ScienceDomainManifest` 是数据清单，不是任意代码插件。它声明：

- 唯一 ID、语义版本、名称、学科标签；
- 少量系统提示片段；
- Capability 元数据及其预期 tool name；
- 受控子智能体角色和 capability allowlist；
- 连接器、Artifact 类型与 Research Graph property namespace。

Server 必须为 tool name 注册明确 adapter。不存在 adapter 时启动或调用失败，不允许退回到任意命令执行。领域包不能直接导入 Pi、数据库实现、凭据或 Runner。

## 当前内置包

- `general-science`：通用科研原则、跨学科文献检索、证据审查、复现审计和反方审稿。
- `ocean-climate`：当前优先完成的官方领域模块，提供海洋数据切片、海洋数据规划、物理海洋分析、ERDDAP/Argo/Copernicus/NASA 连接器及地理空间 Artifact。
- `tabular-experiment`：已接入的表格实验领域模块，提供表格数据导入、通用 Recipe、确定性执行和结果审查，并持续验证核心 Execution/Artifact/Review 链不依赖海洋类型。

## 新领域接入清单

1. 定义 Manifest，并优先复用通用实体、RO-Crate、标准数据格式和开源客户端。
2. 对领域特有关系先使用 namespaced properties；确需新增核心关系时写 ADR。
3. 为每个有副作用的 capability 编写 Server adapter、审批披露和 capability token。
4. Runner 使用独立环境/镜像，不把大型依赖塞入 Node Server。
5. 提供固定离线 fixture，覆盖最短成功路径、错误输入、取消和资源清理。
6. 添加许可证、SBOM、Windows 原生路径与 Docker 沙箱验证。
7. 验证未选择该领域的项目看不到其工具、角色或 Skill 正文。

推荐后续官方包边界：`earth-observation`、`astronomy`、`bioinformatics`、`chemistry-materials`。它们首先共享文献、证据、计算、Artifact 和复现机制，只增加真正领域特有的连接器、查看器、校验与 Runner 环境。
