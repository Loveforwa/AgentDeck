# @agentdeck/history-panel

左边栏的历史会话（MVP v3 · N11，画板 14，IS-86，调研 DR-62）。项目 → 工作路径 → agent，会话按最后活动倒序；开着的有状态灯、单击跳过去，没开着的 Resume / ⋯（Fork into、Copy session id、Reveal in Finder）。

界面包：只依赖 contracts、design-tokens、ui-kit 和 React。白板数据和动作由组装方（apps/desktop）用 props 给；会话列表默认从 `window.agentdeck.history.list()` 取，开着时每 15 秒刷新。分组是纯函数 `buildHistory`（src/model.ts），测试直接调。

## 怎么装上的

apps/desktop 的 `HistorySidebar.tsx` 把白板的状态和动作接进来：`Workbench` 的 `renderLeftPanel` 画它（左边栏的外壳、开关、宽度在 ui/canvas，`BoardState.leftPanel` 随白板保存，顶栏最左边的按钮开关）。开着的会话按终端窗口的 agent + 会话 id（没有时用状态机报的）对上，状态灯用 board-nav 的 `navWindow`；Resume / Fork 调白板的 `newTerminal`（mode resume / fork），工作区不在白板上时先把它的框放上来；Other folders 的会话散放。

## 规则

- 工作路径：会话目录在哪个工作区目录下（取最长的）就归到哪；不在工作区里、在项目目录或项目的 worktree 目录下的按目录归到项目；都不在的归到 Other folders。/tmp 和 /private/tmp 当成同一个目录。
- 白板上有框的工作路径默认展开，搜索时全部展开；每个 agent 先显示 5 条。
- Other folders 默认收起，只露标题和会话总数；点标题展开 / 收起，开着没有存在 localStorage（`OTHER_OPEN_KEY`），搜索时照常展开（2026-10-26 用户定）。
- 没有按 agent 筛选的一栏（2026-10-26 用户去掉了）；agent 小标题前一个身份色的小方块，字也用那个颜色（design-tokens 的 `--agent-*`）。
- kimi 不能 fork（菜单项灰掉写原因）。悬停用系统提示写模型、来源（桌面版 / 编辑器）、开始和最后活动、目录和分支、第一条消息；不写消息数（DR-62）。

测试：`pnpm --filter @agentdeck/history-panel test`。
