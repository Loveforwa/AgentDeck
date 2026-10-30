# @agentdeck/e2e

端到端验收测试（任务 R2）：Playwright 的 Electron 模式驱动真的 AgentDeck（`apps/desktop`），终端跑在真的 tmux 里，git 是真的临时仓库，agent 是假的。
用例的步骤和预期以 `docs/status/tracking.py` 的 CASES 为准，测试名开头写用例编号。

## 跑法

```bash
pnpm e2e                                   # 根目录：先构建 apps/desktop/out，再跑全部用例（本机约 1 分钟）
pnpm --filter @agentdeck/e2e exec playwright test -g TC-05   # 只跑一条（要先构建过一次：pnpm --filter @agentdeck/e2e build:app）
AGENTDECK_E2E_KEEP=1 pnpm e2e              # 不删沙盒（打印路径和 tmux 名字），排查用；之后自己 tmux -L <名字> kill-server、删目录
AGENTDECK_E2E_PERF=1 pnpm --filter @agentdeck/e2e exec playwright test is26   # IS-26 性能测量（B1 T2 G4，约 4 分钟），默认跳过
```

- 要求：`tmux`、`git`、`node` 在 PATH 里；Electron 二进制下好了（`node apps/desktop/node_modules/electron/install.js`）。Playwright 不用下浏览器。
- **不在 `pnpm check` 里**（慢，要 tmux 和图形环境）。CI 是单独的 `.github/workflows/e2e.yml`，只在 macOS 上跑（Ubuntu 24.04 的 tmux 只有 3.4，不够）。GitHub 的 macOS 机器屏幕只有 1024×768，沙盒设了 `AGENTDECK_WINDOW_SIZE=1440x900` 让窗口和本机一样大；`AGENTDECK_E2E_WINDOW_SIZE=1024x677 pnpm e2e` 能在本机复现 CI 的小窗口。沙盒还设了 `AGENTDECK_BACKGROUND=1`：应用窗口照常显示，但用 showInactive，从不 focus、不跳到最前面，跑 e2e 时可以照常用电脑（需要“应用在前台 / 后台”的用例自己给 getFocusedWindow 打桩，不靠真焦点）。
- 测试跑时会弹出 AgentDeck 窗口（macOS 上会抢一下焦点）。键盘、鼠标事件走 CDP，不需要窗口在前台。
- **性能测量（IS-26，`is26-performance`）默认跳过**：一轮约 5 分钟（G4 要静置 2 分多钟），数字受机器负载影响，设 `AGENTDECK_E2E_PERF=1` 才跑。
  每项打印一行 `[IS-26] {...}`（也附在报告里 `is26-*.json`），旁边带当时的机器负载（整机 CPU 忙的比例、loadavg、同时开着的别的 AgentDeck e2e 实例数）；
  别的 e2e 线同时在跑时数字偏高，没过先看负载、等机器空一点再量。启动时加 `--disable-backgrounding-occluded-windows`，被别的窗口盖住时不停帧。工具在 `support/perf.ts`。
- 每个测试的截图（`01-…png`，最后一张 `final`）、失败时的 trace 和主进程日志在 `e2e/test-results/<测试>/`（git 忽略）。CI 上另有 HTML 报告 `e2e/playwright-report/`。

## 隔离（support/sandbox.ts）

每个测试一个沙盒，结束时 kill tmux 服务、删掉全部临时文件：

| 东西 | 放哪 |
| --- | --- |
| `AGENTDECK_DATA_DIR` | `<tmp>/agentdeck-e2e-XXXX/data`（库、settings.json、worktree 也在这里面的 `home/.agentdeck/worktrees`） |
| `AGENTDECK_TMUX_SOCKET` | `agentdeck-e2e-<测试名>-<pid>-<随机>` |
| `HOME` | `<沙盒>/home`：`.bash_profile` 设 PATH、提示符，`.gitconfig` 设提交人、`init.defaultBranch=main` |
| Electron userData、单实例锁 | `--user-data-dir=<沙盒>/electron`：用户自己开着 AgentDeck 时也能起来 |
| 测试仓库 | `<沙盒>/repos/<名字>`（`support/repo.ts`：main 上两次提交，可选分支和 merge，不进 git 的 `.env`） |

- Electron 只拿到最小的环境（PATH、HOME、SHELL=/bin/bash、AGENTDECK_*、Linux 上的 DISPLAY），不带 ELECTRON_*、CLAUDECODE 之类。
- AgentDeck 启动时用 `$SHELL -ilc` 读登录环境，所以 PATH 由沙盒的 `.bash_profile` 决定：`fakebin`（假 claude）→ `sysbin`（只链接 tmux、git、node）→ `/usr/bin:/bin:/usr/sbin:/sbin`。
  真装着的 claude、codex、pi、omp、kimi 都看不到，`~/.claude*`、`~/.codex`、`~/.pi`、`~/.omp`、`~/.kimi-code`、`~/.agentdeck` 都不会被读写。
- settings.json 预先写好：不发系统通知、编辑器命令是 `true`。
- 主进程里换掉碰沙盒外面的东西（`Deck.guardMainProcess`）：系统选文件夹窗口（`deck.pickFolder(路径)` 预先给答案）、`shell.trashItem`（只删沙盒里的路径）、打开系统浏览器 / 文件。

## 假 agent（fake-agent/fake-claude.mjs）

以 `claude` 的名字放在沙盒 PATH 最前面，AgentDeck 的 claude 适配器把它当真的：`claude --version` 报 `2.1.291 (Claude Code)`（够新，带钩子）；
启动参数照真 claude（`--session-id` / `--resume`、`--settings <json>`）。它从 `--settings` 里取出 AgentDeck 注入的钩子命令（`agentdeck-notify claude <事件>`），
在对应时机用 `/bin/sh -c` 运行、负载走 stdin，字段和真 claude 一样（`session_id`、`tool_name`、`tool_input.command`……），所以状态机、钩子 socket、agentdeck-notify 全是真的在跑。

在终端里打字控制它（测试用真键盘：单击窗口聚焦，再 `page.keyboard`，经 xterm → tmux 送进去）：

| 输入 | 钩子 | 状态 |
| --- | --- | --- |
| 启动 | SessionStart | idle |
| `work` | UserPromptSubmit | running（一直干活） |
| `ask [命令]` | UserPromptSubmit、PermissionRequest（Bash，默认 `ls -la`），画确认框 | needs-approval |
| 等批准时按 `1` / 回车 / `y` | PostToolUse | running |
| 等批准时按 `2` / Esc / `n` | 无（真 claude 拒绝后也没有钩子） | 3 秒后兜底回 idle |
| `done [回复]` | Stop（带回复时画一行 “● 回复”，像真 claude 的最后一条回复） | idle |
| `limit <秒> [noauto]` | 会话记录（`$HOME/.claude/projects/<cwd>/<会话 id>.jsonl`）写一行 error `rate_limit`（resetsAt = 现在 + 秒），StopFailure（`error: rate_limit`、带 transcript_path）；默认像 claude 2.1.234 起自己续：到点 Notification `quota_auto_resume_fired` + UserPromptSubmit，等的时候收到的一行到点改发它（日志 `queued-while-limited`、`self-resume`）；`noauto` 马上发 `quota_auto_resume_disabled`，之后收到的一行当提示词（日志 `prompt`） | idle，到点 running |
| `edit <文件> [内容]` | UserPromptSubmit、PostToolUse（Write，`tool_input.file_path`）、Stop：在 cwd 下写这个文件（像 agent 改代码，TC-03），日志 kind `edit` 带绝对路径 | running → idle |
| `clear` | SessionStart（`source: clear`，新的会话 id，像真 claude 的 /clear） | 不变（Session 多一段，SE2） |
| `compact` | SessionStart（`source: compact`，会话 id 不变） | 不变 |
| `quit` / `exit` | SessionEnd，退出码 0 | exited |
| `crash` | 无，退出码 3 | error |

bracketed paste（`ESC[200~ … ESC[201~`，LimitService 续跑时这样送）里的换行当空格，不提交。每个钩子、每次批准都写进 `$AGENTDECK_E2E_LOG_DIR/<启动时的会话 id>.jsonl`（clear 以后也写同一个文件）（`deck.agentLog(terminalId)` 读），测试用它核对后台真的发生了什么。
假 claude 另有两条（g3 加的）：`ask-stuck [命令]` 同 ask 但确认框不认按键（日志 key-ignored，Approve all 的 Couldn’t approve）；
`usage <输入> <输出> [缓存读] [模型]` 往会话记录写一行带 message.usage 的回答（Usage 插件读它）。

别的假程序（g3，共用 `fake-agent/fake-common.mjs`：日志、跑钩子、按行读键盘），用 `support/g3.ts` 的 `installCodex / installPi / installOmp / installKimi / installTui`
在 `deck.launch()` 之前装进沙盒的 fakebin（重写同一个名字 = 升级），日志同样按终端 id 用 `deck.agentLog` 读：

| 程序 | 做什么 |
| --- | --- |
| `fake-codex.mjs`（codex 0.165.0） | `app-server` 报钩子的 key 和哈希，只跑 `-c hooks.state` 里信任了的钩子；`ask` / `y` / Esc、`done`、`limit <秒\|@epoch>`（rate_limits 100% + task_complete usage_limit_exceeded）、`sql`；会话记录写在 `$CODEX_HOME/sessions/…/rollout-…-<id>.jsonl`（token_count 带 5 小时、每周额度）；第一次输入才发 SessionStart |
| `fake-pi.mjs --fake-as pi\|omp --fake-version x.y.z` | 照真 pi / omp 解析参数，记下第一条消息；真的 import `-e` 给的 agentdeck-pi-extension.mjs 并按扩展接口发事件；omp 的 `ask` 画 `Allow tool: bash` 确认框（↑ ↓ 回车） |
| `fake-kimi.mjs`（kimi 2.3.3） | 没有钩子；输入框一个字一个字收，记下每一行（第一条消息是 AgentDeck 等终端安静后打进来的） |
| `fake-tui.mjs <名字>` | 假的数据库 TUI（harlequin、lazysql、pgcli）：开着 bracketed paste，粘贴放进“查询编辑器”，记 paste / key / line |

`support/g3.ts` 的 `mcpCall(sb, 终端 id, 工具, 参数)` 以那个终端的身份调 AgentDeck 的 MCP（Bearer 终端钥匙 + `x-agentdeck-terminal`，地址读 `<数据目录>/run/api.json`），
和 agent 自己调工具发的请求一样。

`fake-agent/dev-server.mjs` 是 TC-06 用的“dev server”：打印 `Local: http://localhost:<端口>/`，每个请求记一行，故意带 `X-Frame-Options: DENY`。
`fake-agent/web-server.mjs` 是 TC-27 / TC-28 用的“外部网站”：一个端口按 Host 分站（example.test 301 到 www、localhost 302 到 /login、
app.test 像 github 带登录和第三方登录弹窗、auth.test 是授权页），每个请求记一行（host、path、UA）。测试启动应用时带
`--host-resolver-rules`（*.test → 127.0.0.1，其余解析失败）和 `--no-proxy-server`（不走系统代理），碰不到真网站。

`deck.launch({ args, waitForBoard })`：额外的 Chromium 参数；`waitForBoard: false` 不等白板（TC-19 的 tmux 说明页）。
`support/g4-env.ts`：`shieldRealAgents`（见下面「已知问题」）、zsh 的登录配置、读进程环境（TC-20）。
`fake-agent/fake-codex-mini.mjs`（TC-17）：`--version` 报 `codex-cli 0.1.0`（老版本，不起 app-server），运行时只画 “Fake Codex”、回显输入；测试用 `support/g1.ts` 的 `installFake(sb, 'codex', …)` 在启动前放进沙盒的 fakebin。
`fake-agent/key-probe.mjs`（IS-05）记下程序真正收到的每一段字节（kind bytes，hex）和 bracketed paste 的整段（kind paste），`colors` 画颜色和框线、`bell` 发响铃和 OSC 9；`--ext` 申请扩展按键、`--mouse` 要鼠标。工具在 `support/h2.ts`（日志、读 xterm 每格的样式、截图取色、系统剪贴板存取、`focusTerminal` 等 xterm 输入框真拿到焦点）。
`fake-agent/emoji-stream.mjs`（TC-25）一行行打带 ✅ ❌ 🚀 🧪 的列表，最后 `END`；`fake-agent/theme-probe.mjs`（TC-26）像 claude 的 auto 主题：打开 ?2031，收到 `CSI ? 997 ; 1|2 n` 就记下并重新问 OSC 11 背景色。
`support/g1.ts` 是 g1 这几条（白板、窗口、面板）用的小工具：从 React fiber 读 xterm 的选项和屏幕（`xtermOf`）、数主进程 IPC 调用、触发应用菜单的 accelerator、记 `status.changed`。

注意：AgentDeck 读登录环境后会在 PATH 末尾补 `/opt/homebrew/bin` 等常见目录（`login-env.ts` 的 `withCommonPaths`），所以本机真装的 codex、pi、omp 也会被检测到、出现在 New terminal ▸ 里。测试里不要点它们；要 codex 就像 TC-17 那样放一个假的进 fakebin（排在前面）。

## 写测试

- 夹具（`support/fixtures.ts`）：`sb`（沙盒）、`deck`（还没启动，`await deck.launch()`）。`deck.quit()` 和 ⌘Q 一样（点应用菜单的 Quit），之后可以再 `launch()`（TC-10）。
- 用户动作走真的输入：右键菜单（`deck.pickMenu([...])`）、对话框按钮、键盘（`Meta+J`、`Meta+1`，Linux 上也是 Meta：白板只认 ⌘）、拖改大小的角、单击终端里的链接（`deck.clickTerminalText`）。
  不是被测步骤的准备工作可以走捷径：`setupWorktree`（API 加项目 + 白板控制器建 worktree）、`openTerminal` / `openFakeClaude`（`__board.newTerminal`）。
- 断言 UI（DOM、截图）也断言后台：git（`git(sb, 目录, 参数)`）、tmux（`sb.tmux([...])`、`deck.pane(id)` = capture-pane）、状态机（`window.agentdeck.status.snapshot()`）、假 agent 日志。
- 等条件，不要 sleep：`expect.poll`、`deck.waitForPane`、`deck.waitForStatus`、`deck.waitForWindow`。超时给得宽（tmux、xterm 起来要时间）。
- xterm 用 WebGL 画，DOM 里没有终端文字：看终端内容用 `deck.pane()`（tmux），要点终端里的字用 `deck.clickTerminalText`（按 tmux 画面和格子大小算坐标）。
- 构建：`scripts/build-app.mjs` 用 electron-vite 的 API 构建，`import.meta.env.DEV` 定义成 true，界面才挂出 `window.__board`（electron-vite build 会把 NODE_ENV 强制成 production）。产物和普通 build 一样在 `apps/desktop/out/`。
- 文件名用 `*.e2e.ts`：根目录的 vitest 只收 `*.test.*` / `*.spec.*`，不会把它们当单元测试；本包没有 vitest 测试。`e2e/` 下的文件在模块边界规则里都算测试文件。

## 覆盖

| 用例 | 文件 | 说明 |
| --- | --- | --- |
| TC-01 | tc01-tc02-project-workspace | 右键 Add project…（选子文件夹）→ 直接进 New workspace；库里路径是仓库根、基础分支 main；重复添加不重复 |
| TC-02 | 同上 | 右键 New workspace… → feat/oauth from main → 框在右键处、Shell `setup` 跑初始化命令、面板显示分支；worktree、分支、.env 复制 |
| TC-05 | tc05-tc30-agent-status | 假 claude 等批准、白板拖开 → ⌘J 平移聚焦、闪一下、“1/1 waiting” → 按 1 → Running；按键真的进了 claude、PostToolUse 到了 |
| TC-30 | 同上 | 绿 Running、黄 Waiting（悬停 Needs approval、黄边框）、空心灰 Idle、红 Error；顶栏和框标题的灯；颜色就是 `--status-*` token |
| TC-06 | tc06-tc09-tc10-terminals | Shell 跑 dev server → terminal.link 事件 → 单击地址开网页窗口（同框、在右边、页面显示）→ 再单击聚焦同一个 |
| TC-09 | 同上 | 拖角拉小两个终端 → 摘要卡（最后几行、等你的黄色），tmux 里没有客户端 → 单击恢复原大小、聚焦、重新 attach |
| TC-10 | 同上 | ⌘Q 后 tmux 会话还在 → 再打开：框和窗口位置不变、终端接回、历史在、输入照常 |
| TC-07 | tc07-tc12-git | 聚焦终端 → 面板树形列出改动 → 悬停 + 暂存两个 → ⌘↩ 提交；提交在测试分支上、只带暂存的文件 |
| TC-147 | tc147-send-selection | 散放的 bash 打印多行 SQL（带 -- 注释）→ 100% 缩放下真的拖选（tmux 松手复制，IS-82 在别的缩放下会选偏）→ 右键 Copy · Paste · Send selection to ▸ › zsh（自定义命令）→ 焦点跳过去，SQL 原样在 zsh 输入行里、没执行。没有 /bin/zsh 时跳过 |
| TC-61（CR15） | cr15-agentdeck-command | 散放的 Shell：窗格环境有自己的钥匙、PATH 最前面是 `<数据目录>/bin` → `agentdeck help`（真键盘）出 JSON → `agentdeck notify "…"`（tmux send-keys，像 agent 跑命令）白板弹提示 → `crew plan` 退出码 1（CR2 之前是 “crew is not available yet”）→ 改 AGENTDECK_TERM 冒充别的终端 “Unauthorized” → 同样 HOME、PATH 的系统登录 shell 里 `command -v agentdeck` 找不到。沙盒的 .bash_profile 在这个测试里改成往前加 PATH（见 tools/agentdeck-cli「已知限制」） |
| TC-78（PL6） | tc78-auto-resume | 假 claude `limit 45 noauto`（像 codex，AgentDeck 来续）→ 右键标题栏开 Auto-resume → 书签 Paused · resumes … → 卡片里改话、⌘↩ → 到点打进终端的就是改过的那一句（只这一句），Resuming，做完书签收起。用 `AGENTDECK_LIMIT_GRACE_MS=0`、`AGENTDECK_RESUME_STAGGER_MS=0` |
| TC-82（PL6，claude 部分） | 同上 | `limit 45`（claude 自己续）：灰书签 claude resumes …，卡片没有 Don’t resume → Give to claude 马上送进去（不算你接手），到点 claude 发改过的那一句、AgentDeck 不另发；claude resuming，做完收起。真 claude 是否这样待核对（DR-84） |
| TC-03 | tc03-tc08-two-worktrees | 已有 feat/oauth → 右键 New workspace… 建 fix/rate-limit → 两个框右键 New terminal › Claude Code 紧接着连开（不等，IS-07 没出现）→ 各自 `edit` 改一个文件 → 面板随聚焦只显示各自的改动；面板里暂存只进自己的暂存区；HEAD、git status、tmux pane_current_path、钩子 cwd 各是各的 |
| TC-08 | 同上 | 聚焦 feat/oauth 的终端 → 分支按钮 → fix/rate-limit 灰显、写 “in fix/rate-limit” → 单击：选中那个框、视口平移到它、面板换过去；`git.branches` 的 checkedOutAt 来自 worktree list；refs、reflog、两个 HEAD 都没变 |
| TC-11 | tc11-system-terminal | 标题栏右键 › Open in system terminal：主进程里截下交给 osascript 的 AppleScript（`support/system-terminal.ts`，不真开 Terminal.app），取出 `tmux -L <沙盒 socket> … attach-session -t =<id>`，在 node-pty 伪终端里跑它 → 同一会话两个客户端，两边打字互相看得到，关掉只断一个客户端。Terminal.app 真弹出来要人工看 |
| TC-15 | tc15-project-settings | 顶栏 Projects ▾ › shop › Project settings…（选中的是 shop 不是第一个项目）→ 看到并改名称、基础分支、worktree 位置、复制的文件、初始化命令 → Save 写进 store、重开还在 → New workspace 默认从新基础分支分出、在新位置、复制了文件、setup Shell 跑了命令 |
| TC-23 | tc23-tc24-panel-stage-switch | 新文件和改过的已跟踪文件：悬停 + 移到 Staged Changes（git status `A ` / `M `），− 移回（`??` / ` M`） |
| TC-24 | 同上 | 主目录工作区开着空闲的 bash 和 claude → 分支按钮 → 另一个分支 → 确认框写 “bash and claude are open in this folder…”，确认前 HEAD 不变、Cancel 不变 → Switch 后框标题、面板、workspaces.list、workspace.changed 都是新分支；claude Running 时切回也先确认 |
| TC-36 | tc36-commit-graph | 测试仓库（不用 agenduck）：All branches 里泳道不止一条、有弧线、合并是双圈、HEAD → main、feat/login 带 ◧（单击跳框）、feat/search；feat/cart、feat/old 收成 “2 merged branches not on the board”，Show 展开；行数 = rev-list --all；点 Merge feat/cart 展开 cart.txt；This workspace 只剩 main 的提交 |
| TC-38 | tc38-outside-workspace | Shell 里 `cd /tmp` → 标题栏状态后面 “outside workspace”（--muted 色），title 写 Now in … / Workspace: … → `cd -` 消失；tmux pane_current_path 对得上 |
| TC-39 | tc39-skills-mcp | 沙盒 HOME：折起再展开 SKILLS · MCP → agentdeck（built in）、agentdeck MCP（Connected）、repo-notes（repo，灰着勾上）、accept-hello（library，没勾）→ 勾上出 Changes apply after restart → Restart and resume：假 claude `--resume <原会话>`、`--plugin-dir` 那套目录多了 accept-hello，提示消失；~/.claude 和仓库都没变。真 claude 里 /skills 要人工看 |
| TC-12 | tc07-tc12-git | 右键框 Delete workspace… → 连目录删 → 有未提交改动要勾选再确认 → 框消失、目录没了、分支还在、终端结束 |
| TC-14 | tc14-restore-after-reboot | ⌘Q + kill tmux 服务模拟重启 → “Restore your last session?”（2 terminals in 1 workspace）→ Restore all：窗口原位，假 claude 用 `--resume <原会话 id>` 接回（SessionStart source resume），Shell 在 worktree 里、`sleep 600` 填在输入行没运行。真重启、codex resume 要人工 |
| TC-19 | tc19-tmux-missing | 假 tmux 报 3.4 → 说明页（3.5 or later、brew install tmux、Retry），只跑了 `tmux -V`；换回真 tmux 点 Retry → 白板、能开终端。坏掉的 tmux 同样是说明页。“完全没装”做不到：findTmux 固定看 /opt/homebrew/bin |
| TC-20 | tc20-dock-launch-env | 用 launchd 那样的最小环境（有 / 没有 SHELL）启动 → 假 claude 照样找到、能回答；agent 进程的 PATH 是登录配置里的、带代理变量。真从程序坞打开打包的应用要人工 |
| TC-27 | tc27-tc28-web | example.test 301 → www：webview 跟过去、没有 “isn’t responding”；localhost 302 → /login：iframe 跟过去；ping 只问了原地址 |
| TC-28 | 同上 | app.test（带 X-Frame-Options: DENY）用 webview、persist:agentdeck-web 分区、UA 不带 Electron；登录后重开应用还登录着；第三方登录弹窗同一分区；⌘[ ⌘] ⌘R（按键见下）；缩到 50% 网页跟着缩。真 google / github 登录要人工 |
| TC-52（SE2 后台） | tc52-tc55-sessions | 假 claude 聊两轮 → `clear` → 同一条 Session 两段（start、clear）、只有一条 Session；关窗口后 stopped、两段都在。界面等 SE4、SE5 |
| TC-55（SE1 后台） | 同上 | 新库降成 schema 1（迁移 1 的 SQL 从 migrations.ts 原文读）+ 白板加 open_terminals 的 group → 重开：每个终端窗口一条 Session、data.session 写回、子终端 parentId 是 Lead、origin spawn · open_terminals、label；tmux 里没有的旧终端记录清掉；关 Lead 后子终端 group 去掉、父子关系还在。界面等 SE4、SE5 |
| TC-77（SK5） | tc77-skill-sets-cleanup | skill-sets/ 里 8 天前没人用的删掉；在用的、1 天前的、名字不是 AgentDeck 起的不动；终端退出后下次清理删掉它那个；沙盒 HOME 的 skill 目录和配置一个字节没变。其余等 SK2 |
| TC-16 | tc16-tc33-manager | 重开应用、没聚焦：右侧写 “Focus a terminal to see its changes.”（不是 “isn’t in a workspace”），左边管理面板列着项目 → 工作路径 → 两个终端 → 单击框里的终端：Source Control 显示分支、管理面板还在；git.status 只调一次，同框换终端不再调 |
| TC-33 | 同上 | 两个项目三个工作区、终端 + 网页、一个在等批准，缩到 40%：打开左边管理面板（MP2）→ 项目 → 分支 → 每个窗口一行（灯、agent 小方块、Shell 的标题是 OSC 2 设的主题、网页是窗口图标）；等批准的在 NEEDS YOU · 1（浅黄底、“Waiting · …”、写 “api · feat/pool”），下面不再出现 → 单击它：平移放大、闪一下、聚焦，右侧换成 feat/pool 的源代码管理 |
| TC-17 | tc17-tc21-tc22-new-terminal | 假 codex：New terminal ▸ 按名字列出 `agents.list()` 装了的 + Shell，没装的不出现 → 选 Codex 开在右键处 |
| TC-21 | 同上 | 右键 › New terminal › Shell：开在右键处、散放、cwd 是 ~、窗格有 AGENTDECK_TERM → 打 `git status`：tmux 和 xterm 里都有输出，状态 running → idle |
| TC-22 | 同上 | `sleep 300` → 标题栏 × → 窗口里的 “Stop bash?” → Stop and close → 窗口没了、tmux 会话没了 |
| TC-18 | tc18-shortcuts-in-browser | 焦点在网页（跨源 iframe）里：连到这个 frame 的 CDP 按 ⌘B，白板页面收不到 keydown → 触发菜单 accelerator：⌘B ⌘0 ⌘1 ⌘J ⌘W 都生效、主进程发了 shortcut；⌘R 只刷新网页（dev server 多一个请求、应用没重载）。真键盘到菜单这一段要人试 |
| TC-25 | tc25-resize-emoji | emoji-stream 出字时拖角改大小（拖动中 tmux 行列数不变、松手后变）、双击标题栏放大还原 → xterm 屏幕和 tmux 一行对一行相同、emoji 宽 2、回滚 1000、Unicode 11、没有 loadCell / isWrapped 报错 |
| TC-26 | tc26-dark-theme | 去掉 Playwright 的配色模拟，nativeTheme 切深浅色：假 claude 启动参数有 `"theme":"auto"`；theme-probe 收到 997;2 / 997;1、重新问到的背景色跟着变；`--ground` 和 xterm 主题跟着变。真 claude 的字色要人看 |
| TC-29 | tc29-topbar | 顶栏 34px 一行、按钮都在里面；macOS 上 `getWindowButtonPosition()` = (14, 9)、左边留 76px；项目菜单（各项目 › New workspace… / Project settings…、Add project…）、“feat/cart · 2 windows”、灯、齿轮 → Settings 停在当前项目；圆角 12 / 10 / 8 / 8 / 8 来自 tokens |
| TC-31 | tc31-snap-avoid | 真鼠标拖标题栏：顶边差 4 吸住、画 `--guide` 线、拖动中不推别人 → 拖到别的终端上松手滑开、不重叠、不弹换框 → 拖框到别的框上停在相隔 20 → 拖角改宽吸到同宽、标出尺寸 |
| TC-32 | tc32-panel-collapse | ⇥ 收起成 28px 竖条（Expand panel、分支图标、`--status-waiting` 改动点）、白板露出来的更宽、BoardState.panel 存 open:false → ⇤ 展开 → ⌘B 切换 → 收起后 ⌘Q 再开仍收起 |
| TC-37 | tc37-gestures | 没聚焦的终端上滚轮：tmux 进回滚、视口不动；网页上滚轮视口不动；空白处滚轮平移；ctrl+滚轮缩放（指针处不动）；按住空格从标题栏拖：平移、窗口不动；终端里 Shift+空格打出空格。触控板手感要人试 |
| TC-04、TC-13 | tc04-tc13-notify | 假 claude 等批准 → 2 秒内黄边框、Waiting · Needs approval、框和顶栏 1 waiting；后台时系统通知 “claude · <工作区> needs approval”、角标 1（Notification.show 换成记录，TC-04 固定 getFocusedWindow）；关窗口（BrowserWindow.close）后 claude 照跑、钩子照到、通知、单击通知窗口回来并聚焦那个终端 |
| TC-34、TC-35 | tc34-tc35-subagent-group | 重启后 lead claude 调 open_terminals（3 个、带 labels、prompts）→ “3 subagents” 侧边栏、组随白板保存；open_browser localhost:3000 同框；关 lead（确认 Stop claude…）→ 变普通窗口。侧边栏状态灯、等你的行浅黄底、单击行、Show all、Collapse group、⌘J 调出收起的 |
| TC-40 | tc40-auto-approve | 右键标题栏开 Auto-approve（第一次问一句）→ 红书签；PermissionRequest 钩子回 allow、闪一下、ApprovalRecord；rm -rf → Needs you（悬停写原因）；右键框开 → 框标签、codex 也挂书签并照样自动批准，shell 不挂 |
| TC-41 | tc41-usage | claude、codex 的 Usage 条：数对上会话文件，每轮更新，拖到下边并保存，卡片（模型、窗口、请求数，codex 的 5h / Weekly limit），上下文 ≥ 85% 变黄 |
| TC-42 | tc42-approve-all | 三个在等（claude、codex 的 rm -rf、不认按键的 claude）→ Approve all… 列表、rm -rf 不勾、Approve 2 → claude 继续、那一条 Couldn’t approve 留下、提示 “Approved 1 request · 2 still need you” |
| TC-46 | tc46-first-message | open_terminals 开 pi、omp、kimi 带第一条消息，都原样收到（pi、omp 在参数里，kimi 安静后打进去）；@ 开头的照原文；shell 带 prompt 报错不开终端 |
| TC-48 | tc48-untested-version | omp 18.0.4 开着 Auto-approve → 换成 18.12.6 重启：report 的 approve-keys Off · Untested on 18.12.6（verifiedUpTo 18.0.4），不发键、omp 停在确认框等你。第二条不刷新页面：重启后菜单直接灰掉（IS-153）、开关还在、书签变 Needs you · Not supported、不发键（IS-154） |
| TC-68 | tc68-send-to-waiting | A 用 send_to_terminal 往等批准的 B 打 1 → “This terminal is waiting for the user. Use the inbox.”、B 没收到键；Approve all… 批准 B（ApprovalRecord）后再发一句正常送到 |
| TC-80、TC-81 | tc80-tc81-codex-limits | 三个 codex 同一个 CODEX_HOME：一组（2 个 interrupted、1 个 idle）、书签、卡片 Don’t resume → Skipped、恢复 + 5 秒宽限后只续 T5、空闲的不发；再撞两个都续、间隔 ≥ 2 秒按先后；limits.cancel 后都不发。撞完自己打字 → took-over、到点不发。书签写 “Not resumed · you took over” 停几秒（3 秒以上）再收起（IS-155） |
| TC-109 | tc109-send-sql | codex 里拖选多行 SQL → 右键标题栏 Send selection to ▸（按框分组）› harlequin · shop dev → 原样贴进编辑器、没按回车、焦点过去；没选中时灰掉 |
| IS-02（TC-02 回滚） | is02-worktree-rollback | 真右键 Add project… / New workspace… → .env 读不了（chmod 000），worktree add 之后复制失败 → 框上 EACCES + Retry、没有工作区框；worktree list、分支、refs、worktree 目录、.git/worktrees 都回到原样 → 改好后 Retry 建好、.env 复制了 |
| IS-23（TC-09 补充） | is23-summary-restore | Shell（80 行输出）和假 claude 都拉成摘要卡（Shell 卡上正好最后 3 行，tmux 没有客户端）→ 卡片期间 claude 出字 → 两个都单击恢复：原大小、聚焦、各一个客户端，xterm 行列数和拉小前一样、tmux 窗格同大小、屏幕和 capture-pane 一行对一行；之后输入照常 |
| IS-27（TC-10 的强杀版） | is27-sigkill-restore | 真鼠标拖开 Shell、等自动保存进库 → kill -9 主进程 → 渲染 / GPU / utilityProcess 都退出（ps 里没有沙盒 user-data-dir 的进程）、tmux 会话在、客户端断开，应用不在时 claude 的 Stop 钩子照跑不卡 → 再打开：没有 Restore 提示、框和窗口位置不变、每个会话一个客户端、历史在、钩子（等批准 → 1 → Running → done）和 Shell 输入照常 → 再 ⌘Q 重开布局还在 |
| TC-110 | tc110-hide-from-agents | 窗口数据 hideFromAgents（LA1 的勾还没做）→ list_terminals / list_windows 不列，read / send 报 “The user hid this terminal from agents”，一个键都没进；lazysql 照常；返回里没有密码 |
| IS-05 | is05-terminal-feel | 终端手感里机器能核对的：key-probe 画 16 / 256 / 真彩色、粗体下划线斜体、中文和框线 → xterm 缓冲区每格的字、宽度、颜色，tmux 里还是真彩色，截图取色；Esc、Shift+Enter（申请扩展按键的收到 CSI 13;2u，没申请的收到回车）、Option+字母、方向键、⌃C、⌘V 多行 bracketed paste 不提交；刚接回显示按 Esc 的延迟；聚焦终端里滚轮进 tmux 回滚、打字退出、滚回底部退出；申请了鼠标的程序（像 codex）自己收到 SGR 滚轮；拖选松手进系统剪贴板（OSC 52）、⌘V 到别的终端，Option 拖 + ⌘C；测试自己经沙盒 socket attach 第二个客户端，两边互相看得到、大小跟最近输入的；响铃和透传的 OSC 9 到 xterm、假 claude 做完 Idle · now。触控板手感、真 claude 的配色和 / 菜单、iTerm2 / Terminal.app 里的颜色、从访达拖文件要人看 |
| IS-16（TC-18 的键盘部分） | is16-keyboard-in-browser | 焦点在网页（跨源 iframe）里用 page.keyboard 按 ⌘J ⌘B ⌘W ⌘0 ⌘1：都进了网页、白板页面收不到、没被网页和小桥 preventDefault（对照 ⌘[ 被拦）；⌘R 只刷新网页（dev server 多一个请求、应用没重载）。键盘到应用菜单这一段 CDP 按不出来（合成的按键没有系统事件），要人用真键盘试 |
| IS-157 | is157-zoom-idle-shell | 空闲的 shell 捏合缩到 50% 以下再放大、⌘- ⌘= ⌘0 ⌘1、zoomTo：标题栏一直 Idle、状态机没变、tmux 大小没变（没复现）；刚开的 shell 打出提示符后 Running 约 3 秒才 Idle（只记录） |
| TC-148（MP3） | tc148-needs-you | 6 个散放的假 claude（crash 退出码 3、等批准、两个在跑、刚做完一轮、一直空闲）+ 2 个 shell：左边管理面板 NEEDS YOU · 2 = 出错的、等批准的（等得最久的在前），其余在 “Not in a workspace” 按位置、每个终端一行；灯和右边的字（exit 3 · …、Waiting · …、Running · …、Idle · …）颜色对 token；悬停刚做完的出提示（Last reply、回复、Click to jump），悬停 NEEDS YOU 第 2 行写 ⌥⌘2；⌥⌘1 跳出错的、⌥⌘2 跳等批准的、⌥⌘3 没有这一行不动 |
| MP2 | mp2-pin-new-search | 右键 Shell 一行 › Pin、右键 api · feat/pool › Pin → PINNED 两项，下面不再重复；重开应用还在、顺序不变；单击置顶的工作路径选中那个框；单击置顶的 Shell 跳过去 → New › Terminal › Shell 开在 shop · feat/cart 的框里并聚焦；Search 按分支只留命中的、Esc 退出；右键置顶的工作路径 › Unpin |
| IS-124 | is124-local-pdf | 沙盒里现写的 6 页 PDF，右键 New browser、地址栏真键盘：本地 PDF 的 iframe 不带 sandbox，Chromium 的 PDF 查看器显示 1/6（主进程里读查看器的页码）；`file://…pdf#page=4` 打开在第 4 页；开着时地址栏换 #page=5、#page=2 都跳过去（界面带 ?r=n 重新载入，存下的地址不带 ?r）；.pptx 不载入，写 “This file can’t be shown on the board.” + Open in default app，没有下载（主进程照样记下载、不弹保存框） |
| IS-14 | is14-notify-click | agent 调 MCP notify：前台只出白板提示；关窗口后弹系统通知 “claude · <工作区>”（Notification.show 换成记录）→ 单击：窗口回来、视口移回那个终端、选中、键盘焦点在它的 xterm（打的字进了 claude）。设置里关掉通知时后台不发。真通知中心弹出要人工 |
| IS-15 | is15-system-terminal-apps | Settings 的 Terminal app 填 iTerm（osascript create window … command）、Ghostty（写 run/attach-<id>.command、`open -a`）：截下命令在伪终端里跑，接上沙盒 socket 上同一个会话、两个客户端、打字进 claude。真的弹出 App 要人工 |
| IS-06 | is06-trust-prompt | 假 claude 在带 .fake-claude-untrusted 的工作区里先画真 claude 的信任提示（不发钩子）→ 状态 needs-reply、摘要 Trust this folder?、顶栏 1 waiting，11 秒不点也不降级成“钩子没来”→ 回车信任 → SessionStart → Idle、pending 清掉 |
| IS-07 | is07-back-to-back-terminals | 同时连开 5 个 shell（openTerminal 不再隔 600ms），等 2 秒：每个都接上显示、没有 “Previous session ended” |
| IS-82 | is82-zoomed-mouse | 白板 60%、140% 缩放下：单击第 7 行的 localhost 地址打开的是 p07（不是上一行）；拖选第 4 行的 “row-04” 选中的就是这几个字（去掉修复时两条都失败） |
| IS-26（B1 T2 G4，要 `AGENTDECK_E2E_PERF=1`） | is26-performance | B1：30 个窗口（20 个终端有输出、其中 3 个一直打印，10 个网页）6 × 5 排开，100% 和 60% 缩放各真鼠标拖空白处平移 12 次，rAF 记帧间隔：掉帧 ≤ 5%、p95 ≤ 1.5 个刷新间隔、最长 ≤ 100ms，另记 LoAF、attach / detach 次数。T2：4 个假 claude + 2 个 bash 都在视口里，真键盘一个字一个字打，keydown 到达页面 → 回显进 xterm 缓冲区 → xterm 画出来，p95 ≤ 50ms；第二段两个 bash 一直打印再量。G4：框里 6 个空闲终端 + 网页、面板开着，最后一次输入后先等 40 秒（Clawd 30 秒没输入就睡，IS-161），静置 60 秒、期间 Clawd 不出现，`app.getAppMetrics()` 每个进程的 CPU 和 tmux 那一串（ps）：合计 ≤ 2%、每个 ≤ 1% 一个核，空闲时不调 git；再拿掉 Clawd、开 reduced motion 各量 30 秒找原因 |

`test.fail` 标着的是**已知缺口**（现在失败才算通过；修好后会报“意外通过”，那时去掉 `test.fail`）：

- TC-01：选子文件夹时界面不提示“用了仓库根目录”（`ProjectProbe.usedRepoRoot` 有，`addProject` 没用）。
- TC-06：第二次单击同一个地址只聚焦、不刷新（终端打开网页时没带 `reloadToken`）。
- IS-159（IS-15 时发现）：系统终端 App 打不开（osascript / open 退出码非 0）时界面什么也不说。

TC-48、TC-81 的两条（IS-153～IS-155）2026-10-29 修好，已经是普通测试；IS-124 的两条和 IS-26 的 G4（IS-161）同一天修好，也是普通测试了。

2026-10-28 起，TC-01–TC-148 里已经实现的用例都有脚本；只能人工的步骤写在上表各行（真 claude、真登录、真重启、触控板手感、系统通知弹窗等）。

## 只跑受影响的（`pnpm e2e:affected`）

2026-10-29 用户定：改完只跑可能被影响到的 e2e，不每次全跑（全量 55 个文件、92 条，约 12 分钟）。

- `pnpm e2e:affected`：和 main 的分叉点比（`-- --base <ref>` 换基准），加上还没提交、没跟踪的文件；打印选中的 spec 和每条是被哪个文件带进来的，然后构建并跑。`-- --list` 只打印；其余参数交给 playwright（`-- --retries=0 --repeat-each=3`）。
- 规则在 `e2e/affected.mjs`：路径前缀或正则 → spec 文件名 / ALL / NONE，每个文件按顺序找第一条命中的。文档、各包的单元测试、AGENTS.md → 不跑；改了哪个 spec → 跑它；contracts、`apps/desktop` 的组装、白板的控制器和 store、ui/kit、e2e 支撑代码和假 agent、依赖 → 全跑；没有规则认领的源码 → 全跑并提示补规则。只改了注释的文件不算。选中了任何一条时另加冒烟的 TC-01 / TC-02。
- **新加 spec 时在 `e2e/affected.mjs` 里挂上它覆盖的代码**：`pnpm check` 里跑 `node e2e/scripts/affected.mjs --check`，有 spec 没挂上、或规则里写了不存在的 spec 就不过。
- 合进 main 之前、CI 上照旧全跑。

## 已知问题（测试里绕开的，见各处注释）

- **Playwright 下第一个页面的 preload 跑两次**：主进程开了两条终端输出端口，preload 拿第一条，utilityProcess 用第二条，终端没有输出、输入一直扣着。
  只在 Playwright 接管时见到（直接启动只有一次）。`support/app.ts` 启动后先刷新一次页面绕开。根上的问题是 preload 只认第一条端口（`ipcRenderer.once`），收到新端口时不会换。
- **Playwright 默认的单击（按下和抬起之间没有间隔）点没聚焦的终端**：按下时聚焦、窗口重排，click 落到白板空白处又把焦点清掉。`deck.focusWindow` 用 80ms 的按压绕开；真人点击没见到这个问题。
- **IS-07**（已修，X6）：以前 500ms 内连开两个终端，第二个可能显示 “Previous session ended”，`openTerminal` 两次之间隔 600ms 绕开；2026-10-29 去掉了这个间隔，`is07-back-to-back-terminals` 专门连开 5 个。
- **登录 PATH 末尾补的常见目录**：AgentDeck 在读到的 PATH 后面补 /opt/homebrew/bin、/usr/local/bin 等（login-env.ts 的 withCommonPaths），
  本机这些目录里装着真的 codex、pi、omp，检测时会跑它们的 `--version`。2026-10-28 起沙盒默认就挡住它们（`support/sandbox.ts` 的 `SHIELDED_AGENTS`，`shieldRealAgents(sb)` 留作兼容）（fakebin 里放同名的假程序挡住）。
- **Playwright 的键盘进不了 webview**：CDP 的按键只到白板页面，网页里收不到、主进程的 before-input-event 也不触发。TC-28 的 ⌘[ ⌘] ⌘R
  从主进程对 webview 发 `webContents.sendInputEvent`。
- IS-08：重开应用后状态显示 Idle，TC-10 只断言状态机登记了终端，不断言 Running。

## 不许碰

只放测试。被测的代码（`apps/`、`packages/`、`tools/`）有问题登记进 `docs/status/tracking.py`，不在这里改。
