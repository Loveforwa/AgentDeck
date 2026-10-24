# @agentdeck/ui-topbar

顶栏（任务 B4，MVP v2 · V1 改成一行）：和 macOS 的系统标题栏合成一行（34px，窗口用 hiddenInset），透明、浮在白板上。顶栏自己不是拖动区、不接指针（`pointer-events: none`），里面的按钮、数字、菜单接指针并且 `no-drag`；窗口的拖动区由放顶栏的一方画在白板下面（ui/canvas 的 `.ad-workbench-drag`，IS-63）。
左边：项目菜单（按钮上是聚焦的窗口所在的项目名，没有时“My Board”；菜单是各项目 › New workspace… / Project settings…、Add project…），后面灰字写当前工作区“main · 3 windows”，没有时整块白板“2 workspaces · 5 windows”。
右边：“● 3 running”（绿灯）、“1 waiting”（前面一个黄灯，单击跳到下一个在等你的窗口）、齿轮（aria-label Settings，提示 Settings (⌘,)）。

只管显示：数字和 Projects ▾ 菜单的内容由白板（`@agentdeck/ui-canvas`）算好传进来。只依赖 contracts、design-tokens、ui-kit 和 React；只有 canvas 用它。

## 对外接口

- `Topbar`：`boardName?`、`projectName?`、`workspace?`（`{ label, windows }`）、`workspaces`、`windows`、`running`、`waiting`、`waitingPosition?`、`projectsMenu`（ui-kit 的 `MenuEntry[]`）、`onWaitingClick`、`onSettings`、`trafficLights?`（左边留 76px 给红黄绿按钮）。数为 0 时不显示 running / waiting。
- `summaryText(workspaces, windows)`、`workspaceText(workspace)`、`waitingText(waiting, position?)`：单复数。

## 测试

`pnpm --filter @agentdeck/ui-topbar test`（Vitest + jsdom）。

## 不许碰

只改本目录。
