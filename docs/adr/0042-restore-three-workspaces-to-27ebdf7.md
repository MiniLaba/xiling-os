# ADR 0042：文献、项目与 Wiki 工作区锁定 `27ebdf7`

- 状态：已接受并实现
- 日期：2026-09-01

## 背景

新版后端、Research Graph、Agent 中枢、原生 Windows 控制面与沙箱必须继续保留，但文献工作台、项目管理和 Wiki 的后续视觉整合偏离了用户认可的 `27ebdf7` 版本。仅凭相似的新设计无法满足“完全回归”的产品要求。

## 决策

1. `PaperGraphView.tsx`、`ProjectView.tsx` 与 `WikiView.tsx` 逐字锁定到 `27ebdf7`。
2. 从该提交的 `styles.css` 与 `styles-workbench.css` 机械提取这些工作区使用的规则，生成 `legacy-27ebdf7-workspaces.css`。
3. 兼容层只允许作用于 `.workspace-papers`、`.workspace-project` 和 `.workspace-wiki`，不得改变 Chat、科研画布、设置页或应用壳。
4. 只增加一个适配当前 flex 工作区壳层的尺寸规则；页面内部布局、文案和交互保持旧版。
5. 后端及 API 不回退。若未来接口变化，适配应在 API 客户端或服务端兼容层完成，不在这三个锁定视图内重写产品交互。
6. `legacy-workspace-compat-check.mjs` 使用内容哈希阻止无意漂移；确需改变这些页面时必须先更新本 ADR 并取得新的产品决策。

## 后果

- 三个页面恢复旧版的固定浅色视觉，即使全局选择灵境主题也不重新着色；这是完整复现旧版的已知代价。
- 生成样式增加前端 CSS 体积，但边界明确、可从指定提交复现，且不会把旧全局样式重新引入其他工作区。
- `scripts/restore-27ebdf7-workspace-styles.mjs` 是唯一生成入口，禁止手改生成文件。
