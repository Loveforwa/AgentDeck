# @agentdeck/e2e

端到端验收测试（任务 R2）：Playwright 的 Electron 模式驱动真的 AgentDeck（`apps/desktop`），终端跑在真的 tmux 里，git 是真的临时仓库，agent 是假的。
用例的步骤和预期以 `docs/status/tracking.py` 的 CASES 为准，测试名开头写用例编号。

## 跑法

```bash
pnpm e2e                                   # 根目录：先构建 apps/desktop/out，再跑全部用例（本机约 1 分钟）
pnpm --filter @agentdeck/e2e exec playwright test -g TC-05   # 只跑一条（要先构建过一次：pnpm --filter @agentdeck/e2e build:app）
AGENTDECK_E2E_KEEP=1 pnpm e2e              # 不删沙盒（打印路径和 tmux 名字），排查用；之后自己 tmux -L <名字> kill-server、删目录
```

- 要求：`tmux`、`git`、`node` 在 PATH 里；Electron 二进制下好了（`node apps/desktop/node_modules/electron/install.js`）。Playwright 不用下浏览器。
- **不在 `pnpm check` 里**（慢，要 tmux 和图形环境）。CI 是单独的 `.github/workflows/e2e.yml`（macOS + Ubuntu，Linux 用 `xvfb-run`）。
- 测试跑时会弹出 AgentDeck 窗口（macOS 上会抢一下焦点）。键盘、鼠标事件走 CDP，不需要窗口在前台。
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
| `quit` / `exit` | SessionEnd，退出码 0 | exited |
| `crash` | 无，退出码 3 | error |

每个钩子、每次批准都写进 `$AGENTDECK_E2E_LOG_DIR/<会话 id>.jsonl`（`deck.agentLog(terminalId)` 读），测试用它核对后台真的发生了什么。
`fake-agent/dev-server.mjs` 是 TC-06 用的“dev server”：打印 `Local: http://localhost:<端口>/`，每个请求记一行，故意带 `X-Frame-Options: DENY`。

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
| TC-12 | 同上 | 右键框 Delete workspace… → 连目录删 → 有未提交改动要勾选再确认 → 框消失、目录没了、分支还在、终端结束 |

`test.fail` 标着的两条是**已知缺口**（现在失败才算通过；修好后会报“意外通过”，那时去掉 `test.fail`）：

- TC-01：选子文件夹时界面不提示“用了仓库根目录”（`ProjectProbe.usedRepoRoot` 有，`addProject` 没用）。
- TC-06：第二次单击同一个地址只聚焦、不刷新（终端打开网页时没带 `reloadToken`）。

没写的：TC-03（两个 worktree 并行，要两个 agent 改文件，可以照 TC-30 写）、TC-04（主要看后台通知，系统通知点不到）、TC-08（分支占用跳框，可以写）、
TC-11（会打开系统终端 App）、TC-13（系统通知）、TC-14（未实现）。

## 已知问题（测试里绕开的，见各处注释）

- **Playwright 下第一个页面的 preload 跑两次**：主进程开了两条终端输出端口，preload 拿第一条，utilityProcess 用第二条，终端没有输出、输入一直扣着。
  只在 Playwright 接管时见到（直接启动只有一次）。`support/app.ts` 启动后先刷新一次页面绕开。根上的问题是 preload 只认第一条端口（`ipcRenderer.once`），收到新端口时不会换。
- **Playwright 默认的单击（按下和抬起之间没有间隔）点没聚焦的终端**：按下时聚焦、窗口重排，click 落到白板空白处又把焦点清掉。`deck.focusWindow` 用 80ms 的按压绕开；真人点击没见到这个问题。
- **IS-07**：500ms 内连开两个终端，第二个可能显示 “Previous session ended”。`openTerminal` 两次之间隔 600ms。
- IS-08：重开应用后状态显示 Idle，TC-10 只断言状态机登记了终端，不断言 Running。

## 不许碰

只放测试。被测的代码（`apps/`、`packages/`、`tools/`）有问题登记进 `docs/status/tracking.py`，不在这里改。
