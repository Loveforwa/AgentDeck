# 已定的决策

按时间倒序。改动其中任何一条，先在这里写清楚再动代码。

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
