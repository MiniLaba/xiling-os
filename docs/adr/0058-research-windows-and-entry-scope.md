# ADR 0058：科研主界面窗口化，语音/伴侣接入逐窗口科研作用域

2026-09-10。状态：已实施。取代 ADR 0056/0057 中"科研页面仍留在网页宿主、用全局选中项目"的过渡状态。

## 背景

`apps/web` 的旧网页版科研 OS 有四个界面：项目看板、文献、Wiki、科研画布。它们以**网页页面**存在，靠一个**全局选中的项目**驱动。整合契约（`docs/research-desktop/INTEGRATION.md`）要求把这些界面搬进桌面的内部窗口运行时，并让作用域按窗口绑定。

到 deaf6ec 为止的状态：文献工作台已进 window-runtime 且有程序坞入口；项目、Wiki、科研画布**只在网页宿主里**，桌面里没有任何入口。服务层（`ResearchApplicationService`）与逐窗口 `ProjectScopeRegistry` 已就绪并有测试，但没有窗口用它。

## 决策

### 1. 项目 / Wiki / 科研画布成为受管窗口

在窗口运行时注册三个 key（`project` / `wiki` / `canvas`），各自懒加载，共用同一份 `renderer-src/apps/research.tsx` 入口：

| 窗口 | 内容 | 写入 |
|---|---|---|
| 项目 | 事项看板（待梳理/可执行/进行中/受阻/已完成）、新建任务·里程碑·实验 | `project.items.create` / `.update` |
| Wiki | 页面列表、项目内检索、Markdown 编辑、版本历史、产物引用 | `wiki.create` / `wiki.revise` |
| 科研画布 | Research Graph 投影的类型化关系图、按类型筛选、实体详情与关系 | 只读 |

**画布只读**：它呈现"哪份来源/证据/计算/产物支持哪个结论版本"，不写科研事实；移动节点不构成科研操作（沿用 INTEGRATION.md 的约束）。

**投影失败必须显性**：画布显示 `graphPending` 与 `graphError`。空图不得被读作"这个项目没有关系"——那正是本轮之前修掉的静默失败。

### 2. 作用域门（gate）而不是全局选中项目

三个窗口共用一个 `useResearchScope(windowId)` + `ResearchScopeGate`：

- 未绑定项目时不显示内容，显示门：选一个已有项目，或新建（**必须带研究问题**）。
- 绑定后窗口顶部显示所属项目 + 研究问题，可切换（切换需 `confirm`）。
- **渲染器不做授权判断**：只携带 `windowId`，`projectId` 由核心进程的作用域注册表决定。渲染器传的 `projectId` 不是授权依据。

因此窗口 ID 就是作用域身份：`system.project` / `system.wiki` / `system.canvas` / `system.companion`。同一应用多开的场景在这个模型下天然获得独立作用域。

### 3. 语音/伴侣遵守同一套作用域与产物登记

伴侣面板新增「科研项目」选择器，绑定到 `system.companion`。提交目标时携带 `projectScope`，链路为：

```
companion.tsx → preload submitGoal(..., projectScope) → main.ts 校验形状
  → core-entry.resolveSubmitProject()
  → ResearchApplicationService.scopedProject(windowId, projectId)   ← 权威判断
  → TaskConstraints.projectId
```

`scopedProject` 要求：窗口**已绑定**、请求的项目**与绑定一致**、项目**真实存在**。任一不满足即拒绝。**未绑定就声称出处会被拒绝**——不能凭一句话把自己的工作挂到某个项目上。

新增 `TaskConstraints.projectId`（`@xiling/os-domain`），与 `science.projectId` 语义分离：

- `constraints.projectId`：用户工作单元的**出处**（模型路线，语音/伴侣/对话提交）。
- `constraints.science.projectId`：科学执行绑定（计划哈希 + 审批 + 独立执行记录）。

两者不可互相冒充，符合"Harness Run 与科学 Execution 不冒充用户 Task"。

### 4. 移除声明但不存在的能力

`system.files` 从 `BUILT_IN_APPS` 移除：它没有窗口运行时 key、没有 icon，因此 `syncDockFromApps()` 的 `if (!app.icon) continue` 会跳过它——注册表声明了一个既打不开也无入口的应用。真实文件夹浏览由 `system.workspace`（工作台）承担。移除后 `pruneUndeclaredSystemApps` 会清掉历史 `system.files` 行（永不触碰 `local.*`）。

## 程序坞同步的注意点

静态 `renderer/index.html` 的程序坞是硬编码的，插件/注册表应用由 `shell.js` 的 `syncDockFromApps()` 在启动时注入。两个约束：

1. 只有带 `icon` 的注册表应用会被注入图标（`if (!app.icon) continue`）。
2. `MANAGED_APPS` 白名单决定点击行为；不在白名单里的 key 会弹"即将推出"。新增窗口必须同时改 `MANAGED_APPS`。

自研图标放在 `renderer/assets/dock-icons/xiling/`，通过 `xiling-<name>` 前缀解析，避免把自研资源混进第三方图标集目录（后者自带许可证归属）。

## 验证

- 桌面基础测试 35/35（新增"入口提交的项目出处必须与窗口绑定一致"）。
- `pnpm boundary` 通过；全量 26 工作区构建通过；os-kernel 92/92、os-runtime 16/16。
- CDP 驱动运行中的应用做产品级验收：三个窗口从程序坞打开、作用域门正确拦截、绑定「自由探索」后项目看板真实写入一条事项、Wiki 真实建页得到 v1、画布渲染出 2 实体 / 1 类型化关系 / 0 待投影。

## 仍未完成

- 真实科研闭环（论文→证据→计划→审批→安全计算→产物→图谱→Wiki 引用）缺通过验收的系统级执行沙箱，`scienceAdapters` 如实报 `available: false`，不勾选。
- 语音/伴侣的产物只到任务归属层，未做项目级产物索引。
- `APP_DEFINITIONS` 中 `agent` 这个 key 目前在 `APP_DEFINITIONS` 的 `as const` 集合里被使用但 `defaultWindow` 只覆盖了部分尺寸；`files` 键在运行时中已无对应声明。
