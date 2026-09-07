# ADR 0046：以目标驱动的 AI 原生虚拟操作系统取代桌面产品定义

状态：Accepted
日期：2026-09-04

## 背景

此前 Desktop V2 同时承担产品定义与原生宿主实现，导致开发容易把程序坞、多窗口、文件管理和科研固定应用当成产品本体。新的目标由《AI 原生虚拟操作系统_通俗小册子》明确：用户表达目标，通用 Agent 按需装配能力并推进任务，界面只在需要查看或决策时出现。

## 决策

1. `docs/ai-native-os/PRODUCT_SPEC.md` 成为唯一产品规格，`DELIVERY_PLAN.md` 成为唯一阶段路线。
2. 当前产品标识为 `ai-native-virtual-os` / V3；`apps/desktop` 继续作为原生宿主路径，避免为更名制造无产品价值的迁移。
3. 冻结 Web 科研 OS 仍由既有 Git 引用保存；Desktop V2 文档降为宿主历史，不再定义交互模型。
4. 保留已验证的原生窗口、真实文件夹、事件存储、能力网关、Agent/Task/A2A/Artifact 和可信 UI 基础，但全部按新规格重新验收。
5. 删除内核和默认系统应用中的单一领域假设。科研、文献和数据能力通过插件安装。
6. 首个补齐的领域缺口是 Session：它必须成为独立、可重放且归属于单个 Agent 的工作边界，Task 明确关联 Session。

## 后果

- 开发优先级从“增加固定应用和桌面拟真”转向 Goal → Task → Capability → Decision UI → Artifact 的真实闭环。
- Shell 仍可提供桌面与内部多窗口，但不能要求用户先理解应用结构才能表达目标。
- Harness 可以替换或升级；Agent、Session、Memory、Workspace、A2A 和 Generative UI 的产品语义保持稳定。
- 旧阶段编号、界面截图和已有类名不能作为完成证据，必须通过路线中的行为验收。
