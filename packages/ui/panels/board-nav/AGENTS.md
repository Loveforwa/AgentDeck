# @agentdeck/board-nav-panel

右侧面板在什么都没选中时（没有聚焦的窗口、没有选中的框）显示的快速定位列表（MVP v2 · V5，IS-56，TC-33）。需求见设计画布「11 · V5」。

CO4（画板 O0 第 4 节，照 Shepherd Terminal 的 Agent Monitor 和 herdr 的侧边栏）加了 Agents 视图：顶上 Board / Agents 切换，Agents 只列 agent 终端、按状态分组，Unseen 粗体，悬停看最后一条回复，⌥⌘1–9 跳前 9 行。

界面包：只依赖 contracts、design-tokens、ui-kit（悬停提示用它的 `Portal`、`computePosition`）和 React。白板数据由组装方（apps/desktop）用普通 props 传进来；对话主题自己从 `window.agentdeck.terminals.list()` 取。不 import 白板（ui/canvas）的内部，也不 import 别的面板。

## 用法

```tsx
import { BoardNav } from '@agentdeck/board-nav-panel';

<BoardNav
  projects={s.projects}       // 白板状态里的这几项，原样传
  workspaces={s.workspaces}
  frames={s.frames}
  windows={s.windows}
  statuses={s.statuses}       // 按 terminalId
  badges={s.badges}           // 按 windowId
  onJump={(id) => controller.jumpAndFlash(id)} // 和 ⌘J 一样：平移、闪一下、聚焦
  // api={...}                 // 默认 window.agentdeck（只用 terminals.list 和 on）；测试传假实现
  // refreshMs={3000}          // 对话主题多久刷新一次
  // lastReply={agentReplyReader(api)} // Agents 视图悬停提示的最后一条回复：应用里先读会话记录，默认只读屏幕（见下面）
/>

// 白板的 ⌥⌘1–9 用同一个顺序（apps/desktop 的 main.tsx）：
new BoardController({ api, homeDir, agentOrder });   // agentOrder(state) → Agents 视图从上到下的 windowId
```

聚焦窗口后由组装方换回源代码管理面板（apps/desktop 的 `SidePanel`）。

## 有什么

- 顶部 “BOARD”。下面：项目名（粗体）→ 工作区（分支名，等宽、灰；plain 项目没有分支时写工作区名）→ 窗口。
- 顺序按位置：框从上到下、同一行从左到右，框里的窗口也一样（和 ⌘⇧] 一样）；项目按项目列表的顺序。
- 窗口一行：状态灯（V2 那套：绿 running、黄 waiting、红 error、空心灰 idle 和 starting、灰线 exited；没有状态的网页窗口画一个小窗口图标）、名字（改过名用改的名，否则 agent 名 / 命令名 / 网页的 host；终端用等宽字）、窗口组（N2）里的终端名字后面灰字写组里的身份，和标题栏、组的侧边栏一样：lead 写 “lead”，子终端 “sub-1 · api”（按在白板 windows 里的先后编号，有 `WindowNode.group.label` 时加 “· label”；改过名的只显示改的名，同标题栏；IS-70。规则照抄 ui/canvas 的 `model/groups.ts`，那边没从注册表入口导出，改一边要改另一边）、在等你时 “· Waiting”（悬停看 Needs approval / Needs reply）、终端的对话主题 “· Check local git history”（灰）。
- 在等你的行浅黄底（`--attention-soft`）。不是终端的窗口，badge 的 tone 是 attention 也算在等你（和 attention.ts 一致）。
- 没有框的项目写 “no workspaces”；框里没有窗口写 “no windows”；散放的窗口（以及工作区没有框的窗口）放在最后一组 “Not in a workspace”；白板上什么都没有时写 “Nothing on the board yet.”
- 每行是一个按钮，读屏名字是 “claude, Running, Check local git history”。

## Agents 视图（CO4）

- 顶栏右边（收起按钮前）两段切换 Board / Agents，按下的那段 `--hover` 底 + 600。上次选的记在 localStorage 的 `agentdeck.board-nav.view`（读写失败当 Board）。标题 Board 时 “BOARD”，Agents 时 “AGENTS · 6”（agent 终端的个数）。
- 只列 agent 终端（`isAgentWindow`：终端窗口、agent 不是 shell / custom）；Shell、自定义命令、网页不列，底下灰字 “⌥⌘1–9 jumps to rows 1–9. Shells and web pages are under Board.”。没有 agent 时 “No agents on the board.”
- 分组固定顺序，空组不画：ERROR（红灯）→ NEEDS YOU（等批准、等回答）→ RUNNING → DONE · UNSEEN（idle 且 `TerminalWindowData.unseen`）→ IDLE（idle、starting、exited、没有状态的）。小标题 “NEEDS YOU · 2”。组里按白板上的位置（和 Board 视图一样：项目 → 框 → 窗口，散放的最后）。`unseen` 记着但又在跑、在等你时，按现在的状态分组。
- 行和 Board 视图同一个零件（`.bnav-row`）：灯、等宽名字、灰字 “项目 · 分支”（散放的没有）、窗口组身份 lead / sub-1 · api，右边状态：等你 “Waiting · 2m”（`--attention`，悬停 Needs approval / Needs reply，整行 `--attention-soft`）、运行 “4m”（灰）、没看 “Unseen · now”（粗体墨色，名字也粗体，**不加颜色**）、空闲 “1h”、出错 “exit 1 · 2m”（`--status-error`）、退出 “Exited”。读屏名 “claude, Idle · Unseen, shop · fix/cart-total”。单击 = `onJump`（和 ⌘J 一样，聚焦后白板清掉 Unseen）。
- 悬停 350ms（键盘 Tab 到这一行马上）出墨色提示（`--ink` 底、`--on-ink` 字，`role="tooltip"`，行的 `aria-describedby` 指向它），放在行的左边，放不下翻到右边：第一行粗体 “claude · shop · fix/cart-total · Idle · Unseen · now”（状态写法同标题栏），然后淡色 “Last reply” 和回复，最后淡色 “Click to jump · ⌥⌘3”（第 10 行起只写 “Click to jump”）。读的时候 “Reading…”，没有 “Nothing to show yet.”，会话没了 “The session has ended.”。离开、单击、滚动时关。同一个终端状态没变（`since` 一样）时不再读第二次。
- 最后一条回复（`src/lastReply.ts`）：和 `agentdeck session result`（CrewService.result，C7）用同一段读会话记录的代码。contracts 0.1.22 起 `agents.lastReply(id)` 在主进程读 claude、codex、pi、omp 的会话记录（agent-adapters 的 `createLastReply`），应用（apps/desktop 的 App.tsx）传 `lastReply={agentReplyReader(api)}`：读到会话记录用它（空行合成一个，最多 8 行 600 字，`kind: 'reply'`）；没有这个方法（假实现、老版本）、出错、只读到屏幕时退回认屏幕：`terminals.lastLines(id, 60)`，去掉最下面的输入框（横线框、› ❯ > 开头的输入行）和底栏，从最后一个 ⏺ / ●（claude）或 •（codex）开始算回复，最多 8 行 600 字；认不出就给最后 4 行，提示里写 “On screen” 不写 “Last reply”。不传 `lastReply` 时只认屏幕。形状 `LastReply { text; source: 'transcript' | 'screen'; kind: 'reply' | 'lines' }`。
- 纯函数在 `src/agents.ts`：`buildAgents`、`agentOrder`、`agentShortcut`、`rowStatusText`、`titleStatusText`、`formatSince`（照抄 widgets/terminal 的，那边不能 import）。

## 对话主题

`TerminalInfo.title`（程序设的终端标题）。Board 视图显示期间：打开时取一次，之后每 3 秒取一次，收到 `status.changed` 时也取（200ms 内合成一次）；列表关掉就停。旧的结果晚到时丢掉。

## 测试

```bash
pnpm --filter @agentdeck/board-nav-panel test       # Vitest + jsdom + Testing Library，对着 createFakeApi() 的示例白板
pnpm --filter @agentdeck/board-nav-panel typecheck
```

- `test/model.test.ts`：名字、每种状态对应的灯、按位置排序、没有框的工作区、窗口组的名字（`groupNames`）。
- `test/agents.test.tsx`（CO4）：只列 agent、分组顺序、组里按位置、ERROR 在前、Unseen 只在 idle 时算、exited 归 IDLE、右边的时间和提示第一行的状态；从屏幕认 claude（输入框上面）/ codex（› 输入行上面）的回复、认不出给最后几行、太长截断；Board / Agents 切换和记住；组和个数、灯、Unseen 粗体不加颜色、读屏名、单击跳；没有 agent；悬停 350ms 出提示（最后一条回复、Click to jump · ⌥⌘3、aria-describedby）、离开关、状态没变不再读；组装方传的 `lastReply`、On screen、键盘聚焦。
- `test/board-nav.test.tsx`：树形列表、灯和网页图标、exited 灰线、对话主题（轮询和 status.changed 时刷新）、在等你的行浅黄底、窗口组的 “lead” / “sub-1 · api”、单击调 onJump、no workspaces、散放窗口、空白板。

## 不许碰

只改本目录。颜色只用 design-tokens 的变量（`pnpm colors` 会查）。不 import 服务包、Electron、node 内置模块、ui/canvas 的内部；`tools/fakes` 只能在 `test/` 里用。
