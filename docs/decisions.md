# 已定的决策

按时间倒序。改动其中任何一条，先在这里写清楚再动代码。

## 2026-10-25（X6 · 恢复上次会话）

- **重开应用时只要有终端窗口的 tmux 会话没了，就问一次 “Restore your last session?”**（Restore all / Not now）；会话都在（普通 ⌘Q 再打开）不问。tmux 服务在应用开着时没了（`terminal.host-lost`）也问。Not now 之后每个窗口自己有 Restore / Restart。
- **agent 按记下的会话 id 接回**（各适配器的 resume 参数），没记下就新开并说明；**Shell 在原目录重开、上次的命令填进输入行不运行**（`CreateTerminalRequest.prefill`，tmux-host 等提示符画出来后 `send-keys -l`，去掉换行）。自定义命令也按 Shell 恢复，不直接再跑。
- **Shell 上次跑的命令靠 tmux-host 看终端的前台进程组（ps）记下**（`TerminalInfo.foregroundCommand` → `TerminalWindowData.lastCommand`），不读 shell 历史文件（分不清哪个终端）、不往用户的 shell 配置里加钩子。跑得很短的命令记不到，没记到时退回 `startCommand`。

## 2026-10-24（M1 · AgentDeck 的 MCP）

- **AgentDeck 自己提供一个 MCP 服务**（`packages/mcp-server`），白板里的 agent 用它开终端、开工作区（worktree + 分支 + agent）、开网页、看和指挥别的终端。
- **跑在主进程里，走 HTTP**，只听 127.0.0.1，固定端口 47621（被占用时随机）。认证用 `~/.agentdeck/run/mcp-token`，调用者靠请求头里的终端 id 认出来。不用 stdio 小命令。
- **只给 claude 自动挂上**（启动时 `--mcp-config`，和用户自己的 MCP 合并，不改任何配置文件）；codex 以后再说。
- **agent 通过 MCP 做的操作直接执行**，白板上不再确认（claude 调工具时自己会问一次，除非用户放行了）。新开的窗口不抢焦点，只闪一下。

## 2026-10-23（第 2 波合并后）

- **最低 tmux 从 3.3 改成 3.5**，见下面那条。
- **claude 的钩子用 `--settings` 临时注入**：实测和用户自己的钩子合并、不替换（用户开了 `disableAllHooks` 时我们的也被关掉，状态退回看输出活动）。
- **codex 的钩子用 `-c hooks.<Event>=…` 临时注入，并用 `-c hooks.state=…` 只信任我们自己的钩子**（启动前起一次 `codex app-server` 调 `hooks/list` 拿哈希）。不用 `--dangerously-bypass-hook-trust`。拿不到就不带钩子启动，退回看输出活动。
- **状态机兜底**：claude 里拒绝批准、按 Esc 打断都不触发钩子；用户输入后 3 秒没有输出也没有钩子，就算这一轮结束（需要 tmux-host 发 `terminal.input`）。
- **提问永远不自动批准**：claude 的 AskUserQuestion 走 PermissionRequest 钩子，适配器把它转成 question，Approve all 和 Auto-approve 都不碰。
- **嵌入的本地页面**：主进程把本地来源（localhost / 127.0.0.1 / [::1]）响应里的 Set-Cookie 改成 `SameSite=None; Secure`，服务端写的登录 cookie 在 iframe 里能用；页面 JS 写的 cookie、第三方 OAuth、弹窗在 MVP 里用 Open in browser；P1 的独立窗口模式用 `<webview partition>`。

## 2026-10-23

- **MVP 只支持 macOS。** Linux 等 macOS 版能用之后再做；Windows 需要 WSL，不在计划内。CI 仍在 Ubuntu 上跑单元测试，只是不保证 Linux 上能用。
- **tmux 用用户自己装的，要求 ≥ 3.5（推荐 3.6）。** 3.5 才有 `extended-keys-format`，codex 的 Shift+Enter 靠它（F7 实测）；Ubuntu 24.04 自带 3.4 不够。 启动时检测 `tmux -V`；没装或版本太低，显示一页说明（`brew install tmux`）和 Retry，不自动安装。随应用打包 tmux 推迟到 MVP 之后。
- **agent 用登录 shell 的环境启动。** 从程序坞打开的 Electron 拿到的环境很少（PATH 里没有 `/opt/homebrew/bin`、`~/.local/bin`，可能缺登录相关的变量），会导致找不到 claude 或 403。启动时运行一次 `$SHELL -ilc env` 读出环境（超时 3 秒，失败时退回当前进程环境并提示），由 apps/desktop 读出后传给 tmux-host（建会话时 `new-session -e`）和 agent-adapters（检测安装、拼启动命令）。两边都通过构造参数拿到这份环境，不自己去读。
- **claude 在 tmux 里要设 `CLAUDE_CODE_TMUX_TRUECOLOR=1`**，否则它检测到 `$TMUX` 会自己降到 256 色。由 claude 适配器在 LaunchSpec.env 里加。
- **先不推到 GitHub。** 用户给出仓库名后再建私有仓库并推送；在那之前 CI 只在本地跑 `pnpm check`。
- **contracts 并发期间只加不改**；`BranchChoice.from` 改为可选、kill 后发 `terminal.exit`（128 + 信号）见 contracts 0.1.1。

- 2026-10-25：X2（其他 agent 的“等你”文字、Settings › Agents）不做；X10（框选多选、⌘Z / ⌘⇧Z 撤销白板操作）做；X4（Fork 对话）等用户看完使用场景再定。

- 2026-10-25：X4（Fork 对话）做：用 agent 自己的接回参数复制对话（claude `--resume <id> --fork-session`、codex `fork <id>`、pi / omp `--fork`），原来的对话不动。
- 2026-10-25：打包成 macOS APP（.dmg），README 顶部（语言链接上方）放下载链接，指向 GitHub Releases。
- 2026-10-25：GitHub 仓库名 AgentDeck（账号 Loveforwa），用户审完 README 再建仓库、推送。README 正文英文，另有中文、日文等共 7 种语言版本，配截图和 GIF；语气平实，只说工具做什么、举几个例子。
- 2026-10-26：N10 后台 agent（画板 13）先做 claude：钩子加 SubagentStart / SubagentStop，读子 agent 自己的记录，只读、不保存（重开应用后从空开始）。
- 2026-10-26：后台 agent 面板打开时项目框跟着长到装下侧边栏和记录窗口，挤到的框、盖住的窗口挪开；收起时照原样放回（这期间布局被别的操作改过就不动）。插件挂在窗口外框外面的东西（Auto-approve 书签、后台 agent 的小提示、Usage 条）也算进框里，框只变大。
- 2026-10-26：N11 左边栏的历史会话（画板 14）：外形和右边栏一样，按项目 → 工作路径 → agent 分，会话按最后活动倒序；只读各 agent 自己的会话文件；开着的单击跳过去，没开着的 Resume / Fork。
- 2026-10-26：N12 项目框一键排版（画板 15）：Tidy、Columns、Rows 三种排法和 Auto-arrange 开关。Tidy 不改窗口大小；Auto-arrange 开着时新开和关掉窗口都重排（画板上两个“待你定”都按画的来）。
- 2026-10-26：顶栏加回成一条横栏（和 macOS 红黄绿按钮同一行，底色 + 底边线），白板在它下面。推翻 10-25 的“没有横栏、白板铺到最上面”：放大的窗口会盖住顶栏，内容平移到顶栏下面时和文字叠在一起（IS-84）。
- 2026-10-26：放大的窗口在你平移、缩放白板（含 ⌘1、⌘J、⌘−、捏合）时自动还原到原来的位置，视口不动，算一步可以 ⌘Z。放大 / 还原自己的视口动画不触发。
- 2026-10-26：点框标题右上角的排版图标时，框的右上角不动（图标留在指针底下，连点几种排法不用找按钮）；Auto-arrange 因新开、关掉窗口自动重排时仍是左上角不动。
- 2026-10-26：N11 左边栏的实现：占白板左边一列（白板跟着变窄，不浮在白板上），默认收着，收起时只剩顶栏最左边的按钮，开关和宽度（240–480）随白板保存（BoardState.leftPanel，contracts 0.1.12）。会话列表开着时每 15 秒刷新；悬停的说明用系统提示，不写消息数（要读整个文件，DR-62）。/tmp 和 /private/tmp 当成同一个目录（macOS 的链接）；Other folders 里的目录写成 ~ 开头，太长只留最后两层。
