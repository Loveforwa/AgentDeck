# AgentDeck 组件清单

界面零件的文字版：每个零件是什么、有哪些状态、用哪些 token、交互规则、代码在哪。看样子（亮 / 暗两套，预览直接用仓库里的 CSS）去设计系统网页：https://claude.ai/artifact/MhtbtWuttcdQ4b7uEjvbPN 。这份文件和网页内容一致；**两边和代码不一致时以代码为准**，改了 `packages/design-tokens` 或 `packages/ui/**` 的样子，两边一起改（见文末「维护」）。

画新界面、画需求配图、做插件前先查这里，已有的零件直接用，不要重画。插件的规则另见 `docs/plugins.md`。

## 全局规则

1. **暖灰加墨黑。** 底色 `--ground` `--surface` `--raised`，文字 `--ink` `--muted`，线 `--line` `--line-strong` `--line-subtle`。深色是暖深灰不是纯黑，靠 `--raised` 比 `--surface` 亮一档表现“浮起来”。
2. **颜色只表达状态。** 绿 `--status-running` = 运行中；黄 `--status-waiting`（灯、边框）+ `--attention`（文字）= 等你；红 `--status-error` = 出错。另外只有：红色 `--plugin-auto-approve`（Auto-approve 书签和框标签）、蓝色 `--guide`（拖动、多选时的排版反馈）、Clawd 的 `--mascot*`，以及各 code agent 的身份色 `--agent-claude` `--agent-codex` `--agent-pi` `--agent-omp` `--agent-kimi`（2026-10-26 用户定：只用在区分 agent 的小标记上，例如左边栏的 agent 小标题前的小方块和字；方块不是圆点，免得和状态灯混）。分支、项目、文件类型都不上色，agent 也只在这些身份标记上用颜色。
3. **不用渐变、发光、毛玻璃、emoji。** 用 1px 线分隔。只有浮起来的东西（菜单、弹出框、对话框、提示、聚焦或拖动中的窗口）有 `--shadow-float`；贴在窗口边上的标记用更轻的 `--shadow-mark`。✓ ▸ · ⌘ 这类文字符号可以用。
4. **界面文字用英文。** 注释、文档、提交说明可以用中文。
5. **组件里不写颜色值。** `packages/ui/**` 只用 `var(--token)`，`pnpm colors` 和 ESLint 会拦。要新颜色就在 `packages/design-tokens/src/index.ts` 加 token（两套主题都给值，文字类进对比度测试），再 `pnpm --filter @agentdeck/design-tokens gen`。

### 文案

- 菜单项、按钮：句首大写的动词短语，“New terminal”“Stop and close”“Restart and resume”。会打开对话框的加 …（“New workspace…”“Approve all…”），有子菜单的加 ▸。
- 状态：一个词 + “ · ” + 时间：“Running · 4m”“Waiting · 2m”“Idle · now”“Exited”“Error · exit 1”。时间写 now / 4m / 2h / Oct 21。具体原因放悬停（Needs approval / Needs reply）。一轮做完还没看过的 agent 终端写 “Idle · Unseen · now”（CO4，只改文字、不加颜色，聚焦就清）。
- 计数小写：“2 running”“1 waiting”“3 subagents”“5 background agents · 3 running”“✓ 5 done”。
- 并列用 “ · ”：“api-server · feat/oauth”“sub-2 · ui”。分组小标题大写：PLUGINS、SOURCE CONTROL、BOARD、TERMINALS、AGENTS · 6、NEEDS YOU · 2、DONE · UNSEEN · 1。小标签小写：outside workspace、lead。
- Toast 写成已经发生的事实，最多一个动作：“Removed api-server · feat/oauth from the board” + Undo。
- 出错说清发生了什么、怎么办：“Can’t redo: the terminal was restarted. Close it instead.”。界面里的撇号用弯的（’）。
- 灰掉的菜单项把原因写在后面：“Not supported for kimi yet”。
- agent 名、命令、分支、路径用等宽字，其他用界面字体。

### 尺寸和布局

| 项 | 值 |
| --- | --- |
| 字体 | `--font-ui` Inter Variable，`--font-mono` JetBrains Mono Variable（随包带，离线可用） |
| 字号 | `--text-xs` 11 · `--text-sm` 12 · `--text-md` 13 · `--text-lg` 15（只给对话框标题）；`--leading` 1.45；字重 400 / 500 / 600。例外：插件标记 `--plugin-mark-text` 9.5px，侧边栏小标题 10px |
| 间距 | `--space-2xs` 2 · `xs` 4 · `sm` 8 · `md` 12 · `lg` 16 · `xl` 20 · `2xl` 24 |
| 控件 | `--control-sm` 22、`--control-md` 26、行高 `--row` 24 |
| 圆角 | 控件 `--radius-control` 6、窗口 `--radius-window` 8、菜单和对话框 `--radius-menu` 8、右侧面板 `--radius-panel` 10、工作区框 `--radius-frame` 12、圆角容器里的高亮 `--radius-inset` 4。界面上不留直角 |
| 动效 | 只有 `--motion`（140ms，`cubic-bezier(0.2, 0, 0, 1)`）；系统减少动效时为 0。不弹跳、不缩放进场 |
| 顶栏 | 34px，和 macOS 标题栏合成一行，左边留 76px 给红黄绿按钮 |
| 白板 | `--ground` 底，20px 点阵（`--line-strong`），缩到 50% 以下隐藏；缩放 25%–200% |
| 框 / 窗口 | 框标题 36px，窗口标题栏 28px；窗口之间、框之间 20px；屏幕 6px 内吸附 |
| 左边栏 | HISTORY，顶栏最左的按钮开关，单独占一列、离窗口边 4px，宽 240–480，`--radius-panel` |
| 右侧面板 | 离窗口边 4px 浮在白板上，宽 280–480（⌘B），收起是 28px 竖条 |
| 窗口组侧边栏 | 宽 168，在 lead 右边 8px |
| 插件标记 | 挂在窗口外：书签（左下）、后台 agent 提示（右下）贴着下边框外沿；用量条隔 6px 在上或下。不挡终端内容 |

### 交互状态

- 悬停：行和 ghost 控件铺 `--hover`，`--muted` 图标变 `--ink`。
- 选中的行：`--hover` + 600。禁用：`--opacity-disabled` 0.4。
- 键盘焦点：2px `--focus` 实线，控件外 1px，行内 −2px。
- 窗口：聚焦是 `--ink` 边框 + `--shadow-float`；在等你是 `--status-waiting` 边框（聚焦时不显示）；多选是外面 2px `--guide`。
- 窗口的放大、关闭按钮只在悬停或聚焦时出现。

### 对比度（照源值保留，已知不达标）

浅色下 `--status-running`、`--attention` 文字在 `--hover` 底上 4.3:1；`--status-waiting` 灯在 `--ground` 上 2.9:1；`--line-strong` 控件边框 1.5:1（有意做淡，不能只靠它表示“这是控件”）。其余文字组合两套主题都 ≥ 4.5:1。

## 组件

代码路径相对 `packages/ui/`。

### Kit（`kit/`，`@agentdeck/ui-kit`，类名前缀 `ad-`）

| 组件 | 是什么 · 状态 | 规则 | 代码 |
| --- | --- | --- | --- |
| Button | `variant` default（白底细边）/ primary（墨色底，一组最多一个）/ ghost（无边框）；`size` md 26 / sm 22；disabled | 次要在前、主要在最右；删除也用 primary 墨色，不用红；只有图标的要 `aria-label`；光标保持 default | `kit/src/Button.tsx`、`button.css` |
| Menu | 数据驱动：项、分隔线、heading（PLUGINS）、勾选、hint（灰掉的原因、灰字标签）、快捷键、子菜单 ▸、标签前的小标记 `icon`（状态灯，同一层有一项带标记时每项都留 8px 一格）、等宽标签 `mono`（终端名） | ↑↓ Home End 跳过禁用和分隔线，Enter/Space 选，→ 开子菜单，← / Esc 关，根菜单 Esc `onClose`，Tab 关，首字母跳转；键盘打开传 `defaultActive="first"`；自己不定位，放进 `Popover chrome={false}` | `kit/src/Menu.tsx`、`menu.css` |
| Popover | 锚在元素、ref 或坐标上的浮层；放菜单和小卡片（Auto-approve、Usage、分支选择） | 默认 `bottom-start`，放不下翻面并夹在视口里；Esc、点外面关，焦点回原处；最宽 320 | `kit/src/Popover.tsx`、`popover.css`、`position.ts` |
| Dialog | 模态：标题、正文、按钮行；`DialogText` 的 tone default / muted / attention | Esc 关，点遮罩不关；初始焦点 `initialFocus` → `[data-autofocus]` → 正文第一个可聚焦 → 第一个按钮；Tab 不出去；关后焦点还原；会丢东西的话用 attention，危险操作要先勾 “I understand these changes will be lost” | `kit/src/Dialog.tsx`、`dialog.css`；白板的对话框在 `canvas/src/react/dialogs.tsx`、`approvals.tsx` |
| RadioGroup | 原生单选，标签 + 灰色说明，可禁用 | 方向键切换；空心圆点边用 `--muted`（`--line-strong` 太淡） | `kit/src/RadioGroup.tsx`、`radio.css` |
| Toast | 底部居中一句话 + 最多一个动作；墨色底（深色下自动变浅底） | 4 秒消失，有动作 6 秒，悬停或聚焦暂停；最多 3 条；用户 2 秒内打过字时服务发的通知只闪窗口不弹；窗口组件用 `useOptionalToast()`（外面没有 Provider 时为 null） | `kit/src/Toast.tsx`、`toast.css` |
| Field | 对话框和 Settings 里的“标签 + 控件”行：等宽输入框、下拉按钮、勾选框、多行输入 | 标签列 64（Settings 128）；名字、分支、路径用等宽；不合法时 `--ink` 边框 + 原因文字，不只靠颜色 | `canvas/src/react/fields.tsx`、`canvas.css` 的 `.ad-field` `.ad-input` |

### 窗口

| 组件 | 是什么 · 状态 | 规则 | 代码 |
| --- | --- | --- | --- |
| StatusLamp | 红绿灯（MVP v2 · V2）：running 绿实心点 “Running · 4m”；waiting 黄实心点 + 黄边框，文字 `--attention` “Waiting · 2m”（悬停 Needs approval / Needs reply）；error 红点 “Error · exit 1”；idle / starting 空心圈；exited 8×2 短线 “Exited”。**Unseen**（CO4）：idle 的 agent 终端一轮做完还没聚焦过，灯照旧空心圈，标题栏文字 “Idle · Unseen · now”，BoardNav 的 Agents 视图里名字和 “Unseen · now” 粗体墨色。标题栏、框、列表 7px，顶栏 8px | 只有 waiting 要你处理，算进顶栏和框的 “n waiting”、⌘J 顺序、程序坞角标；不能只给文字上色不画点；这些颜色不做别的用途。Unseen 不是一种颜色：只用文字和粗体，不进 “n waiting”、不算角标；一轮结束（`agent.turn-end`）时没聚焦就记上（`TerminalWindowData.unseen`，随白板保存），聚焦就清；Shell、自定义命令没有 | `window-shell/src/WindowShell.tsx`（`StatusDot`）、`widgets/terminal/src/status.ts`（`badgeFor`）；列表里的 `.ad-group-lamp` `.bnav-lamp` `.ad-bg-lamp` |
| WindowShell | 白板上所有窗口的外框：28px 标题栏（灯、等宽名字、灰色标签、状态、小标签如 outside workspace、悬停出现的放大 / 关闭）、内容区、8 个改大小把手；状态 focused / attention / lifted / 多选 / 再打开时闪 600ms | 只能拖标题栏移动（3px 内算单击）；边 6px、角 12px；双击标题栏或 ⌘⇧↩ 放大还原；右键标题栏出窗口菜单；没聚焦时盖一层，第一下只聚焦、滚轮交给内容；⌘ / Shift + 单击加减多选；小于 320×200 或缩到 50% 以下变摘要卡；聚焦和等你的边框不同时出现；插件标记不画在框里 | `window-shell/`（只管样子和手势），白板侧 `canvas/src/react/WindowNodeView.tsx` |
| TerminalWindow | 终端内容：xterm.js 屏幕；摘要卡（最后 3 行，等你时最后一行 `--attention`）；退出条 “Process exited (code 1)” + Restart / Close；整页提示 Connecting… / Starting claude… / Previous session ended（Restore / Restart）/ Command not found: claude（Open Settings / Use Shell instead）；关闭确认只盖这个窗口 “Stop claude · 主题?” + Stop and close | 聚焦时按键给 shell，⌘ 组合键给白板（⌘K ⌘W ⌘Z）；没聚焦也能滚动回看；localhost 链接在白板上开网页；运行中的终端不能换框，拖进别的框弹回并问 Open new（W5）。**选中和复制（IS-143）**：程序不要鼠标时（claude、shell）拖选、双击选词、三击选行由 tmux 做，**松手就复制**进系统剪贴板，高亮随即消失，不用 ⌘C；程序要鼠标时（codex）拖动交给程序，**按住 Option 拖**才是终端自己的选中，再 ⌘C；这种程序里第一次拖动什么都没选上时出一次 Toast “Hold Option to select text”（每个用户一次）。⌘V 粘贴按程序的 bracketed paste 一次发。**右键**（⌃ 单击一样）屏幕出 Copy ⌘C · Paste ⌘V · Send selection to ▸（见 ContextMenus）；“选中的文字”是终端自己的选中，没有时是刚松手复制走的那段（之后在这个终端里按键或左键单击就不算了） | `widgets/terminal/src/TerminalWindow.tsx`、`terminal.css`、`status.ts` |
| BrowserWindow | 网页窗口：工具栏（Back、Forward、Reload、等宽地址栏、Open in browser）+ iframe（localhost）/ webview（外部网站）；状态 加载中、不响应（“localhost:3000 isn’t responding.” + Retry）、地址错误提示行 | 标题栏显示主机名；⌘T 新建，`open_browser` 同一个 origin 复用；可以直接拖进别的框；没聚焦时有遮罩，第一下只聚焦，之后 600ms 让滚轮和点击进网页 | `widgets/browser/src/BrowserWindow.tsx`、`browser.css` |

### 白板（`canvas/`）

| 组件 | 是什么 · 状态 | 规则 | 代码 |
| --- | --- | --- | --- |
| Topbar | 一行 34px：最左是 HISTORY 左边栏的开关（14px 侧边栏图标，Show history / Hide history），然后项目菜单、当前工作区或白板概况、“n running”、“1/2 waiting” 按钮、Approve all…、齿轮。没有横栏，每个按钮自带一块 `--ground` 底 | 项目菜单：项目 › Project settings…、New workspace…、Add project…；waiting 单击 = ⌘J（⌘⇧J 反向）；有请求等批准时才出 Approve all…；齿轮 = ⌘,；为 0 的计数不显示；顶栏本身不接指针，空白处落到白板上 | `topbar/src/Topbar.tsx`、`topbar.css`（只管样子） |
| WorkspaceFrame | 工作区框（一个 worktree 一个分支），标题 36px：项目、分支（等宽灰）、工作区名、插件标签、“Folder not found”、running / waiting 灯、N12 排版图标；状态 默认 / 选中（1.5px 墨色外圈）/ 拖入目标（1.5px 墨色虚线）/ 创建中（虚线 “Creating worktree…”）/ 出错（git 原话 + Use existing branch、Retry、Delete）/ 空（“Right-click to add a terminal”） | 拖标题带着窗口走，单击选中，双击缩到正好装下，右键出框菜单；改大小的边 8px、角 16px；标题太长先截分支再截项目，灯不缩；框之间至少 20px，会挤开别的框；窗口拖到边上框跟着长；⌘ 按住不吸附 | `canvas/src/react/FrameNodeView.tsx`、`canvas.css` 的 `.ad-frame*` |
| （同上）排版图标 | Tidy（紧凑网格，⌈√n⌉ 列，大小不变）、Columns（一行最多 6 个，一样高）、Rows（一样宽），竖线后 Auto-arrange 开关；22×22，灰色，悬停变深，上次用的排法和开着的开关墨色底 | 框里有窗口才出现；点一次算一步撤销；Auto-arrange 只在开关窗口时按上次的排法重排，拖动中不排；右键菜单也有 Auto-arrange new windows | `FrameArrangeButtons`、`canvas/src/model/arrange.ts`、`FrameNode.arrange` |
| ContextMenus | 右键菜单。白板：New terminal ▸ ⌘N、New browser ⌘T、New workspace… ⌘⇧N、Add project…、Show all ⌘1。框：New terminal、New browser、Rename…、Copy path、Reveal in Finder、Open in editor、Open in system terminal、Approval history…、Auto-arrange new windows、PLUGINS、Delete workspace…。终端标题栏：Rename…、Maximize、Send selection to ▸、（Clear、Restart…）、PLUGINS、Copy folder path、Open in another workspace ▸、Fork conversation into… ▸、Background agents…、Close ⌘W。终端内容区（右键、⌃ 单击，CO3）：Copy ⌘C、Paste ⌘V、Send selection to ▸ | 插件在 PLUGINS 小标题下平铺，不套子菜单，开着打钩；用不了的灰掉、原因写在后面；只给 agent 的插件在 shell 终端里不列；网页窗口暂时没有 PLUGINS。**Send selection to ▸**：没有选中的文字时 Copy 和它灰掉；子菜单按框分组（小标题 “SHOP · FIX/CART-TOTAL”，源终端的框在前，散放的在最后 “NOT IN A WORKSPACE”），每行 = 状态灯 + 等宽名字 + 灰字标签（改过的名字或 lead / sub-2 · ui），shell、自定义命令终端也列；在等你的不列，底下一行灰字 “Waiting terminals are skipped”；已退出的不列；最后一项 New terminal here… ▸（同 New terminal 的列表，开在源终端旁边）。选了：跳到目标并聚焦，当作一次粘贴放进它的输入行（bracketed paste，保留换行和 -- 注释，去掉末尾换行），**不按回车**；目标没开 bracketed paste 时多行不贴，Toast “Nothing was sent: zsh would run each line as a command” | `canvas/src/react/BoardMenu.tsx`、`controller.ts`、`plugins/types.ts`（`pluginMenuSection`） |
| LayoutGuides | 只在摆白板时出现的蓝色反馈：对齐线、间距 / 尺寸数字、多选外圈、Shift 框选矩形 | 屏幕 6px 内吸附到边、中线、20 间距、等间距、同宽同高、200px 内附近的框，⌘ 不吸；松手盖住别人就挪到最近的空位（隔 16），不推别人；放大的窗口例外；Shift + 拖空白处框选（碰到就选，⌘ 加选），Esc 取消；一起拖动时各自留在自己的框 | `canvas/src/react/Guides.tsx`、`selection.tsx`、`model/snap.ts`、`model/avoid.ts`、`selection.css` |
| BoardChrome | 左下缩放按钮（“40%”，菜单 25% / 50% / 100% / 200% / Show all ⌘1）、底部快捷键提示一行、空白板提示（“Add a project to get started, or right-click to open a terminal.” + Add project / New terminal） | 快捷键提示放不下从后往前藏、不接指针；手势：窗口上两指滚动给窗口，空白处平移；捏合 / ⌘ + 滚轮以指针为中心缩放；左键或中键拖空白处平移；空格 + 拖哪里都平移（在终端、输入框里打字时不算）；双击不缩放 | `canvas/src/react/Board.tsx`、`ShortcutHints.tsx`、`gestures.ts`、`model/shortcuts.ts` |
| Clawd | 左下角的像素吉祥物，约 10 秒冒出来一次做一件事（举杠铃、写代码、吃饭），6 秒后缩回 | 纯装饰：不接指针、读屏忽略、不挡缩放按钮和提示；减少动效时只显示一帧；`--mascot` 橙色不在别处用 | `canvas/src/react/Clawd.tsx`、`canvas.css` 的 `.ad-clawd*` |

### 插件（规则见 `docs/plugins.md`）

| 组件 | 是什么 · 状态 | 规则 | 代码 |
| --- | --- | --- | --- |
| AutoApproveMark | PL1。终端底边左侧的书签（16px 高，9.5px 半粗体，下面两个角 4px 圆角，`top: 100%`、`left: --space-lg`）：on 红底白字 “Auto-approve”，每次自动批准闪 700ms；needs you `--attention` 底 “Needs you”，悬停写原因（Destructive command / Question for you / Couldn’t approve / Not supported），处理完变回红。框上开着时框标题里 18px 红色小标签。单击书签弹小卡片（300 宽）：since 14:02、最近几条批准、Approval history…、Turn off | 只给 agent 终端（不给 shell、自定义命令、kimi）；挂在框外不挡内容，下边同时有用量条时条放在书签下面；第一次打开先确认（“Turn on Auto-approve?”）；红色是“替你按批准”不是出错，窗口状态照常 Running | `canvas/src/plugins/auto-approve.tsx`、`approvals/model.ts`、`react/approvals.tsx`、`canvas.css` 的 `.ad-auto-approve-*` |
| UsageStrip | PL2。终端上边或下边隔 6px 的 24px 圆角长条：拖动把手、Input、Output、Cache、右边 Context + 46×5 进度条 + 百分比；状态 正常 / ≥85% 变 `--attention` / “No usage data”（悬停写原因）/ Loading… / 拖动中（蓝边 + 落点线）。单击弹小卡片（340 宽）：模型、Context window、Last request、Requests、codex 的 5h / Weekly limit、Move to bottom / top、Hide | 数字照各 agent 自己的写法（claude 52.5k / 1m、codex 27.8K / 475K · 97% left 等，见 `usage-model.ts`）；变窄先藏 Cache（<500）、再藏 Output（<400）、Input（<310），Context 一直在；只贴在自己终端的上下边，在框外、不挡点击；放大时给它留位置；shell 不能开 | `canvas/src/plugins/usage.tsx`、`usage-model.ts`、`canvas.css` 的 `.ad-usage-*` |
| QueueMark | PL3。终端底边左侧的书签（和 AutoApproveMark 同样挂法，白底细边、9.5px），Auto-approve 开着时排在它后面；前面一个 7px 状态点：Queue · 3（灰，没碰到上限）/ Queue · 3 · sends 3:31pm（黄点）/ Sending · 2 left（绿点）/ Queue · 3 · needs you（黄点）/ Queue · 3 · paused（灰）/ ✓ Queue done（灰）/ Queue · 3 · reset time unknown（黄点）；claude 自己会续跑时（2.1.234 起，IS-113）Queue · 3 · claude resumes 3:30pm（灰）、Queue · 3 · claude resuming（绿点）、Queue · 3 · claude waits for Enter（黄点，stale）；PL5 之后按 LimitService：开着 Auto-resume 时 Queue · 3 · resumes 3:31pm（黄点，先等续完）、集群或 Day run 管续跑时 Queue · 3 · waiting to resume（黄点）、Mac 睡过了恢复时间 Queue · 3 · waiting for you（黄点）。悬停写卡片里那一句。单击弹小卡片（380 宽）：标题 Prompt queue · 3 prompts、状态行（等你时 `--attention` 字）、一条一行（序号、文字，悬停出 ↑ ↓ ×）、Add a prompt… 输入框（⌘↩ 加到最后）+ Add、Send next now（agent 空闲才能点）、Pause / Resume、Keep Mac awake 勾选、Sent · N（展开看几点发的） | 只给 agent 终端，claude、codex 能开，别的 agent 灰掉；只在碰到额度上限、到恢复时间 + 1 分钟、agent 空闲时发第一条，之后每做完一轮发下一条；claude 自己续时等它那一轮做完再发，stale 时不粘贴；PL5 起按主进程 LimitService 的列表发：同一账号当时空闲的终端也排上（到它的 resumeAt 发），开着 Auto-resume 的先等续完（resumed）再发，你点 Don’t resume 队列变 Paused，LimitService 没列出时才用 IS-113 那套兜底；颜色只表达状态（绿发着、黄等你或等恢复），不用插件色 | `canvas/src/plugins/queue.tsx`、`queue-model.ts`、`canvas.css` 的 `.ad-queue-*` |

### 后台 agent 和窗口组

| 组件 | 是什么 · 状态 | 规则 | 代码 |
| --- | --- | --- | --- |
| BackgroundHint | N10。主终端底边右侧的小提示（和书签同样挂法，白底细边）：running 绿点 “5 background agents · 3 running”；failed 红点 “… · 1 failed”；done 灰色 “✓ 5 done”（你下一条消息后消失）；没有就不画；面板开着时铺 `--hover` | 单击开 / 关面板；书签在左、提示在右，下边的用量条放到它们下面；提示消失后终端菜单的 Background agents… 还能打开；不保存、不恢复 | `canvas/src/react/Background.tsx`、`model/background.ts`（`hintOf`）、`background.css` |
| GroupSidebar | N2 窗口组侧边栏（lead 右边 8px、宽 168、和 lead 一样高）：标题 “3 subagents”；有后台 agent 时分 TERMINALS / BACKGROUND · READ-ONLY 两组；行 = 灯 + “sub-2 · ui”（后台的加用时，done ✓ + 时长，failed 红色时间）；底部 Show all、Collapse group | 行状态：悬停 `--hover`，选中（右边显示的那个）`--hover` + 600，在等你 `--attention-soft`（只有子终端会等）；显示方式 `group.view`：one（停靠一个、其余收起）/ all（平铺）/ collapsed；收起的照常在 tmux 里跑、照样算 waiting 和 ⌘J，跳过去时先显示；关 lead 时平铺开、组解散；标题栏灰字 lead / sub-2 · ui | `canvas/src/react/GroupSidebar.tsx`、`model/groups.ts`、`group-sidebar.css` |
| BackgroundTranscript | 选中后台 agent 时在停靠处开的只读记录窗口：类型（等宽）、任务、Read-only 胶囊、实时日志（等宽，提示和正文墨色、出错红色）、底部 “This agent runs inside claude. To change or stop it, tell the main agent.” + token 数；状态 Loading… / No transcript yet / n earlier lines not shown / Failed: 原因 | 不能输入、批准、停止；× 或再点一次那一行关掉 | `canvas/src/react/Background.tsx`（`BackgroundTranscript`）、`background.css` |

### 面板

| 组件 | 是什么 · 状态 | 规则 | 代码 |
| --- | --- | --- | --- |
| SidePanel | 右侧面板外壳：宽 280–480、`--radius-panel`、顶上让开顶栏的灯和齿轮；收起是 28px 竖条（Expand panel、分支图标，没有聚焦的工作区时变淡，有未提交改动时右上角 6px 黄点） | ⌘B 开关，宽度和开关跟白板保存；浮在白板上，四周露点阵；Fit、居中、⌘1 不会算到面板底下；跟着焦点：聚焦窗口 → 它所在工作区的源代码管理，什么都没聚焦 → BoardNav | `canvas/src/react/Workbench.tsx`、`canvas.css` 的 `.ad-panel*` |
| BoardNav | 快速定位列表（V5）。顶栏右边两段切换 **Board / Agents**（CO4，按下的那段 `--hover` 底 + 600，记住上次选的）。Board：BOARD → 项目 → 工作区（分支）→ 窗口；行 = 灯（网页是小窗口图标）+ 名字（终端等宽）+ 组身份 lead / sub-1 · api + “· Waiting” + 对话主题；在等你的行 `--attention-soft`。Agents：标题 “AGENTS · 6”，只列 agent 终端，按状态分组 ERROR · NEEDS YOU · RUNNING · DONE · UNSEEN · IDLE（小标题带个数，空组不画）；行是同一个零件：灯 + 等宽名字 + 灰字 “项目 · 分支” + 组身份，右边 “Waiting · 2m”（`--attention`）/ “4m” / “Unseen · now”（粗体墨色，名字也粗体）/ “1h” / “exit 1 · 2m”（`--status-error`）/ “Exited”；底下灰字 “⌥⌘1–9 jumps to rows 1–9. Shells and web pages are under Board.”。**悬停提示**（Agents 的行，350ms；Tab 聚焦马上出）：墨色底（`--ink` / `--on-ink`，和 Toast 一样深色主题下变浅底）、最宽 320、`--radius-control`、`--shadow-float`，放在行的左边：粗体 “claude · api · feat/pool · Idle · Unseen · now”，淡色 “Last reply”，回复（最多 8 行；应用里先读会话记录 `agents.lastReply`，读不到再认屏幕），淡色 “Click to jump · ⌥⌘3”；状态 Reading… / Nothing to show yet. / 认不出回复时小标题写 On screen | 按白板上的位置排（Agents 组里也是）；单击跳过去（同 ⌘J），⌥⌘1–9 跳 Agents 的前 9 行（不管面板显示哪个视图）；颜色只在灯上和等你、出错的文字上，Unseen 不加颜色；空状态 “Nothing on the board yet.”、“no workspaces”、“no windows”、最后一组 “Not in a workspace”、“No agents on the board.”；读屏名 “claude, Running, Check local git history”、“claude, Idle · Unseen, api · feat/pool”；提示离开、单击、滚动就关，`role="tooltip"` | `panels/board-nav/src/BoardNav.tsx`、`AgentsView.tsx`、`agents.ts`、`lastReply.ts`、`model.ts`、`board-nav.css`；⌥⌘n 在 `canvas/src/model/shortcuts.ts`、`controller.ts`（`agentOrder`、`jumpToAgentRow`），Unseen 在 `canvas/src/model/unseen.ts` |
| ScmPanel | 源代码管理（照 VS Code）：工作区名和路径（单击复制）、分支按钮和下拉（搜索、被别的工作区占用的灰显写 in …、New branch…）、ahead / behind、Merging / Rebasing 标、提交框、Merge Changes / Staged Changes / Changes 文件夹树、提交图（N5）、SKILLS · MCP（N9） | ⌘↩ 提交（“Commit 3 files” / “Commit all 5 changes”）；悬停行出 + / − / 放弃，放弃先确认；单击文件看只读 diff，双击在编辑器打开；有改动切分支问 Switch with changes / Stash and switch / Cancel；状态字母 M A D R C U 灰色，冲突 ! 用 `--attention`；提交图只用墨色和三种暖灰，不给分支上色；只在换工作区、agent 一轮结束、自己做完操作、点 Refresh 时刷新，不监听文件 | `panels/scm/src/ScmPanel.tsx`、`ChangeList.tsx`、`BranchPicker.tsx`、`CommitGraph.tsx`、`SkillsSection.tsx`、`scm.css` |
| HistoryPanel | 左边栏历史会话（N11，画板 14）：HISTORY 标题、搜索 “Search sessions”（搜标题、第一条消息、分支，搜索时全部展开；没有按 agent 筛选的一栏，2026-10-26 去掉了）；项目 → 工作路径（主目录和每个 worktree，▾/▸ + 分支 + 数量；不在项目里的归到 Other folders）→ agent 小标题（7×7、2px 圆角的小方块 + “CLAUDE · 14”，方块和字都是这个 agent 的身份色 `--agent-*`）→ 会话（只有在白板上开着的有灯，标题，时间 now / 5m / 2h / 3d / 12 Oct），每组 5 条后 “Show 10 more”；空状态 Reading sessions… / Couldn’t read the session history. / No sessions yet. / No matching sessions. | 顶栏最左的按钮开关（“Show history” / “Hide history”，开着时按下态），左边单独一列、离窗口边 4px、宽 240–480（拖右边），开关和宽度存在 `BoardState.leftPanel`；开着的单击跳过去，悬停写 On board；没开着的悬停出 Resume 和 ⋯（Fork into… ▸、Copy session id、Reveal file in Finder），kimi 不能 fork（灰掉写原因）；身份标记用方块不用圆点，免得和状态灯混；状态色只在灯上，agent 色只在 agent 小标题上 | `panels/history/src/HistoryPanel.tsx`、`model.ts`、`history.css`；外壳 `canvas/src/react/Workbench.tsx`、`canvas.css` 的 `.ad-left-panel*`；组装 `apps/desktop` 的 `HistorySidebar.tsx` |
| SettingsDialog | 设置（X12）：左边 168 宽导航（项目、General），右边字段页。项目页：Name、Path、Base branch、Worktree location、Files to copy、Setup command；General：Closing the window、Notifications、Default agent、Editor command、Terminal app；左下 Open settings.json | 入口：顶栏齿轮、项目菜单 › Project settings…、⌘,（输入框里也生效）、应用菜单；没指定项目时停在聚焦窗口或选中框的项目上；换页保留草稿；Save 只发改了的字段，都成功才关，失败弹 Toast、不关 | `canvas/src/react/SettingsDialog.tsx`、`model/settings.ts`、`canvas.css` 的 `.ad-settings*` |

### 参考

| 组件 | 内容 | 代码 |
| --- | --- | --- |
| Icons | 组件里的线条图标：Maximize、Restore、Close（12px，线宽 1.3）；Chevron、齿轮（15px）、左边栏开关（14px）；菜单的勾和子菜单箭头；Tidy、Columns、Rows、Auto-arrange（14px）；Branch、Refresh、Stage、Unstage、Discard、Back、展开、下拉、Check（16 网格，线宽 1.4）；网页小窗口图标（10px）。新图标照样画：`fill="none"`、`stroke="currentColor"`、圆头；不用图标字体、位图、emoji；状态不用图标，用灯 | `window-shell/src/WindowShell.tsx`、`topbar/src/Topbar.tsx`、`kit/src/Menu.tsx`、`canvas/src/react/FrameNodeView.tsx`、`panels/scm/src/icons.tsx`、`panels/board-nav/src/BoardNav.tsx` |
| SpecParts | 设计画布「需求 · 界面零件」页画需求配图用的零件：Term（→ WindowShell + TerminalWindow）、Frame（→ WorkspaceFrame）、Web（→ BrowserWindow）、Menu（→ Menu、ContextMenus）、Dialog（→ Dialog、Field）、Note（→ Toast、Popover）、Panel（→ ScmPanel）、Top（→ Topbar），以及只用于配图的 Arrow、Cursor、Callout。只用来画流程，产品界面用真实组件 | 设计画布 `project/spec/*.dc.html` |

## 设计画布和代码不一致的地方（以代码为准）

- 零件页（Term、Top）和早期画板把 waiting 画成橙色 #C2410C、running 点是墨黑，早于 V2 红绿灯；Frame 零件圆角 8（代码 `--radius-frame` 12）。
- PL1 画板把 Needs you 画成橙色 #B45309，窗口边框也是橙色。代码：书签 `--attention` 底 + `--on-attention` 字，窗口边框 `--status-waiting`。
- 各画板的等你黄不统一（#E8A317、#BF8700、#8A6700），出错红有 #B91C1C。代码：灯和边框 `--status-waiting`，文字 `--attention`；红只有 `--status-error`。
- 画板 14 的顶栏画成 36px，代码是 34px。

画新需求图时照上面的 token 画，不照旧零件的颜色。

## 维护

- 改了 `packages/design-tokens` 或 `packages/ui/**` 的样子、状态、文字或交互：同一次提交里改这份文件，并更新设计系统网页对应的卡片。
- 设计系统网页的预览用的是仓库 CSS 的拷贝（`components/bundle.css` = `packages/ui/**` 的 CSS 原样拼起来），tokens 是 `packages/design-tokens/src/index.ts` 的拷贝，记录的来源是 main@6cfff24。CSS 或 token 变了要重新拼一份发上去。
- 新加零件：先在这里加一行（是什么 · 状态、规则、代码），再在网页上加一张卡片。
