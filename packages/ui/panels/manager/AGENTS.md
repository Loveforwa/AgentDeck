# @agentdeck/manager-panel

左边管理面板（MP2，设计画布“左边管理面板”MP0，2026-10-30 用户确认）。取代 N11 的历史会话左边栏（原 `panels/history`）和 V5 / CO4 右边的 BoardNav（原 `panels/board-nav`，MP3 退役）：一个终端只有一行，开着的有状态灯、单击跳过去，关掉的写时间、单击在它的工作区框里 Resume。右边面板从此只放源代码管理。

界面包：只依赖 contracts、design-tokens、ui-kit（`Menu`、`Popover`、`Portal`、`computePosition`）和 React。白板数据和动作由组装方（apps/desktop 的 `ManagerSidebar.tsx`）用 props 给；会话列表默认从 `window.agentdeck.history.list()` 取（每 15 秒），终端的对话主题从 `terminals.list()` 取（每 3 秒和 `status.changed` 时）。不 import 白板（ui/canvas）的内部，也不 import 别的面板。

## 从上到下

- 标题（白板名）+ 收起按钮（组装方给的 `headerActions`）。
- New：菜单（小标题 NEW）的项由组装方给（`newMenu()`，ui-canvas 的 `newMenuItems`：Terminal ▸、Browser、Workspace…、Add project…，和右键白板同一份）。
- Search：单击变成输入框，搜标题、第一条消息、分支、窗口名、对话主题（不分大小写），只留命中的、全部展开；Esc 或清空后失焦退出。没有快捷键（⌘K 是清屏）。
- NEEDS YOU · n：开着的、在等你（黄）或出错（红）的行，等得最久的在前（`since` 早的在前），行上写 “项目 · 分支”，在等你的行 `--attention-soft` 底。⌥⌘1–9 跳这里的第 1–9 行：白板用 `needsYouOrder(board)` 算同一个顺序（apps/desktop 的 main.tsx 交给 BoardController 的 `agentOrder`）。
- PINNED：`BoardState.pins` 的顺序（MP1，contracts 0.1.24），拖动换顺序（`onMovePin(from, to)`，下标是 pins 里的）。会话的置顶关掉了照样留着（可以 Resume 的一行）；窗口的置顶（Shell、网页、还没有会话 id 的 agent）找窗口 id，窗口关了就不显示；项目一行单击滚到它那一段并展开；工作路径一行单击 `onOpenWorkspace`（框不在白板上先放上来，然后选中、缩放到它）。
- 项目 → 工作路径 → 行。开着的窗口按它所在的工作区；历史会话按目录（等于某个工作区目录或在它下面取最长的；否则在项目目录或项目的 worktree 目录下的按目录归到项目；都不在的归到 Other folders；/tmp 和 /private/tmp 当成同一个）。不在工作区里的开着的窗口在 “Not in a workspace”。不搜索时每个项目都列，白板上有框的工作区即使没有会话也列。工作路径里开着的在前（白板上的顺序），然后历史会话最近的在前；每条路径先显示 5 行（开着的全显示）后 “Show n more”。白板上有框的、有开着的窗口的工作路径默认展开；项目默认展开，Other folders 默认收着（开没开存在 localStorage 的 `OTHER_OPEN_KEY`，沿用 N11 的 key）。

每一行只出现一次：在 NEEDS YOU 里的不再进 PINNED 和项目，置顶的不再进项目。开着的窗口和历史会话按 “agent:会话 id” 合成一行（窗口记着的 `sessionId`，没有时用状态机报的）。

## 一行

状态灯（只有开着的有）· agent 身份色的 7×7 小方块（`data-agent`，`--agent-*`；Shell、自定义命令空心方块；网页等不是终端的窗口画 10px 窗口图标）· 标题（改过的名 > 会话标题 > 对话主题 > 窗口名）· 窗口组身份（lead、sub-1 · api，规则照抄 ui/canvas 的 `model/groups.ts`）· 右边：开着的 `statusText`（“Waiting · 2m”“Running · 4m”“Idle · 1h”“exit 1 · 2m”“Exited”“Starting”），关掉的 `relativeTime`（now / 5m / 2h / 3d / 12 Oct）。悬停右边换成 ⋯，⋯ 和右键是同一个菜单：

- 开着的：Open ↩、Pin / Unpin、Rename…（`onRename`，白板的改名对话框）、Copy session id（有会话时）、Close terminal / Close window（`onClose`，白板的关窗口，跑着的先确认）。
- 关掉的：Resume ↩、Pin / Unpin、Fork into… ▸（kimi 灰掉写原因）、Copy session id、Reveal in Finder。
- 项目标题、工作路径（工作区的）右键：Pin / Unpin。

开着的 agent 一行悬停 350ms（键盘聚焦马上）出墨色提示（`ReplyTip.tsx`，从 CO4 搬来）：粗体 “claude · shop · main · Waiting · 2m”，淡色 Last reply（认不出回复写 On screen），回复（`lastReply`：应用传 `agentReplyReader(api)` 先读会话记录，默认只认屏幕，见 `lastReply.ts`），淡色 “Click to jump · ⌥⌘n”（不在 NEEDS YOU 的只写 Click to jump）。放在行的右边，放不下翻到左边；离开、单击、滚动时关。

## 文件

- `src/model.ts`：`buildManager`（纯函数）、`sessionKey`、路径工具、`relativeTime`、`sessionDetails`。
- `src/board.ts`：开着的窗口（`openWindows`、`openWindow`、灯、名字、窗口组名字、`statusText`、`needsYouOrder`、`rowShortcut`），从 board-nav 搬来。
- `src/ManagerPanel.tsx`、`src/ReplyTip.tsx`、`src/useTopics.ts`、`src/lastReply.ts`、`src/manager.css`（`.mgr-*`）。

## 测试

```bash
pnpm --filter @agentdeck/manager-panel test       # Vitest + jsdom + Testing Library
pnpm --filter @agentdeck/manager-panel typecheck
```

- `test/model.test.ts`：合成一行、分组和排序、没有会话的项目和框也列、状态机报的会话 id、搜索；NEEDS YOU 的顺序和去重、PINNED 的顺序和去重（关掉的会话、窗口、项目、工作路径、找不到的不显示）；窗口名字、灯、窗口组、状态文字。
- `test/manager.test.tsx`：标题和两行按钮、灯和时间、小方块；单击跳 / Resume；两种菜单和项目、工作路径的 Pin；New 菜单；Search 和 Esc；NEEDS YOU 的样子；PINNED 和拖动换顺序；Show n more；Other folders 记住；悬停提示；轮询。
- `test/last-reply.test.ts`：从屏幕认 claude / codex 的回复、截断、`agentReplyReader` 的退路。
- e2e：`tc16-tc33-manager`、`tc148-needs-you`、`mp2-pin-new-search`（`e2e/affected.mjs` 里挂在 `packages/ui/panels/manager/`）。

## 不许碰

只改本目录。颜色只用 design-tokens 的变量（`pnpm colors` 会查）：状态色只在灯、等你和出错的字、等你的行底上，agent 色只在小方块上。不 import 服务包、Electron、node 内置模块、ui/canvas 的内部；`tools/fakes` 只能在 `test/` 里用。
