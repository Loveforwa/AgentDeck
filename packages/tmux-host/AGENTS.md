# @agentdeck/tmux-host

AgentDeck 自己的 tmux 实例：`tmux -L agentdeck -f packages/tmux-host/tmux.conf`。所有 agent 进程都跑在里面，界面只为视口里的终端 `tmux attach`，移出视口就 detach。第 1 波 F7 定了配置和做法，第 2 波线 1（T1）在这里实现了 TerminalHost。

## 职责

- `TerminalHost`（contracts 0.1.3 `packages/contracts/src/terminal.ts`）的真实实现：会话的建、结束、列出、接上显示、按键、最后几行、链接（T1）。
- 输出抄送（pipe-pane）→ `terminal.activity` / `terminal.silence`（默认 3 秒）/ `terminal.link`（链接识别由组装注入 port-watch）。
- 进程退出（pane-died 钩子）→ `terminal.exit`；tmux 服务没了 → `terminal.host-lost`；用户输入 → `terminal.input`。
- X6 恢复上次会话要的两样：`list()` 报 shell 正在跑的命令（`foregroundCommand`），`create` 的 `prefill` 把命令填进输入行但不运行。
- 以后跑在 Electron 的 utilityProcess 里。这个包只导出入口，接线留给第 3 波组装（不改 apps/desktop）。

## 文件

| 文件 | 内容 |
| --- | --- |
| `src/host.ts` | `startTmuxHost(options)`：TerminalHost 的实现 |
| `src/activity.ts` | `ActivityTracker`：一个终端的 activity / silence 计时，改大小后的重画不算活动（IS-72） |
| `src/stream.ts` | 收 pipe-pane 输出和 pane-died 钩子的 Unix socket（tmux 那边用 `nc -U` 连上来） |
| `src/tmux.ts` | 调 tmux（固定 `-L -f`）、`tmux -V` 检查、引号和格式转义 |
| `src/env.ts` | 窗格环境（登录 shell 的环境去掉终端身份和宿主注入的变量）、tmux 服务的最小环境、在 PATH 里找命令 |
| `src/input.ts` | 判断 write() 的字节是不是用户输入（xterm 的查询回答、焦点、滚轮不算） |
| `src/signals.ts` | `pane_dead_signal`（名字）→ 退出码 128 + 编号 |
| `src/foreground.ts` | X6：shell 正在跑的命令（`ps` 看前台进程组）、解释器跑的脚本还原成命令名、prefill 去控制字符 |
| `src/pty.ts` | 加载 node-pty，补 spawn-helper 的执行权限 |
| `tmux.conf` | 最终配置（F7），每一项都有注释 |
| `test/host.test.ts` | 真 tmux 的集成测试（`-L agentdeck-test-<pid>`，测完 kill-server） |
| `test/pure.test.ts` | 纯函数 |
| `test/activity.test.ts` | `ActivityTracker`（假计时器） |
| `test/packaging.test.ts` | 打包相关：IS-09（顶层不许有 require 声明）、IS-10（默认 tmux.conf 退到 resources） |
| `dev/bridge.ts` | 本地演示：把真 tmux-host 经 HTTP 交给终端窗口的 dev 页面（`?real=1`） |
| `scripts/approve-keys.ts` | 用真 claude / codex 核对 Approve all 的按键 |
| `scripts/perf.ts` | 6 个终端同时打字的延迟、attach 速度 |
| `scripts/fix-spawn-helper.mjs` | postinstall：给 node-pty 的 spawn-helper 补执行权限 |
| `scripts/trial.sh` 等 | F7 的试验脚本，见下面「F7 的试验结论」 |

## 对外接口

```ts
import { startTmuxHost } from '@agentdeck/tmux-host';
import { createLinkWatcher } from '@agentdeck/port-watch';

const host = await startTmuxHost({
  env: loginShellEnv,                 // 必填。apps/desktop 启动时读的登录 shell 环境（docs/decisions.md），可以传函数
  onEvent: (e) => bus.emit(e),        // TerminalEvent
  onData: (m) => portOf(m.viewId)?.postMessage(m), // TerminalDataMessage，写进对应窗口的 MessagePort
  linkWatcher: () => createLinkWatcher(), // 不给就不发 terminal.link（服务包之间不能直接 import，所以由组装注入）
  // 可选：socketName（默认 'agentdeck'）、configPath（默认本包的 tmux.conf）、tmuxPath、runDir（默认 ~/.agentdeck/run）、
  //       ncPath（默认 /usr/bin/nc）、silenceMs（3000）、resizeQuietMs（1000，见下面 IS-72）、healthIntervalMs（2000）、
  //       prefillQuietMs（400）、prefillMaxMs（5000）、ps（测试替换 ps，X6）
});
// host 实现 TerminalHost，另有：host.tmuxVersion、host.dispose()（不结束会话）、host.killServer()（Stop all and quit）
```

- tmux 不在或低于 3.5：`startTmuxHost` 抛 `AgentDeckError('tmux-unavailable')`，`message` 是一句话（“tmux 3.5 or later is required (found 3.4).”），`detail` 带 `brew install tmux`。界面显示说明页和 Retry，Retry 就是再调一次 `startTmuxHost`。
- `create`：调用方传的 `id` 只能是 `[A-Za-z0-9_-]{1,64}`（tmux 会话名不能有 `:` `.`），已存在抛 `invalid-argument`；目录不存在 `invalid-argument`（“Folder not found: …”）；命令在合并后的 PATH 里找不到抛 `command-not-found`（“Command not found: claude”）。不传 id 时生成 `t-<12 位十六进制>`。
- `kill`：活着的进程发一次 `terminal.exit`（129），已退出的只去掉；不存在抛 `not-found`。
- `attach`：不存在抛 `not-found`。返回后第一段 `onData` 是 tmux 重画的整屏。**收到第一段输出之前写入的输入先排队**（F7 问题 2，界面那边也扣了一道）。
- `write`：用户输入时发 `terminal.input`（同一终端 250ms 内只发一次）；xterm 的查询回答、焦点事件、滚轮和鼠标移动不算。发过鼠标事件之后的第一个按键会先让 tmux 退出回滚再写（F7 问题 9）；PageUp / PageDown 留在回滚里。
- `sendKeys`：先退出回滚再 `send-keys`；发 `terminal.input`。
- `sendText`（contracts 0.1.22）：`send-keys -l` 按原文打字，按键名（Enter、C-c）照字面打出来；结尾的 `;` 前面补一个反斜杠（tmux 会把以 `;` 结尾的参数当命令分隔符，收到后去掉这个反斜杠）。不按回车、不换控制字符；同样先退出回滚、发 `terminal.input`。
- `lastLines(id, n)`：`capture-pane -p -J`，去掉末尾空行后取最后 n 行。
- `list()` 的 `foregroundCommand`（X6）：`list-sessions` 多取一列 `#{pane_pid}`，再用两次 `ps -ww`：先看每个窗格进程的 `tpgid`（终端的前台进程组），不是它自己时 shell 正在跑命令，再取那个进程组组长的 `args`。`node /opt/homebrew/bin/pnpm dev` 这种（shebang 脚本经解释器跑）在 PATH 里找得到同一个文件时还原成 `pnpm dev`。shell 在提示符下、窗格进程本身就是程序（agent、`-c` 跑的命令、`/usr/bin/env` exec 的命令）、进程已退出时为 null。ps 失败当作 null。代价：引号丢了、管道只看第一段、比轮询间隔（终端窗口 3 秒）短的命令记不到。为什么不用别的办法：`pane_current_command` 只有进程名；shell 的历史文件分不清是哪个终端敲的；往用户的 shell 配置里加 preexec 钩子违反“不改用户配置”。
- `create` 的 `prefill`（X6）：先去掉控制字符（换行会直接运行、Tab 会补全），等这个终端的第一段输出之后安静 `prefillQuietMs`（400ms，每段输出重新计时），最多等 `prefillMaxMs`（5 秒），然后 `send-keys -l -- <字>`，不按回车，也不算用户输入（不发 `terminal.input`）。进程先退出、被 kill、服务没了就不填。shell 初始化时清掉了预先输入（少见的 rc 写法）会填不上；p10k instant prompt 实测没问题（本机 zsh）。
- `attachCommand`：`<tmux 绝对路径> -L agentdeck -f <tmux.conf> -u attach-session -t =<id>`（只带 `-u`，见 F7 问题 4）。
- `recentLinks`：新的在前，最多 20 条，同一个链接再出现时挪到最前、不再发事件。重开应用后第一次调用时从 tmux 历史（最后 500 行）里补找一遍。
- `terminal.silence`：最后一次输出**或输入**之后 3 秒发（输入也重新计时：用户按了 Esc 而程序什么都没输出时，状态机的兜底规则也能等到 silence）。一段连续输出只发一次 `terminal.activity`。
- **改大小后的重画不算活动（IS-72）**：`attach` 给的大小和这个终端上次知道的不一样、或 `resize` 改了大小时，tmux 改窗口大小、程序收到 SIGWINCH 重画（shell 重画提示符，TUI 重画整屏）。这之后 `resizeQuietMs`（默认 1000ms）内、终端本来安静（上次 silence 之后还没发过 activity）时来的输出**不发 `terminal.activity`**，也不更新 `lastActivityAt`；静默计时照常，`terminal.silence` 的时机和以前一样。窗口过后还有输出就照常发 activity，所以真在输出的程序最多晚 1 秒被看到；只在窗口里输出一下就停的会被当成重画。
  - 例外：新建的终端第一次 activity 不压（新建时 attach 和程序启动同时发生，状态机要靠它离开 starting）；重开应用接回的会话没有这个例外（状态机按 idle 接上，第一次 attach 的重画也不该变成 Running）。
  - 为什么放在这里、不看 `pane_current_command`：只有 host 知道是不是自己改了大小；`pane_current_command` 对自定义命令永远“不是 shell”，也会让 dev server 一直显示 Running，和状态机现在“有输出才算运行”的规则不一样。状态机（agent-adapters）不用改：有钩子的 agent 只在 starting 时看 activity（第 13 行），这里不压第一次 activity，所以 agent 的状态逻辑不变；Shell、自定义命令（第 17 行）不再因为改大小变成 Running。

### 给组装（第 3 波）

1. **utilityProcess 入口**：在 `apps/desktop/src/utility/` 里换掉 echo-host，`startTmuxHost({ env, onEvent, onData, linkWatcher })`，服务调用（invoke）按方法名转给 host。`onData` 按 viewId 找到发起 attach 的那个窗口的 MessagePort（主进程转 invoke 时把 webContents.id 带过来，attach 返回后记下 viewId → 窗口）。
2. **窗口刷新或关掉**（`window-closed`）：对这个窗口的所有 viewId 调 `detach`，否则 tmux 里会留着 attach 客户端（dev bridge 里实测：刷新三次页面就有三个客户端，窗口大小跟着乱）。
3. **登录 shell 环境**：用干净的环境起登录 shell 读 env（`env -i HOME=… USER=… SHELL=… PATH=/usr/bin:/bin $SHELL -ilc 'env -0'`），不要把 Electron 自己的环境带进去。本机 claude 要靠登录 shell 里的 `http_proxy` 等代理变量才能连上（不带就是 403，F7 当时误以为是没登录，见下面「线 1 的新发现」）。
4. **tmux.conf 路径**：打包后 `import.meta.url` 不再指向本包。`DEFAULT_TMUX_CONF` 先试本包的 `../tmux.conf`，不在就用 `process.resourcesPath/tmux.conf`（IS-10，`resolveDefaultTmuxConf`）；apps/desktop 仍显式传 `configPath`。
   `src/` 里不要在顶层声明叫 `require` 的变量：electron-vite 的 vite:esm-shim 会往产物顶层注入 `const require`，重名就崩（IS-09，`pty.ts` 用 `nodeRequire`，`test/packaging.test.ts` 检查）。
5. **node-pty**：标成 external，放进 `asar.unpacked`；打包后确认 `prebuilds/darwin-*/spawn-helper` 是 0755（预编译包里没有执行权限，开发时由本包的 postinstall 和 `src/pty.ts` 补，签名后的 .app 里改不了，见 F7 问题 14）。node-pty 是 N-API 预编译，Electron 里不用重新编译（`pnpm approve-builds` 提示的 node-pty 安装脚本可以不批准）。
6. **nc**：用 macOS 自带的 `/usr/bin/nc`（要支持 `-U`）。
7. **Stop all and quit**：`host.killServer()`；⌘Q 只 `host.dispose()`，会话留在 tmux 里。
8. **agent-adapters 的 Approve all 按键**：见下面「Approve all 的按键核对」，claude 适配器建议改成 `['1']`。
9. 界面那边的 `TerminalWindowData.cmd/args` 由 `agents.start` 的结果写入；终端窗口的 Restart 也走 `agents.start`（不直接 `terminals.create`），所以 claude 的 `--session-id`、钩子都由适配器重新生成。

## 不许碰

只改 `packages/tmux-host/`、`packages/port-watch/`、`packages/ui/widgets/terminal/`（线 1）。不改 contracts（意见写在 `CONTRACT_NOTES.md`）。测试和脚本只用自己的 `-L` 名字（`agentdeck-test-<pid>`、`agentdeck-dev`、`agentdeck-keys`、`agentdeck-perf`），不碰用户默认的 tmux 服务和正式的 `agentdeck`。

## 怎么跑

```bash
pnpm --filter @agentdeck/tmux-host test          # 集成测试要本机有 tmux ≥ 3.5，没有时整组跳过
pnpm --filter @agentdeck/tmux-host dev:bridge    # 本地演示（另开 pnpm --filter @agentdeck/ui-widget-terminal dev，打开 http://localhost:5340/?real=1）
node packages/tmux-host/scripts/approve-keys.ts claude   # 或 codex；会真的调用模型一两轮
node packages/tmux-host/scripts/perf.ts                  # 6 个 cat；加 agents 参数是 3 个 claude + 3 个 codex
packages/tmux-host/scripts/trial.sh all                  # F7 的试验
```

## 实现要点

- **输出流**：`pipe-pane` 的命令是 `{ echo 'pipe <id>'; exec cat; } | exec /usr/bin/nc -U ~/.agentdeck/run/term-agentdeck.sock`，和 `new-session` 写在同一次 tmux 调用里（F7 问题 8）。选 socket + nc 而不是 FIFO：AgentDeck 退出后 nc 连不上就退出，pipe-pane 随之关掉，tmux 不会一直攒着没人读的输出；重开时 `startTmuxHost` 给每个活着的会话重新接一次 pipe-pane（不带 `-o`，替换旧的）。
- **退出**：`set-hook -g pane-died 'run-shell -b "echo exit #{session_name} #{pane_dead_status} #{pane_dead_signal} | nc -U …"'`，每次 create 和启动时都随命令一起设（服务重启后运行时钩子会丢，F7 问题 7）。另外每 2 秒 `list-sessions` 一次兜底：发现漏掉的退出、被外面结束的会话（按 129 发 exit），以及服务没了（发 `host-lost`）。pipe 连接断开时提前查一次。
- **显示**：`node-pty` 跑 `tmux -L agentdeck -f <conf> -u -T RGB,extkeys,hyperlinks,sync,strikethrough,usstyle,overline attach-session -t =<id>`，`name: 'xterm-256color'`，环境是最小环境 + `TERM`。detach 直接结束 pty（SIGHUP，最快）。
- **窗格环境**：`new-session -e K=V` 逐个给：登录 shell 的环境去掉 `TERM`、`TMUX`、`COLORTERM`、外层终端的标识、`CLAUDECODE`、`CLAUDE_CODE_ENTRYPOINT` 等宿主注入的变量、`ELECTRON_*`、`npm_*`，再合并 `req.env`，最后是 `AGENTDECK_TERM`（不能被覆盖）。没有参数的命令经 `/usr/bin/env <命令>` 直接 exec（只有一个参数时 tmux 会交给 shell）。
- **tmux 服务**的环境只有 `HOME USER LOGNAME SHELL PATH TMPDIR LANG`（F7 问题 5）。

## Approve all 的按键核对（调研记录 F2，`scripts/approve-keys.ts`）

2026-10-23，claude 2.1.291、codex-cli 0.164.0，经 tmux（`sendKeys`）发按键，提示词只让它运行 `node -e "console.log('ok-from-agentdeck')"`（`echo`、`printf` 这类只读命令两个 agent 都直接放行，不会弹提示）。

| agent | 提示长什么样 | 发的键 | 结果 |
| --- | --- | --- | --- |
| claude（`--permission-mode default`） | “Do you want to proceed?” `❯ 1. Yes` / `2. Yes, and don’t ask again for: node *` / `3. Yes, and switch to auto mode` / `4. No` | `Enter` | 选中 1，命令只跑这一次，`.claude/settings.local.json` 没有写规则 ✓ |
| claude | 同上 | `1` | 同样选中 1 ✓ |
| codex（`-a on-request -s read-only`，让模型申请沙箱外运行） | “Would you like to run the following command?” `› 1. Yes, proceed (y)` / `2. Yes, and don't ask again for commands that start with … (p)` / `3. No, and tell Codex what to do differently (esc)` | `y` | 选中 1，命令跑了一次 ✓ |

结论和给 agent-adapters 的建议（适配器不归线 1，组装时改）：

- **claude 适配器的 `approveOnceKeys` 建议从 `['Enter']` 改成 `['1']`**：`Enter` 确认的是当前高亮的那一项，用户如果在提示里按过方向键，Enter 可能变成“don’t ask again”或“switch to auto mode”；`1` 不管高亮在哪都是“Yes”。
- codex 保持 `['y']`。注意 codex 0.164 的“don’t ask again”快捷键已经从 `a` 变成 `p`，永远不要发 `p`。
- 两个 agent 默认设置都可能根本不弹提示：本机 claude 的默认权限模式是 auto（启动画面 “auto mode on”），codex 0.164 的 `--ask-for-approval` 只剩 `on-request` / `never`（`untrusted` 被去掉了，命令在沙箱里能跑就不问）。状态机靠的是 PermissionRequest 钩子，没有钩子就没有“等批准”，Approve all 自然不会出现，不会误发。

## 性能（`scripts/perf.ts`，2026-10-23，MacBook Air（Apple 芯片）、tmux 3.6a、node 25）

量的是 tmux-host 这一层：`write()` 到这个 view 收到下一段输出的时间（cat 的回显、agent 重画输入框），不含 Electron IPC 和 xterm 渲染。6 个终端同时打字（每个约 25 字/秒），另有一个不接显示、每 50ms 刷 200 行的窗格模拟后台输出。单位 ms。

| 场景 | attach 到首屏（中位数 / p90 / 最大） | 按键到输出（中位数 / p90 / p99 / 最大） |
| --- | --- | --- |
| 6 个 `cat` | 6.8 / 9.9 / 14.2 | 0.5 / 0.7 / 1.0 / 1.5 |
| 3 个 claude + 3 个 codex（真 agent，只在输入框里打字） | 7.4 / 10.4 / 15.8 | 9.0 / 25.6 / 29.3 / 31.5 |

- agent 一行的大头是 agent 自己的重画节奏（claude 的 Ink、codex 的帧），tmux-host 本身不到 1ms。都在 50ms 以内，打字没有可感知的延迟。
- tmux 服务 7 MB；host 进程（node，含 node-pty）约 92 MB RSS。
- 真窗口里的数据（WebGL 渲染、IPC）要在组装后用真 Electron 再量，见「需要人工确认」。

## 线 1 的新发现

1. **F7 的 claude 403 不是没登录，是缺代理变量**。干净环境（`env -i`）里 `claude -p` 回 403；用登录 shell 的环境（本机 `.zshrc` 里有 `http_proxy` / `https_proxy` / `all_proxy`）就正常回答。印证了“agent 用登录 shell 的环境”这条决策，也说明登录 shell 的环境必须原样（除了终端身份变量）带进窗格。
2. **pipe-pane 的命令会被 strftime 展开**：`%s` 变成时间戳（实测 `printf '%s\n' a` 收到的是 `1792763452`）。命令里不能有 `%`，路径要把 `%` 写成 `%%`、`#` 写成 `##`（`tmuxFormatEscape`）。
3. **Unix socket 路径最长 103 字节**（macOS），scratch 目录下的长路径 listen 直接 EINVAL。默认放 `~/.agentdeck/run/term-<socket>.sock`。
4. **pane-died 后 pipe 不断**：remain-on-exit 留着窗格时 pipe-pane 的连接也一直在，退出只能靠钩子或轮询。
5. **`kill-session` 不触发 pane-died**，kill() 自己发 129。
6. **codex 0.164 的守护进程不理 SIGTERM**，要 `kill -9`；按路径 pkill 时要用真实路径（`/private/var/...`，不是 `/var/...`）。codex 的信任记录也按真实路径。
7. **web 字体晚于 xterm 加载**会让 xterm 先按兜底字体量出格子（行数偏多），字体加载完重新量后行列数变了；如果这时 attach 还没返回，tmux 会一直按旧行列数画（实测 claude 画面错位）。终端窗口在 attach 返回后补发一次 resize。
8. **FitAddon 把 xterm 父元素的 padding 算进可用宽度**（多出两列，右边被裁）。留白要放在外层。
9. **xterm 的链接要先悬停再单击**（Linkifier 在 mousemove 时才算出当前链接）；自动化测试里直接 click 不会触发。真鼠标没问题。
10. **tmux 3.6a 退出后不删自己的 socket 文件**（`/tmp/tmux-<uid>/<名字>`，kill-server 和最后一个会话结束都一样）。无害；测试和脚本用完的名字顺手删掉。
11. **xterm 默认 16 色在深色底上蓝色很暗**（pnpm dev 打印的地址几乎看不清）。tokens 里还没有终端调色板，见 CONTRACT_NOTES.md。

## F7 的试验结论

下面是 F7（第 1 波）用试验脚本得到的结论，线 1 照做了。文件见上表的 `scripts/trial.sh` 等；`trial.sh` 第一次运行会把 node-pty 1.1.0 和 @xterm/headless 6.0.0 装到 `~/.cache/agentdeck/trial-deps`（可用 `AGENTDECK_TRIAL_DEPS` 改），不进仓库。`agent` 会真的调用模型：只发 “Reply with just the word OK” 和数数这类提示词。

测试环境：macOS 26.4.1（arm64），tmux 3.6a，claude 2.1.291，codex-cli 0.159.2，node 25.9.0。

### 结论

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
   - **线 1 更正**：不是登录失效，是干净环境里没有登录 shell 的代理变量（`http_proxy` 等）。用登录 shell 的环境跑 `claude -p` 正常回答，`scripts/approve-keys.ts` 里 claude 也真的跑完了一轮，见上面「线 1 的新发现」第 1 条。
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

### F7 发现的问题和绕过办法

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

## 需要人工确认（线 1 做完后，按这个顺序试）

脚本和 jsdom 测不到的地方。前 4 步只要本仓库，不用等组装；第 5 步以后要第 3 波组装出真的 Electron 窗口。

准备：本机 `tmux -V` ≥ 3.5（`brew install tmux`）。

1. **dev 页面（假数据）**：`pnpm --filter @agentdeck/ui-widget-terminal dev`，打开 http://localhost:5340 。
   - [ ] 5 个窗口：claude 回放、pnpm dev（地址带下划线）、codex 底部 “Process exited (code 1)” + Restart / Close、“Previous session ended” + Restart ▾、一个 300×150 的摘要卡（最后 3 行）。
   - [ ] 把鼠标移到 pnpm dev 的 `http://localhost:5173/` 上单击：左下 Events 出现 `openWindow browser … reuseKey=http://localhost:5173`。
   - [ ] 窗口标题栏的 S / M / L 改大小、Hide / Show（detach / attach）后内容正常；把 M 改成 S 变摘要卡，再改回 M 画面不乱。
   - [ ] 聚焦 claude 窗口点 “Agent needs approval”：标题栏 “Needs approval · now” 变橙色。
2. **dev 页面（真 tmux）**：另开一个终端 `pnpm --filter @agentdeck/tmux-host dev:bridge`，打开 http://localhost:5340/?real=1 。
   - [ ] 点 shell，打字、跑 `seq 1 300`，滚轮往上翻（进 tmux 回滚），直接打一个字母：回滚退出，字母出现在提示符后面（不用多按一次）。
   - [ ] 在 shell 里 `cd` 到一个已信任的仓库运行 `claude`：中文、框线、颜色正常；Shift+Enter 在输入框里换行；⌃C 清空输入；Esc 打断；`/` 菜单方向键能移动。
   - [ ] 刷新页面（= 重开应用）：窗口按 terminalId 接回，内容还在，tmux 里只有一个客户端（`tmux -L agentdeck-dev list-clients`）。
   - [ ] 在 shell 里 `exit`：底部出现 “Process exited”，标题栏 “Exited”；点 Restart 回到新的 shell。
   - [ ] `tmux -L agentdeck-dev kill-server`：所有窗口显示 “Session ended”。
   - [ ] 用完 `tmux -L agentdeck-dev kill-server`，或带 `AGENTDECK_BRIDGE_KILL=1` 启动 bridge，Ctrl+C 时自动清掉。
3. **按键核对复跑**（会调用模型一两轮）：`node packages/tmux-host/scripts/approve-keys.ts claude`、`… codex`、`… claude 1`，输出里 `afterEnter` / `afterY` 是 “prompt closed”、`persistedRule` 是 “no”。agent 升级后再跑一次。
4. **性能复跑**：`node packages/tmux-host/scripts/perf.ts agents`，按键到输出的 p99 应在 50ms 以内。
5. **组装后，真 Electron 窗口**：
   - [ ] 白板上开 6 个真 agent（3 claude + 3 codex），轮流在每个里打字，感觉不到延迟；平移白板让终端进出视口，回来时画面立刻是最新的。
   - [ ] 刚平移进视口马上按 Esc：claude 立刻响应（XTVERSION / OSC 10/11 的回答生效，F7 问题 1）。
   - [ ] ⌘V 粘贴多行：留在 claude 输入框里，不提交。从访达拖一个文件进终端：输入带引号的路径（需要 preload 提供 `webUtils.getPathForFile`，见 CONTRACT_NOTES.md）。
   - [ ] 在 tmux 回滚里拖选文字，松开后 ⌘V 到别处能粘出来（OSC 52 → clipboard 插件）；按住 Option 拖动是 xterm 自己的选中，⌘C 复制。
   - [ ] 触控板滚动：claude 里往上翻、回到底部自动退出回滚；codex 里滚动交给 codex；惯性滚动速度合适。
   - [ ] ⌘K 清屏（发 C-l）；标题栏右键 Clear / Restart / Open in system terminal；关闭运行中的终端先确认，确认后进程结束。
   - [ ] ⌘Q 再打开：终端接回、历史都在；点过的 localhost 链接仍在网页窗口的起始页（recentLinks）。
   - [ ] 深浅色切换：终端背景、文字、光标跟着变。
   - [ ] 用系统终端 attach（Open in system terminal）：iTerm2、Ghostty 颜色正常；Terminal.app 不乱（降到 256 色）。两边同时接着时大小跟最近有输入的那边。
   - [ ] claude 任务完成的响铃 / OSC 9 通知在 attach 时到达 xterm（界面怎么处理留给组装）。
6. **环境**：
   - [ ] tmux 3.5 上加载 `tmux.conf`、跑一遍 `pnpm --filter @agentdeck/tmux-host test`（只在 3.6a 上测过）。
   - [ ] 没有 `tmux-256color` terminfo 的机器（F7 说要退回 screen-256color，线 1 没做，见「未完成」）。

## 未完成

- 没有 `tmux-256color` terminfo 时退回 `screen-256color`：没做（本机和 macOS 26、主流 Linux 都有）。要做的话在 `startTmuxHost` 里 `infocmp tmux-256color` 失败时，在 new-session 前加 `set -s default-terminal screen-256color`。
- Linux 上一项都没跑过（MVP 只支持 macOS）。Linux 的 nc 要是 OpenBSD 版才有 `-U`。
- 真 Electron 里的 IPC + xterm 渲染延迟没量（要组装后）；上面的性能数据只到 tmux-host 这一层。
- “Open Settings”、拖入文件的路径、⌘K 清 tmux 历史、真正的“运行中才确认关闭”都缺接口，见 CONTRACT_NOTES.md。
- claude 适配器的 `approveOnceKeys` 改成 `['1']` 留给组装（agent-adapters 不归线 1）。

## 最低 tmux 版本

**3.5**，推荐 3.6（实测 3.6a）。

- 3.5：`extended-keys-format`（必须用 csi-u，codex 才认 Shift+Enter），扩展按键重写（mode 2）。
- 3.6：`copy-mode-position-format`、`pane-scrollbars`，在配置里用 `%if "#{>=:#{version},3.6}"` 包住，3.5 上只是回滚时会显示位置提示。
- 3.4 及以前没有 `extended-keys-format`，tmux-host 启动时应检查 `tmux -V`，低于 3.5 就提示用户升级（`trial.sh` 里的 `check_tmux` 是同样的检查）。
- 发行版参考：Homebrew 3.6a；Debian 13 是 3.5a；Ubuntu 24.04 是 3.4，需要用户自己装新版。
