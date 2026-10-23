# @agentdeck/tmux-host

AgentDeck 自己的 tmux 实例：`tmux -L agentdeck -f packages/tmux-host/tmux.conf`。所有 agent 进程都跑在里面，界面只为视口里的终端 `tmux attach`，移出视口就 detach。

## 现在有什么（F7）

这一步只有配置、试验脚本和结论。TerminalHost 的 TypeScript 实现（T1）在第 2 波线 1 做，到时在这个包里加 `package.json` 和 `src/`。

| 文件 | 内容 |
| --- | --- |
| `tmux.conf` | 最终配置，每一项都有注释说明为什么 |
| `scripts/trial.sh` | 试验入口：起会话、attach / detach、跑下面的检查、清理 |
| `scripts/lib.mjs` | 公用：干净环境、起会话、node-pty + @xterm/headless 模拟终端窗口、xterm 查询应答 |
| `scripts/timing.mjs` | attach 到首屏、detach 的时间，20 轮取中位数 |
| `scripts/keys.mjs` | 按键、粘贴、鼠标、焦点、颜色、OSC 透传（窗格里跑 `keyprobe.py` 记下收到的字节） |
| `scripts/commands.mjs` | capture-pane、pipe-pane、display-message、list-sessions、退出码、钩子、大小、历史和内存、隔离 |
| `scripts/agent.mjs` | 真实 claude / codex：同一组按键直接跑一遍、经过 tmux 跑一遍，逐项对比 |
| `scripts/keyprobe.py` | 按键探针 |

## 不许碰

只改 `packages/tmux-host/`。不改 contracts。试验只用 `-L agentdeck`，不碰用户默认的 tmux 服务（`tmux ls` 那个）。

## 怎么跑

```bash
packages/tmux-host/scripts/trial.sh all        # 全部检查，最后 kill-server
packages/tmux-host/scripts/trial.sh keys       # 只跑其中一项：timing / keys / commands / agent claude / agent codex
packages/tmux-host/scripts/trial.sh start demo -- claude   # 起一个会话
packages/tmux-host/scripts/trial.sh attach demo            # 在你的终端里接上看（没有前缀键；另开终端 trial.sh detach demo 断开）
packages/tmux-host/scripts/trial.sh cleanup                # tmux -L agentdeck kill-server
```

第一次运行会把 node-pty 1.1.0 和 @xterm/headless 6.0.0 装到 `~/.cache/agentdeck/trial-deps`（可用 `AGENTDECK_TRIAL_DEPS` 改），不进仓库、不改 lockfile。`agent` 会真的调用模型：只发 “Reply with just the word OK” 和数数这类提示词；claude 用 plan 模式，codex 用只读沙箱和临时 `CODEX_HOME`（复制 auth.json 和 config.toml，加上对仓库的信任），不改 `~/.codex`。claude 的“长输出”和“忙”用 `! seq 1 80`、`! sleep 30`（用户自己执行的命令，不经过模型）。

测试环境：macOS 26.4.1（arm64），tmux 3.6a，claude 2.1.291，codex-cli 0.159.2，node 25.9.0。

## 结论

经过 tmux 一层后，claude 和 codex 的按键、粘贴、滚动、颜色和直接在 xterm 里跑一致（下面的表全部通过）。前提是界面层做到「T2 / T3 必须做的事」里的几条，其中最重要的是 **xterm 要回答 tmux 的查询**，否则每次 attach 后 5 秒内按 Esc 会慢 500ms。attach 到首屏 10–20 ms（p90 不到 25 ms），结束 pty 断开 1–2 ms，白板平移时反复接上、断开没有问题。

### 测量数据

`timing.mjs`，120×32，每种 detach 方式各 20 轮，attach 共 40 轮。单位 ms，“中位数 / p90”，取最后一次完整运行（`trial.sh all`）。

| 会话 | attach 到第一个字节 | attach 到首屏 | detach-client 到 attach 进程退出 | 结束 pty（SIGHUP）到进程退出 | 结束 pty 到 tmux 里看不到这个客户端 |
| --- | --- | --- | --- | --- | --- |
| 200 行彩色输出 | 8.5 / 15.8 | 10.0 / 17.7 | 3.5 / 6.6 | 0.9 / 2.2 | 4.7 / 7.2 |
| 真实 claude（74 行历史） | 13.1 / 17.5 | 14.7 / 19.3 | 4.3 / 6.5 | 1.5 / 2.7 | 8.6 / 12.1 |
| 真实 codex（备用屏） | 15.4 / 19.8 | 16.9 / 21.4 | 5.9 / 7.4 | 1.9 / 3.0 | 10.1 / 12.5 |

- 几次运行之间 attach 到首屏的中位数在 10–20 ms 之间浮动，p90 都在 25 ms 以内，最大值没超过 30 ms。
- “detach-client” 一列包含起一次 `tmux detach-client` 命令进程的时间（约 4 ms）。T2 移出视口时直接结束 pty 进程就行，最快。
- “看不到这个客户端”是轮询 `list-clients` 得到的，每次轮询要起一个 tmux 进程，所以偏大。

其他数据：

| 项目 | 结果 |
| --- | --- |
| 普通按键经过 tmux 的延迟（`a`） | 0.2 ms（直接 0.2 ms） |
| Esc 经过 tmux 的延迟（xterm 回答了查询） | 1.4 ms（直接 0.2 ms） |
| Esc，xterm **不**回答 XTVERSION / OSC 10/11，attach 后 5 秒内 | **501 ms** |
| tmux 服务基线内存 | 3.5–4 MB |
| 一个窗格存满 1 万行“像 claude 的输出”（110 列、真彩色、制表符） | +33 MB（约 3.5 KB/行，tmux 满了一次删一批，实际停在 9969 行） |
| 5 万行 60 列纯 ASCII | +35 MB |
| 5 万行像 claude 的输出 | +170 MB |

### 最终配置要点

完整配置和每项理由见 `tmux.conf`。和任务单里列的选项相比，有几处是实测后改的：

| 选项 | 值 | 为什么 |
| --- | --- | --- |
| `prefix` / `prefix2` | None | 前缀键会被 tmux 吃掉 |
| 默认绑定 | 全部 `unbind -a`（prefix、root、copy-mode、copy-mode-vi），只加回鼠标和回滚需要的 | root 表里有右键菜单等 tmux 自己的界面 |
| `mouse` | on | off 时 tmux 不把鼠标事件交给程序（codex 要鼠标） |
| 滚轮 | 程序要鼠标 → 转发；备用屏 → 转成方向键；否则进 copy-mode 并立刻滚 3 行，`-e` 滚到底自动退出 | 外层 xterm 在备用屏里没有回滚，claude 的回滚只能靠 tmux 历史 |
| copy-mode 里的鼠标事件 | 显式绑成空操作 | 否则落到 `Any` 上，点一下就退出回滚 |
| `copy-mode-position-format` | '' | 回滚时不显示 “[12/345]” |
| `default-terminal` | tmux-256color | macOS 26 和主流 Linux 都有这个 terminfo |
| 外层能力 `RGB,extkeys,...` | **不写在配置里**，由 attach 的 `-T` 给 | 写成 `xterm*:RGB` 会让 Terminal.app attach 时颜色错；见问题 4 |
| `COLORTERM` | truecolor（`set-environment -g`） | 从访达启动的 Electron 没有它 |
| `CLAUDE_CODE_TMUX_TRUECOLOR` | 1 | **claude 看到 `$TMUX` 就主动降到 256 色**；见问题 3 |
| `update-environment` | '' | 会话环境只由 tmux-host 给，和谁 attach 无关 |
| `extended-keys` | **on**（不是 always） | claude、codex 启动后都会申请（`#{pane_key_mode}` = Ext 2），用 on 就够；always 会让 zsh 之类没申请的程序收到 `ESC[13;2u` 乱码 |
| `extended-keys-format` | csi-u | 默认 xterm 格式（`ESC[27;2;13~`）codex 不认，Shift+Enter 被吞掉（实测） |
| `escape-time` | 0 | 本机 pty 不需要等；Esc 是 claude 的“打断” |
| `focus-events` | on | 焦点事件转给程序 |
| `set-clipboard` | on | copy-mode 选中和程序发的 OSC 52 都能写到外层剪贴板；external 会丢掉程序发的 |
| `allow-passthrough` | on | `DCS tmux;` 包着的 OSC 9 等能到外层（只在 attach 时） |
| `set-titles` | on，`#{pane_title}` | agent 设的标题到 xterm 的 onTitleChange |
| `status` | off | |
| `display-time` | **1** | 0 的意思是“一直显示到按键为止”，不是不显示 |
| `activity-action` / `silence-action` | **none** | 不是 none 时：visual off → 每次输出给客户端发 BEL；visual on → 窗格最后一行盖上 “Activity in current window”（实测） |
| `monitor-activity` / `monitor-silence` | on / 3 | 只为了 `#{window_activity}` 和两个 flag 可轮询；事件由 tmux-host 自己算，见问题 6 |
| `history-limit` | **10000** | 5 万行 claude 输出约 170 MB/窗格，6 个 agent 就是 1 GB；1 万行约 33 MB |
| `window-size` / `aggressive-resize` | latest / off | 两处 attach 时跟最近活动的客户端；只剩一个时跟它；没有客户端时保持（实测） |
| `default-size` | 120x32 | new-session 不给 -x -y 时 |
| `remain-on-exit` / `remain-on-exit-format` | on / '' | 进程退出后保留窗格读退出码，底部不显示 tmux 的 “Pane is dead” |
| `exit-empty` | on（默认） | 最后一个会话结束服务就退出；见问题 7 |

### 按键、粘贴、鼠标、颜色（`keys.mjs`）

链路和 T2 一样：xterm（headless）→ node-pty → `tmux attach` → tmux 服务 → 窗格里的探针。发的字节就是 xterm.js 对这些键的编码，所以“探针收到的 = 发出的”就是一致。

- 原样到达：a、Esc、⌃C、Tab、Shift+Tab、Enter、Backspace、⌃A、⌃B（tmux 默认前缀）、⌃Z、⌃R、方向键、Delete、PageUp/Down、F1/F5/F12、Option+b、Option+Enter、Ctrl+Left、Shift+Up、Option+Backspace、中文、2000 字节连续输入。
- 应用光标键模式（`ESC O A`）、焦点事件、bracketed paste（多行粘贴字节完全一样）、鼠标上报（程序要鼠标时滚轮和点击原样到达）。
- 颜色和样式：真彩色、256 色、16 色、粗体、暗淡、斜体、下划线、反显、删除线，xterm 里每个格子的颜色和直接运行完全一样。
- OSC 52（复制）、OSC 8（链接）、`DCS tmux;` 透传（OSC 9 通知）、标题、响铃都到达 xterm。
- copy-mode 回滚：滚轮上进入并滚 3 行、继续滚每格 3 行、滚到底自动退出、点击不退出、拖动选中后通过 OSC 52 复制、按任意键退出。

和直接运行不同、但确认无害的（输出里标 `note`）：

| 现象 | 说明 |
| --- | --- |
| Home / End 变成 `ESC[1~` / `ESC[4~` | tmux 按 tmux-256color 的 terminfo 重新编码。claude、codex 都认（agent 表里 Home、End 两行） |
| 程序申请了 modifyOtherKeys 后，⌃C 变成 `ESC[99;5u`、Option+b 变成 `ESC[98;3u` | 是程序自己要的格式；claude、codex 都申请了，⌃C、Option+Enter 在两者里都正常 |
| 程序没申请扩展按键时，Shift+Enter（`ESC[13;2u`）变成回车 | `extended-keys on` 的设计；和普通终端一样 |
| 外层的 bracketed paste 总是开着 | tmux 用它识别粘贴，转给程序时按程序自己的模式去掉标记，程序收到的和直接运行一样 |
| 回滚时按的那个键被丢掉 | 见问题 9 |

### 真实 claude 和 codex（`agent.mjs`）

direct = node-pty + xterm 直接跑；tmux = 经过 `tmux -L agentdeck`。两者发的字节完全一样。

| 检查 | claude direct | claude tmux | codex direct | codex tmux |
| --- | --- | --- | --- | --- |
| 启动，显示输入框 | ok | ok | ok | ok |
| 打字 | ok | ok | ok | ok |
| Shift+Enter（CSI u）换行 | ok | ok | ok | ok |
| Home / End | ok | ok | ok | ok |
| Option+Enter 换行 | ok | ok | ok | ok |
| 左方向键 | ok | ok | ok | ok |
| ⌃C 清空输入 | ok | ok | ok | ok |
| 多行粘贴留在输入框里、不提交 | ok | ok | ok | ok |
| 下方向键在 / 菜单里移动 | ok | ok | ok | ok |
| Tab 补全命令 | ok | ok | ok | ok |
| Shift+Tab 切换权限模式（claude） | ok | ok | — | — |
| Enter 提交，agent 回答 OK | 跳过¹ | 跳过¹ | ok | ok |
| 上方向键调出上一条提示词 | ok | ok | ok | ok |
| 长输出结束 | ok | ok | ok | ok |
| 滚轮往上翻² | ok | ok | ok | ok |
| 滚轮往下回到底 | ok | ok | ok | ok |
| 开始工作 | ok | ok | ok | ok |
| 工作中 detach，2 秒后再 attach：还在跑，屏幕是最新的 | — | ok | — | ok |
| Esc 打断（re-attach 后第一次按） | ok | ok | ok | ok |
| 首屏颜色集合一致 | 一致 | | 一致 | |

¹ 本机 claude CLI 在干净环境里回 “Please run /login · API Error: 403 Request not allowed”，direct 和 tmux 一样，与 tmux 无关；提交本身（上方向键能调出这条）是正常的。查到的程度：
   - 启动画面显示 “Claude Max”，说明 claude 读到了 `~/.claude` 里的账号信息，但请求被拒。
   - 这次试验是在 Claude 桌面版的一个会话里跑的。那个会话里的 claude 由宿主提供认证（环境里有 `CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH`、`CLAUDE_CODE_MESSAGING_SOCKET` 等），干净环境把这些都去掉了，claude 只能用本机 CLI 自己保存的登录，而那份登录看来已失效或不可用。
   - 没有继续查钥匙串里的凭据，也没有替用户执行 `/login`（登录是用户自己的事）。
   - 下一步：用户在自己的终端里运行 `claude`，需要的话 `/login`，然后 `trial.sh agent claude`。AgentDeck 本身也会遇到同样的情况：agent 用的是用户本机 CLI 的登录。
² claude 在主屏、不要鼠标：经过 tmux 时滚轮进 copy-mode 翻 tmux 历史（`pane_in_mode=1`），直接运行时是 xterm 自己的回滚。codex 在备用屏、要鼠标：滚轮交给 codex 自己翻（`pane_in_mode=0`，屏幕上出现 “↓ Back to bottom”），两种方式一样。

其他观察：

- claude：`#{pane_current_command}` 是 `claude.exe`（有时是 `claude`），`#{pane_key_mode}` = Ext 2，主屏，不要鼠标，标题 “✳ Claude Code”。
- codex：`codex`，Ext 2，备用屏，要鼠标（any），标题是转圈的字符加目录名。tmux 历史一直是 0（codex 自己管回滚）。
- 加了 `CLAUDE_CODE_TMUX_TRUECOLOR=1` 后，claude 首屏的颜色是 `rgb:d77757`、`rgb:8a8a8a` 等，和直接跑完全一样；不加时是 `p:174`、`p:245` 这些调色板近似色。

### tmux-host 后面要用的命令（`commands.mjs`）

全部在这份配置下正常。用法上要注意的：

| 命令 | 结论 |
| --- | --- |
| `capture-pane -p -S -3` | **不是“最后 3 行”**，是“3 行历史 + 整个可见屏幕”（20 行的窗格返回 23 行）。输出少时可见屏幕大多是空行。`lastLines(n)` 应该：`capture-pane -p -J -t =<id>:`，去掉末尾空行，取最后 n 行（实测得到 `["49","50","red tail"]`）。`-e` 保留颜色 |
| `pipe-pane -o -t =<id>: 'cmd'` | 没人 attach 时照样抄送；抄的是程序原始输出（带转义序列），不含 tmux 自己的重绘；attach / detach 不影响；`#{pane_pipe}` 能查；不带命令再执行一次就停。**和 new-session 分开执行会漏掉开头的输出**（实测漏了第一行）；在同一次 tmux 调用里接着写就不漏：`tmux ... new-session -d -s <id> ... -- cmd \; pipe-pane -o -t =<id>: 'cmd'` |
| `display-message -p -t =<id>: '#{pane_current_path} #{pane_current_command}'` | 正常（`/private/tmp sleep`）。macOS 上路径是解析过符号链接的（`/tmp` → `/private/tmp`）。agent 的命令名不稳定（`claude.exe` / `claude`），不要用它判断是哪个 agent |
| `list-sessions -F '#{session_name}\t#{pane_pid}\t#{pane_dead}\t#{pane_dead_status}\t...'` | 正常，pane 类格式取每个会话的当前窗格；`-f '#{pane_dead}'` 能过滤 |
| `new-session -e AGENTDECK_TERM=<id>` | 正常，`show-environment -t =<id> AGENTDECK_TERM` 和进程里都能看到。进程看到 `TERM=tmux-256color COLORTERM=truecolor CLAUDE_CODE_TMUX_TRUECOLOR=1 LANG=en_US.UTF-8` |
| 退出码 | `#{pane_dead} #{pane_dead_status} #{pane_dead_signal}`：`exit 3` → `1 3 `；被 TERM 信号杀掉 → `1  term`（**信号是名字，不是数字**）。屏幕上没有 “Pane is dead”。`respawn-pane -k -t =<id>: cmd` 在原会话里重启（T5 的 Restart） |
| 钩子 | `pane-died`、`alert-bell` 正常，各触发一次。`alert-activity`、`alert-silence` 在本配置下不触发（见问题 6） |
| 大小 | `new-session -x -y` 生效；attach 后窗口跟客户端；两个客户端时跟最近活动的；node-pty resize 会改窗口；一个客户端离开后跟剩下的；没有客户端时保持 |
| 隔离 | 套接字 `/private/tmp/tmux-501/agentdeck`；`#{config_files}` 是这份配置；默认 tmux 服务没有被启动 |

## 发现的问题和绕过办法

1. **attach 后 5 秒内 Esc 慢 500ms**（T2 必须处理）。tmux 每次 attach 都向外层发 XTVERSION（`CSI > q`）和 OSC 10/11（前景、背景色）查询，xterm.js 不回答这两个；tmux 在等回答期间收到单独的 ESC 会扣住 500ms（以为是回答的开头），5 秒后放弃等待才恢复。实测：不回答时 501 ms，回答后 1.4 ms。只回答其中一个不够，两个都要。办法：终端窗口用 xterm.js 的 parser 钩子回答，写法见 `scripts/lib.mjs` 的 `installQueryAnswers`：
   - `registerCsiHandler({ prefix: '>', final: 'q' })` → 回 `ESC P >|xterm.js ESC \`
   - `registerOscHandler(10 / 11)`，参数是 `?` 时 → 回 `ESC ] 10;rgb:rrrr/gggg/bbbb ESC \`（颜色取 design-tokens 里终端的前景、背景）
   - 顺手回答 `CSI ? 996 n`（深浅色主题）→ `CSI ? 997 ; 1|2 n`
2. **attach 还没出首屏就写入的键会和终端回答粘在一起，漏给 agent**（T2）。pty 还没被 tmux 读走时写进去的 Esc，会和 xterm 的 DA 回答拼成 `ESC ESC [ ? 1 ; 2 c` 一起交给 agent（实测 5/5 次）。办法：attach 后先缓存用户输入，收到 pty 的第一段输出后再写。
3. **claude 在 tmux 里主动降到 256 色**。claude 的代码里看到 `$TMUX` 就把颜色级别降到 256，除非有 `CLAUDE_CODE_TMUX_TRUECOLOR`。已在 `tmux.conf` 里 `set-environment -g CLAUDE_CODE_TMUX_TRUECOLOR 1`。以后别的 agent 有类似行为，也在这里加。
4. **attach 必须带 `-u` 和 `-T`**（T2 的 attach 命令；`attachCommand()` 给系统终端用的命令只带 `-u`）。
   - `-u`：从访达启动的 Electron 没有 `LANG`，tmux 客户端就认为终端不支持 UTF-8，中文、▶ ✓ ╭ 全变成 `_`（实测 `"____ _ _ ─│__"`）。
   - `-T RGB,extkeys,hyperlinks,sync,strikethrough,usstyle,overline`：声明 xterm.js 的能力，不加时真彩色被降成 256 色（实测 `ff6400` → 调色板 202）。没写进配置文件，是为了让用户用 Terminal.app attach 时不出错。
   - 完整命令：`tmux -L agentdeck -f <tmux.conf> -u -T RGB,extkeys,hyperlinks,sync,strikethrough,usstyle,overline attach-session -t =<id>`，node-pty 的 `name` 用 `xterm-256color`。
5. **tmux 服务的环境不能用 Electron 的环境**（T1）。服务的全局环境取自第一次启动它的进程，所有会话都会继承：例如在 Claude Code 里启动时 `CLAUDECODE=1` 会进到窗格里，`ELECTRON_RUN_AS_NODE` 之类同理。启动服务（第一次 new-session）时用干净环境：`HOME USER LOGNAME SHELL PATH TMPDIR LANG`，`LANG` 没有就给 `en_US.UTF-8`。另外，从访达启动时 `PATH` 只有系统目录，找不到 `/opt/homebrew/bin/claude`；T1 要从用户的登录 shell 取 `PATH`（例如 `$SHELL -lic 'printf %s "$PATH"'`）再传给 tmux。
6. **活动和静默不能靠 tmux 的钩子**（T1）。实测：
   - `activity-action none`（本配置）时 `alert-activity` / `alert-silence` 一次都不触发；
   - 改成 any 时，没 attach 的会话只触发一次（之后标记一直留着，不再触发），attach 着的会话每段输出都触发，同时每次给客户端发 BEL（14 次响铃）或在屏幕上盖一行消息。
   - 办法：tmux-host 用 pipe-pane 抄送的流自己计时：收到数据就发 `terminal.activity`（自己做节流），3 秒没有数据发 `terminal.silence`。pipe-pane 本来就要给 port-watch 用（T7），没 attach 也能收到，精度到毫秒。退路是轮询 `list-sessions -F '#{session_name} #{window_activity}'`（秒级，实测能分出两段输出）。`#{window_activity_flag}`、`#{window_silence_flag}` 是粘的，只在 attach / 选中时清掉，不适合判断“现在”。
7. **服务在最后一个会话结束时退出，运行时挂的钩子随之丢失**（T1）。`set-hook -g pane-died ...` 这类运行时设置要在每次可能起服务的命令里一起执行（例如和 new-session 写在同一次 tmux 调用里），或者写成固定命令放进配置文件。没有会话时执行 `set-hook`、`show` 会报 “no server running”。
8. **pipe-pane 要和 new-session 在同一次 tmux 调用里**（T1 / T7），否则开头的输出会漏，见上表。
9. **回滚时按的那个键会被丢掉**（T3）。copy-mode 里 `Any` 绑成退出回滚，这个键本身不会交给 agent（普通终端里第一个键会直接输入）。办法：T3 在用户按键时如果这个终端处于回滚（`#{pane_in_mode}`，可以在滚轮之后由界面自己记住），先执行 `send-keys -X -t =<id>: cancel`，再把键写进 pty。不处理也能用，只是第一个键要多按一次。
10. **xterm.js 默认把 Shift+Enter 当回车**（T3）。xterm.js 6.0 不支持 kitty / modifyOtherKeys 键盘协议，Shift+Enter 发 `\r`。T3 用 `attachCustomKeyEventHandler` 把 Shift+Enter 改成发 `ESC [ 13 ; 2 u`，claude、codex 里都是换行；不认的程序 tmux 会按普通回车给它。Option+Enter（`ESC \r`）在两者里也是换行，可以不改。
11. **鼠标选中文字**（T2 / T3）。tmux 开了鼠标，xterm.js 一直处于鼠标上报模式，xterm.js 自带的选中要按住 Option（macOS 上设 `macOptionClickForcesSelection: true`）。平时拖动选中由 tmux copy-mode 完成，复制通过 OSC 52 到达 xterm.js，需要 `@xterm/addon-clipboard` 才能写进系统剪贴板。claude 的 `/copy` 也走 OSC 52。
12. **OSC 9 / 777 通知只在 attach 时能到外层**。`allow-passthrough on` 只对接着的客户端有效，没 attach 的终端收不到。“需要你处理”靠 agent 的钩子（线 4），不靠终端通知。
13. **pane_dead_signal 是名字**（`term`、`kill`……），不是数字，T1 转成 contracts 的退出码时要映射（习惯上 128 + 信号编号）。
14. **node-pty 1.1.0 的预编译 `spawn-helper` 没有执行权限**，npm 装完直接用会报 `posix_spawnp failed`；`trial.sh` 里用 `chmod +x` 绕过。打包 Electron 时（第 3 波）要确认这个文件保留执行权限。
15. **codex 会在它的 `CODEX_HOME` 下留一个常驻守护进程**（`codex app-server --managed-daemon` 和 `daemon pid-update-loop`），TUI 退出后还在，还会自己下载新版本（这次在临时目录里下了 0.164）。`agent.mjs` 结束时按临时目录路径 `pkill -f` 这些进程再删目录。线 4 起 codex 时也要知道：AgentDeck 关掉 codex 终端不等于 codex 的所有进程都结束了。

## 需要人工确认

下面这些脚本测不到，需要有人在真的 AgentDeck 窗口或真的终端里看一下：

- [ ] **需要人工确认**：claude 登录后跑一遍 `trial.sh agent claude`，确认 “Enter 提交，agent 回答 OK” 这一项也通过（这次因为本机 CLI 没登录而跳过）。
- [ ] **需要人工确认**：在真的 xterm.js（WebGL 渲染，T2 做好后）里看 claude、codex 的颜色、粗体、暗淡、框线字符和直接在 iTerm2 / Ghostty 里跑是否一样。脚本只比较了每个格子的颜色值，没有看渲染。
- [ ] **需要人工确认**：真实键盘上 Esc、⌃C、Tab、方向键、Shift+Enter（T3 映射后）、⌘V 多行粘贴的手感，尤其是 Esc 在刚 attach 时（平移白板之后马上按）不卡。
- [ ] **需要人工确认**：触控板滚动：claude 里往上翻、回到底部自动退出回滚；codex 里滚动交给 codex。惯性滚动会一次发很多个滚轮事件，确认速度合适（现在每格 3 行）。
- [ ] **需要人工确认**：在回滚里拖动选中文字，松开后系统剪贴板里有这段文字（需要 T2 装 clipboard 插件）；按住 Option 拖动是 xterm.js 自己的选中。
- [ ] **需要人工确认**：用系统终端 attach（`trial.sh attach <id>` 或 T5 的 Open in system terminal）：iTerm2、Ghostty 颜色正常；Terminal.app 不乱（会降到 256 色）。
- [ ] **需要人工确认**：AgentDeck 和系统终端同时 attach 同一个会话，大小不同时来回切换的效果（窗口大小跟最近有输入的客户端走，另一边会出现空白或被裁掉）。
- [ ] **需要人工确认**：claude 的通知（任务完成时的响铃 / OSC 9）在 attach 时是否到达 xterm 并被界面正确处理。
- [ ] **需要人工确认**：tmux 3.5 上能否正常加载这份配置（只在 3.6a 上测过，3.6 才有的选项已用 `%if` 包起来）。

## 未完成（交给线 1）

F7 到这里收尾，没有继续扩展测试。以下没做，留给线 1（T1 / T2 / T3）或有人工的时候：

- claude 的“提交后得到回答”一项（需要本机 claude CLI 登录，见上面的 ¹）。
- 上面“需要人工确认”清单里的所有项，尤其是真的 xterm.js（WebGL）渲染、触控板滚动、系统剪贴板。
- tmux 3.5 上加载配置；Linux 上一项都没跑过（只测了 macOS 26 + tmux 3.6a）。
- 没有 tmux-256color terminfo 时改用 screen-256color：配置注释里写了由 tmux-host 处理，但没有测（本机有这个 terminfo）。T1 启动时用 `infocmp tmux-256color` 检查。
- 问题 1、2、4 的界面侧做法（回答查询、attach 后缓存输入、`-u -T`）只在 headless xterm 里验证过，T2 做出真窗口后要再测一遍：`timing.mjs`、`keys.mjs` 的 Esc 延迟一项可以直接对着真实现改写。
- 活动 / 静默用 pipe-pane 计时（问题 6）、从登录 shell 取 PATH（问题 5）、钩子随服务重建（问题 7）只是结论，没有实现，是 T1 的工作。
- 同时开 6 个以上 agent 时的内存和 attach 速度没有测（T2 的完成标准是“6 个真实 agent 同时开，打字无可感知延迟”）。

## 最低 tmux 版本

**3.5**，推荐 3.6（实测 3.6a）。

- 3.5：`extended-keys-format`（必须用 csi-u，codex 才认 Shift+Enter），扩展按键重写（mode 2）。
- 3.6：`copy-mode-position-format`、`pane-scrollbars`，在配置里用 `%if "#{>=:#{version},3.6}"` 包住，3.5 上只是回滚时会显示位置提示。
- 3.4 及以前没有 `extended-keys-format`，tmux-host 启动时应检查 `tmux -V`，低于 3.5 就提示用户升级（`trial.sh` 里的 `check_tmux` 是同样的检查）。
- 发行版参考：Homebrew 3.6a；Debian 13 是 3.5a；Ubuntu 24.04 是 3.4，需要用户自己装新版。
