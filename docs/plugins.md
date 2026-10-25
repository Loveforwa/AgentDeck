# 插件手册

做插件、改插件之前先读这份。这里记规则、每个插件的登记表，以及定下来的决定。新的决定和踩过的坑直接加在这里；插件的样子以设计画布“插件能力”页为准（https://claude.ai/artifact/2GtB5izXeQSV3NecUYuLAo ）。任务是 MVP 任务表的 M7。

## 插件是什么

插件是贴在白板某个东西上的小功能，开着时在那个东西旁边有一个看得见的标记。例子：Auto-approve（终端底边左侧的红色小书签）、Usage 用量记录（终端上方或下方的细长条）。

入口统一放在右键菜单里：右键一个东西，菜单里有一组插件项，打钩表示这个插件在它上面开着，再点一次关掉。用不了的插件项灰掉，并写原因（例如 “Not supported for kimi”）。

插件在本机运行，就是 AgentDeck 里的一个模块，不另做隔离。

## 第一件事：这个插件能贴在哪些东西上

白板上有这几种东西，每个插件开工前必须先回答它能贴在哪几种上，写进下面的登记表：

| 东西 | 说明 |
| --- | --- |
| 终端窗口 | 跑 claude、codex、pi、omp、kimi 或 shell 的窗口。要再分：支持哪些 agent |
| 网页窗口 | 白板上打开的网页 |
| 工作区框（项目框） | 一个 worktree / 分支，里面放终端窗口和网页窗口。贴在框上 = 对框里的东西都生效，之后在框里新开的也生效 |
| 白板 | 整块白板，看全局（例如整台电脑的用量） |

贴在框上和贴在窗口上同时存在时：窗口上单独关掉，只关它自己；框上关掉，框里的都关。

## 每个插件要写清楚的事

- 能贴在哪些东西上、支持哪些 agent，不支持的怎么显示。
- 开着时的标记长什么样、放在哪里；标记能不能拖。
- 开关状态随白板保存，重启后还在。
- 关掉以后不留东西（标记、监听、写过的文件都清掉）。
- 不改用户自己的配置（`~/.claude*`、`~/.codex`、`~/.pi`、`~/.omp`、`~/.kimi` 等）。要给 agent 传东西，用 AgentDeck 启动它时的参数或环境变量。
- 读不到数据、操作没生效时怎么告诉用户（不瞎猜数字，不悄悄失败）。
- 外观用 design-tokens 和 ui/kit 的零件，不写颜色值。颜色只表达状态：“需要你处理”用橙色；Auto-approve 开着用红色（插件标记的专用 token，见 design-tokens）。

## 登记表

| 插件 | 终端窗口 | 网页窗口 | 工作区框 | 白板 | 标记 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| Auto-approve | ✓ claude、codex 走钩子；omp 看屏幕发键；pi 从不问。kimi 暂不支持（DR-56） | ✗ | ✓ 框里所有终端 | ✗ | 终端底边左侧的红色小书签 “Auto-approve”；需要你处理时临时变橙 “Needs you”；框上开着时框标题里红色小标签 | 后端和界面都做完（PL1），等真应用里验收 |
| Usage 用量记录 | ✓ claude、codex、pi、omp、kimi（自己读各 agent 的会话文件，见 DR-55；kimi 新建会话靠推断，悬停写明）；shell、自定义命令灰掉 “Not supported for shell” | ✗ | 以后（项目用量） | 以后（整台电脑） | 终端上方（默认）或下方一条 24px 圆角条，和终端一样宽、隔 6px：in、out、cache 读 / 写、ctx + 进度条 + 百分比，85% 起变黄；拖左边的点阵只能换到上 / 下边；点开小卡片 | 后端和界面都做完（PL2），等真应用里验收 |

## 代码在哪里（PL0）

- 登记表：`packages/ui/canvas/src/plugins/index.ts` 的 `PLUGINS`。加插件 = 写一个 `PluginDefinition`（`plugins/types.ts`）加一行：`attachesTo`（terminal / browser / frame / board）、`agents`、`availability`（不能开时的原因）、`isOn`、`toggle`、`menuExtras`、`WindowMark` / `FrameMark`（标记组件）。右键菜单的 PLUGINS 一组和标记都从登记表来，不用改菜单和窗口节点。
- 菜单零件：ui-kit `Menu` 的 `{ type: 'heading' }`（PLUGINS 小标题）和 `MenuItem.hint`（灰掉的原因）。
- 标记的颜色和尺寸：design-tokens 的 `--plugin-auto-approve` / `--plugin-auto-approve-fg`、`--plugin-mark-height` / `--plugin-mark-text` / `--plugin-mark-radius`。新插件要新颜色时在 design-tokens 加专用 token。
- Auto-approve 的界面：`plugins/auto-approve.tsx`（书签、小卡片、框标签）、`approvals/model.ts`（状态、开关、写进白板）、`react/approvals.tsx`（第一次开的确认、Approval history、Approve all）。
- Usage 的界面：`plugins/usage.tsx`（用量条、拖动换边、小卡片、watch / unwatch）、`plugins/usage-model.ts`（开关和位置、k / M 缩写、悬停和卡片文字、放大时给条留的位置）。

## 不是插件的东西

- Skills · MCP：放在右侧源代码管理面板里，作为一个可折叠的小节，和 Git 的内容放在一起（v3）。
- 子 agent 窗口组：v3 的 N2，主 agent 旁边一个侧边栏，选中一个子 agent 就在右边打开它的终端。

## 决定记录

- 2026-10-25：插件单独一页画（设计画布“MVP 插件”页）。第一批只做 Auto-approve 和用量记录。
- 2026-10-25：Auto-approve 按单个终端开，也能按整个工作区框开；书签放终端底边左侧；所有 agent 都要支持，每个 agent 的批准提示不一样（有的是 yes / no，有的有 always），要逐个调研后再做。选择题和要你打字回答的不替你答。破坏性命令（Settings 里的 `approvals.destructivePatterns`）照样停下来等你（按默认，用户没另说）。
- 2026-10-25：CC Switch 用量：先看 CC Switch 能读到什么；做不到的，自己从各 agent 的本地会话记录里读。显示输入、输出、缓存 token 和当前对话的上下文长度。
- 2026-10-25：CC Switch 调研结论（DR-55）：CC Switch 的数据是事后扫会话文件得到的，最快 1 分钟一次，没有上下文长度，所以条上的实时数字由我们自己读会话文件；CC Switch 只做以后的历史数据源和 “Open in CC Switch”。条只贴在终端上下两边，不离开终端。
- 2026-10-25：Auto-approve 调研结论（DR-56）：claude、codex 用 PermissionRequest 钩子回 allow；kimi 看屏幕发 1；omp 发 ↑ ↵（待核对）；pi 没有确认框。看屏幕的做法要在 known.ts 记 agent 版本。
- 2026-10-25：Approve all 不设快捷键。
- 2026-10-25（第二次）：Auto-approve 先做 claude、codex、omp、pi 四个，kimi 暂不做。书签缩小，只写 “Auto-approve”，红色；没替你按、需要你处理时临时变橙，只写 “Needs you”（原因放在悬停里）。破坏性命令按常见命令匹配（不只看开头），选择题、要打字回答的都照常等。
- 2026-10-25（第二次）：不接 CC Switch，用量插件改名 Usage，是我们自己的用量记录工具。
- 2026-10-25：PL1 界面：第一次打开 Auto-approve 时问一句（设计画布 PluginApprove 第 1 步），之后不再问（记在界面的 localStorage）。开关以主进程服务为准，界面点开关只调服务，收到 `approval.auto-approve-changed` 再写进白板；重开应用由 apps/desktop 恢复一次，界面不重复推，只在终端换了 terminalId 时补推。Approve all 按任务定为“有 1 条以上在等批准就显示”（SpecStatus 原写 2 条）。网页窗口目前没有插件，右键网页不出 PLUGINS 一组。
- 2026-10-25：PL1 后端：破坏性命令的默认名单补全（在整段命令里找，见 packages/agent-adapters 的 `DEFAULT_DESTRUCTIVE_PATTERNS`）。替你按不了的时候（破坏性、选择题 / 要你打字、没按成）服务只给原因（`approval.needs-you`），界面统一显示 “Needs you”。
- 2026-10-25：PL2 界面：Usage 的开关和位置存在终端的 `TerminalWindowData.usage`（`{ on, position: 'top' | 'bottom' }`，contracts 只加了可选字段），随白板保存；关掉时记得上次贴在哪边。条画着（开着、窗口在白板上、终端有 terminalId）时 `usage.watch`，收起、Hide、关窗口、换 terminalId 时 `unwatch`；窗口滚出视口不 unwatch（来回平移不反复重读会话文件）。上下文按服务给的 percent ≥ 85 变黄（`--attention`）。放大窗口时给条留出 30px（条在上边就往下让）。下边同时挂着 Auto-approve 书签时，条放在书签下面。
- 2026-10-25：Usage 条上写全称 Input / Output / Cache / Context，每项悬停有一句说明；Cache 只写读，缓存写放在悬停里；终端窄时先藏 Cache，再藏 Output、Input。Context 照 agent 自己界面的写法算，和终端里看到的一致：kimi 的 k 按 1024、百分比向上取整（68.8k/977k、8%）；codex 先扣 12000 的基线；别的按 1000 进位、四舍五入（`contextDisplay`）。
- 2026-10-25（验收后）：只有 agent 窗口才有自动批准。shell、自定义命令的终端菜单里没有 Auto-approve，也不挂书签；框上开 Auto-approve 时只管框里的 agent 终端（IS-68）。
- 2026-10-25（验收后）：Usage 里的额度、上下文百分比，取整方式和对应 agent 自己界面上的一致；各家额度设计不一样（codex 写 “x% left”，就照它的算法显示），不统一成一种写法（IS-69）。
- 2026-10-25（IS-69 调研结论）：各家写法照源码（出处写在 `usage-model.ts` 的 `AGENT_FORMATS`）。codex 0.164：额度写 “x% left”，会话文件的 used_percent 先由 app-server 四舍五入成整数再 100 − used（0.6 → 99% left，0.4 → 100% left），我们照写 “99% left (resets 14:05)”，标签 5h limit / Weekly limit，重置时间同一天只写时间、否则加 “on 27 Oct”，12 / 24 小时制看系统；上下文先扣 12000 基线、round 出 left，写 “97% left”（codex 底栏和 /status 都这么写），进度条按 100 − left；token 数大写 K、<10 两位小数 <100 一位（Rust 的一半取偶）：27.8K / 475K。claude：/context 的百分比 Math.round(tokens / window × 100)，token 数 Intl compact 小写去 .0：52.5k / 1m、5%。pi：底栏 tokens / window × 100 一位小数，52k / 1.0M、5.2%。omp：状态栏一位小数，52K / 1M、5.2%。kimi 不变（68.8k / 977k、8%）。claude（/usage）、omp（状态栏的 usage 段，5h / 7d 用 Math.round）、kimi（/usage 的 Plan usage，“x% used” 用 Math.round）自己也显示额度，但我们读的会话文件里只有 codex 带额度，别家现在不显示额度，以后接上时照各自的写法。
