# @agentdeck/ui-topbar

顶栏（任务 B4）：左边“My Board”和“2 workspaces · 4 terminals”，右边 Projects ▾、“3 running”、“1 waiting”（橙色按钮，单击跳到下一个在等你的窗口）、Settings。

只管显示：数字和 Projects ▾ 菜单的内容由白板（`@agentdeck/ui-canvas`）算好传进来。只依赖 contracts、design-tokens、ui-kit 和 React；只有 canvas 用它。

## 对外接口

- `Topbar`：`boardName?`、`workspaces`、`terminals`、`running`、`waiting`、`projectsMenu`（ui-kit 的 `MenuEntry[]`）、`onWaitingClick`、`onSettings`。数为 0 时不显示 running / waiting。
- `summaryText(workspaces, terminals)`：单复数。

## 测试

`pnpm --filter @agentdeck/ui-topbar test`（Vitest + jsdom）。

## 不许碰

只改本目录。
