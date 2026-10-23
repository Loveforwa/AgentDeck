# 已定的决策

按时间倒序。改动其中任何一条，先在这里写清楚再动代码。

## 2026-10-23

- **MVP 只支持 macOS。** Linux 等 macOS 版能用之后再做；Windows 需要 WSL，不在计划内。CI 仍在 Ubuntu 上跑单元测试，只是不保证 Linux 上能用。
- **tmux 用用户自己装的，要求 ≥ 3.3。** 启动时检测 `tmux -V`；没装或版本太低，显示一页说明（`brew install tmux`）和 Retry，不自动安装。随应用打包 tmux 推迟到 MVP 之后。
- **agent 用登录 shell 的环境启动。** 从程序坞打开的 Electron 拿到的环境很少（PATH 里没有 `/opt/homebrew/bin`、`~/.local/bin`，可能缺登录相关的变量），会导致找不到 claude 或 403。启动时运行一次 `$SHELL -ilc env` 读出环境（超时 3 秒，失败时退回当前进程环境并提示），由 apps/desktop 读出后传给 tmux-host（建会话时 `new-session -e`）和 agent-adapters（检测安装、拼启动命令）。两边都通过构造参数拿到这份环境，不自己去读。
- **claude 在 tmux 里要设 `CLAUDE_CODE_TMUX_TRUECOLOR=1`**，否则它检测到 `$TMUX` 会自己降到 256 色。由 claude 适配器在 LaunchSpec.env 里加。
- **先不推到 GitHub。** 用户给出仓库名后再建私有仓库并推送；在那之前 CI 只在本地跑 `pnpm check`。
- **contracts 并发期间只加不改**；`BranchChoice.from` 改为可选、kill 后发 `terminal.exit`（128 + 信号）见 contracts 0.1.1。
