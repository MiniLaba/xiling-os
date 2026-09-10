# ADR 0045：统一桌面存储与按需应用运行时

- 状态：Accepted
- 日期：2026-09-03

## 背景

Desktop V2 需要同时管理真实文件、科研对象关系、Agent 运行、应用权限和应用内多窗口。沿用旧版多个科研库、前端缓存和常驻服务会造成事实重复、恢复困难与高空闲资源占用。用户已允许开发期破坏性重做，但无人值守实施不得物理删除旧代码或旧数据。

## 决策

1. 使用一个由 `SystemStore` 端口拥有的 `system.sqlite` 作为 V2 结构化事实源。图、全文和向量索引只是可重建投影。
2. 用户选择的真实文件夹是文件内容的事实源。数据库仅保存工作区标识、对象关系、布局和 `workspace://` 引用，不复制一棵虚拟文件系统。
3. Desktop Main、Core Utility Process、Renderer 和后续执行/插件 Host 保持进程边界。Renderer 不获得 Node、原生路径、通用 IPC 或密钥。
4. 只有一个 Electron `BrowserWindow`。应用窗口由 React Window Manager 在 Renderer 内管理；窗口内容在首次打开时动态载入，最小化即卸载。
5. App Registry 只接收版本化 Manifest。Capability Gateway 将“声明能力”与“获得授权”分开；网络和 Agent 调用默认要求明确决定。
6. Core、Agent、索引和科学运行时统一使用 acquire/release/idle-stop 生命周期。冷启动不加载 React 应用窗口包，也不启动 Core。
7. 在系统级沙箱通过安全测试前，只允许声明式内置应用和锁定的内置科研配方，不执行模型生成的任意代码。

## 后果

- 开发期旧科研库不再进入 V2 运行路径，但仍由冻结标签和分支保留。
- `node:sqlite` 当前属于实验性 Node API，因此必须留在 `SystemStore` 实现内部，不得渗透到领域或 UI。
- 工作区文件的删除、重命名、打开和外部应用协作必须继续通过 Capability Gateway 添加，不能把绝对路径返回给 Renderer。
- 发布门禁需要同时检查冷启动依赖、动态窗口包体积、活动工作集、空闲 CPU、监听器清理和崩溃恢复。
