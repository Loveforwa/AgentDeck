# @agentdeck/ui-window-shell

白板上每个窗口的外框（任务 B2）：标题栏（状态点、名字、Rename 的标签、状态文字、状态后面的淡色小标签、悬停出现的放大和关闭）、内容区、8 个改大小的边和角、聚焦描边、在等你的橙色边框、再次打开时闪一下。

只管样子和手势，不知道白板坐标、缩放和层级：拖标题栏和拖边时报告**屏幕像素**的总位移，白板（`@agentdeck/ui-canvas`）除以缩放比例再改位置。只依赖 contracts、design-tokens、ui-kit 和 React。只有 canvas 用它（见 `.dependency-cruiser.cjs` 的 `ui-canvas-allowed-deps`）。

## 对外接口

| 导出 | 说明 |
| --- | --- |
| `WindowShell` | props：`name`（等宽）、`label`、`status`（contracts 的 `WindowStatusBadge`）、`focused`、`attention`、`lifted`、`flashKey`、`maximized`、`resizable`；手势回调 `onActivate`（任何地方按下）、`onMove*`、`onResize*`、`onTitleDoubleClick`、`onTitleContextMenu`、`onToggleMaximize`、`onClose`；`className` / `contentClassName` 给白板加 React Flow 的 `nopan` `nowheel` 之类 |
| `TITLE_BAR_HEIGHT` | 28，白板据此算 `contentSize` |
| `resizeRect(start, edge, dx, dy, min)` / `moveRect` | 纯函数：拖左边、上边时对边不动，停在最小尺寸 |
| `usePointerDrag` | 左键拖动（pointer capture，3px 以内算单击） |
| `StatusDot` | 标题栏的状态点：filled / hollow / none；颜色按 tone：`running` 绿、`attention` 黄、`error` 红（MVP v2 · V2） |

## 规矩

- 颜色只用 tokens 变量：状态灯和状态文字按 tone 用 `--status-running` / `--status-waiting`（文字 `--attention`）/ `--status-error`；`status.detail` 是悬停说明（Waiting 时写 Needs approval / Needs reply）。
- `status.tag`（contracts 的 `WindowStatusTag`）画在状态文字后面：细边框、`--muted` 字，`tag.detail` 是悬停说明。用于终端的 “outside workspace”（IS-57），不用彩色。
- 界面文字英文（按钮的 aria-label：Maximize、Restore、Close）。

## 测试

`pnpm --filter @agentdeck/ui-window-shell test`（Vitest + jsdom）：`resizeRect` 各个边角和最小尺寸，标题栏拖动报总位移、单击不算拖动，8 个边角，放大时没有改大小的边，双击标题栏，聚焦时不显示橙色边框，状态后面的小标签和它的悬停说明。

## 不许碰

只改本目录。不 import canvas 或其他界面包。
