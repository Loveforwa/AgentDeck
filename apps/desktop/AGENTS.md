# @agentdeck/desktop

Electron 应用：IPC 层（F3）加第 3 波组装。只有这个包能把服务包和界面包接在一起（根目录 AGENTS.md「模块边界」）。

## 结构

```
electron.vite.config.ts   main / preload / renderer 三份构建；@agentdeck/* 打进产物，better-sqlite3 / node-pty 外部化；preload 输出 CJS
electron-builder.config.cjs  打包配置（IS-36）：macOS .app / .dmg，ad-hoc 签名，asarUnpack 原生模块，Resources 里放 tmux.conf 和钩子脚本
build-resources/          图标：icon.svg（源）、icon.icns、icon.png（scripts/make-icon.sh 生成，提交进仓库）
scripts/                  dist.mjs（pnpm dist）、stage-app.mjs（准备 .stage/app）、after-pack.cjs（检查 .app）、make-icon.sh
src/main/
  index.ts          入口：数据目录、登录 shell 环境、store、终端 utilityProcess、git / 工作区 / agent / browser 服务、菜单、窗口、退出
  paths.ts          数据目录、运行目录（socket 路径太长时挪到 /tmp）、tmux 名字、tmux.conf、agentdeck-notify 和 pi 扩展在哪（纯逻辑）
  login-env.ts      $SHELL -ilc 读登录 shell 环境（干净环境、标记、3 秒超时、失败退回）
  settings.ts       设置存在 <数据目录>/settings.json
  app-service.ts    AppService：选文件夹、编辑器、系统终端、访达、废纸篓、设置、退出、角标
  alerts.ts         后台通知和程序坞角标（规则在 agent-adapters 的 backgroundAlerts）
  terminal-service.ts 主进程里的 TerminalHost 转发层：调用交给 utilityProcess，attach 带上发起的窗口
  host-process.ts   启动终端 utilityProcess，转交端口和控制消息、收回复
  terminal-ports.ts 每个窗口一条 MessageChannelMain：port1 给 preload，port2 给 utilityProcess
  menu.ts           应用菜单：白板快捷键注册成 accelerator（CO4 的 ⌥⌘1–9 在 Go › Jump to Agent › Row n）；不占 ⌘R ⌘[ ⌘] ⌘L；Edit › Undo / Redo（X10）也发给界面，不归白板时界面回 nativeEdit 让主进程 webContents.undo() / redo()
  screenshot.ts     AGENTDECK_SCREENSHOT 截图模式
  window-options.ts 主窗口选项：macOS 上 hiddenInset 标题栏，红黄绿按钮在 34px 顶栏里居中（MVP v2 · V1）；StartupInfo.trafficLights 告诉界面留位置
  services.ts / registry.ts / ipc.ts / events.ts   注册表、IPC 路由、事件广播（F3）
  browser/          网页窗口的主进程部分（线 5）：BrowserService、响应头改写、agentdeck-file://、iframe 小桥
  mcp.ts            AgentDeck 的 MCP 服务（M1，packages/mcp-server）：工具通过注册表调服务
  skills.ts         Skills · MCP（N9）：写自带 skill、记下刚 kill 的终端、启动时按白板找这个终端的选择
  sessions.ts       AgentDeck 自己的 Session（M9 · SE2）：SessionServiceImpl，包住 agents.start、听钩子和终端退出，注册成 sessions

  limits.ts         额度上限（PL5，插件 Auto-resume）：LimitServiceImpl 接上 sendKeys、用量、子 agent、白板、Resume prompt；不让 Mac 睡的几个来源合在一起
src/utility/
  tmux-host.ts      utilityProcess 入口：startTmuxHost + port-watch，输出按 viewId 写进窗口端口
src/preload/        window.agentdeck（contracts 的 AgentDeckApi）、window.agentdeckDesktop、window.agentdeckFiles
src/shared/         方法名单、线路工具、主进程 ↔ utilityProcess 协议、应用壳自己的 IPC（desktop-bridge.ts）
src/renderer/       顶栏 + 左边管理面板（manager-panel，MP2：`ManagerSidebar.tsx` 接白板状态、置顶 `BoardState.pins`、New 菜单 `newMenuItems`；NEEDS YOU 的顺序 `needsYouOrder` 交给 BoardController 的 `agentOrder`，⌥⌘1–9 用）+ 白板（ui-canvas）+ 源代码管理面板（scm-panel，MP3 起右边只放它，什么都没聚焦时写 “Focus a terminal to see its changes.”）；注册终端、网页两种窗口；演示模式（demo.ts）
test/               Vitest：注册表、preload 代理、主进程接线、组装用到的纯逻辑（assembly.test.ts）、browser
```

## MCP（M1）

`startAppMcp({ registry, emit })` 在 `app.whenReady` 后启动 `packages/mcp-server`，听 `127.0.0.1:47621`（被占用时随机端口），
token 在 `<数据目录>/run/mcp-token`（打包后默认就是 `~/.agentdeck/run/mcp-token`；开发、测试时跟着 `AGENTDECK_DATA_DIR` 走）。工具用 `viaRegistry` 调注册表里的服务（发起者 senderId 为 0，不是任何窗口），
所以服务注册上之后工具就能用；没注册的返回 `Service not available: …`。白板事件（`board.add-frame`、`board.open-window`）走 `emit` 广播。

已接好：`createAgentRuntime({ mcp: () => mcp?.endpoint ?? null })` 让 claude 启动时挂上它；`startAppMcp` 带 `workspaceOf`、`onInput`；`electron.vite.config.ts` 把 `@agentdeck/mcp-server` 打进主进程产物；退出时关掉。

N1（MVP v3）：
- codex 启动时也挂（`-c mcp_servers.agentdeck.*`，agent-adapters 自己算）；omp 用 `--plugin-dir`：启动时 `writeMcpPluginDir(<dataDir>/mcp-plugin)` 写一次固定内容的插件目录，传给 `createAgentRuntime({ mcpPluginDir })`。pi、kimi 挂不上，原因见 agent-adapters/AGENTS.md。
- `startAppMcp` 另给 `board`（`viaRegistry(registry, 'board')`，list_windows、focus_window 读保存的白板）、`confirm`（open_terminals 超过 6 个时系统对话框，默认按钮 Cancel）、`onNotify`（notify 工具：应用不在前台、通知开着时发系统通知，标题和状态提醒一样是 “claude · 工作区”，点了跳到那个终端）。
- 新的白板事件 `board.open-group`、`board.focus-window`、`board.notify` 同样走 `emit` 广播，白板（ui/canvas）处理。

AH11：`startAppMcp` 给 `hiddenFromAgents`：每次调用读保存的白板，`hiddenTerminalIds` 挑出 `TerminalWindowData.hideFromAgents` 为 true 的终端，agent 看不到、读不了、打不进（白板改动后半秒保存，刚勾上的有这点延迟）。

## Session（M9 · SE2）

`src/main/sessions.ts` 的 `SessionServiceImpl` 实现 contracts 的 `SessionService`，数据在 store 的 sessions 表（SE1）。服务不知道窗口：
窗口和 Session 的对应只在白板上（`TerminalWindowData.session`，界面拿 `StartAgentResult.session` 存，SE4 接）。组装（index.ts 里几行）：

- `agents.start` = `sessions.start(req, (r) => rt.agents.start(r))`，再照旧写 terminals 表（多写 `session`）。接回哪条：`req.session`（库里没有就用这个 id 新建）；
  没带、mode 是 resume 时按 agent 会话 id 找（X6 恢复、历史栏 Resume 在界面写 data.session 之前也能接对）；都没有新建。
  parent 不在库里当没有；origin 不填时 fork 记 fork（父按被 fork 的对话找）、resume 记 adopted、其余 user。agent 不一样的不接。launch 抛错什么也不记。
- `tapHook` 里 `sessions.noteHook(h)`：session-start 换了 agent 会话 id 才加一段，原因取 SessionStart 的 source（agent-adapters 的 `parseSessionStart`）；
  和最后一段同一个 id（启动时报的、resume 同一个、compact）不加。启动时不知道 id（codex、omp）且钩子不带原因时，第一段按启动方式记（start / resume / fork），之后的记 unknown。
  start 返回前就到的钩子和退出事件留 10 秒，对上终端后补上。
- `terminals.onEvent` 里 `sessions.noteTerminalEvent(event)`：terminal.exit 改 stopped、terminalId 清掉（handed-off 的保持）；terminal.host-lost 全部停。
- 启动拿到 `terminals.list()` 后 `store.terminals.prune(...)`（IS-95）和 `sessions.reconcile(live)`：对不上活着的进程的改 stopped。
- `handoff` 经 `agents.start` 开子 session（origin handoff，第一条消息是说明），原来那条 handed-off，窗口和进程不动；`handoffSummary` 先只写目标、目录、上一段对话，SE6 补分支、diff、最后的输出。
- 测试 `test/sessions.test.ts`：真的 AgentService、claude 适配器、钩子 socket、agentdeck-notify，对着 `e2e/fake-agent/fake-claude.mjs`（子进程，不用 tmux）。

## Skills · MCP（N9）

源代码管理面板里的 SKILLS · MCP 小节，跟着聚焦的终端。规则见 agent-adapters/AGENTS.md「Skills · MCP」。组装：

- 数据目录下：`skills/<name>/`（库里的 skill，Add skill… 复制进来）、`mcp/<name>.json`（库里的 MCP，Add MCP…）、
  `builtin/skills/agentdeck/`（自带 skill，每次启动用 `writeBuiltinSkills` 重写）、`skill-sets/<agent>-<哈希>/`（启动时写的那套目录，内容一样就复用）、
  `skills-state.json`（每个终端启动时带了什么，面板的 running）。都不碰用户自己的 ~/.claude*、~/.codex、~/.pi、~/.omp、~/.kimi-code 和仓库。
- `SkillsServiceImpl` 注册成 `skills`；lookup 用状态机的 agent 和库里终端记录的 cwd；`mcpRunning` 是 MCP 服务起来了没有（agentdeck 那一行的状态点）。
- `createAgentRuntime({ skills, onStarted })`：启动前 `skills.prepareLaunch({ agent, cwd, selection })`，起来后 `noteLaunched(终端, ids, setDir)`。
- 清理 `skill-sets/`（IS-112）：`liveTerminals` 用 `terminals.list()` 里 `alive` 的终端；启动时调一次 `skills.cleanupSkillSets()`，之后每天一次（`setInterval`，退出时清掉），失败只记日志。
- 选择存在白板上（`TerminalWindowData.skills`，界面勾选时 `controller.updateData`）。主进程启动时读保存的白板找（`skillSelectionFor`）：
  15 秒内刚 `terminals.kill` 的、agent 和目录一样的终端所在的窗口（终端窗口重启都是先 kill 再 start；注册表里的 terminals 包了一层记 kill）；
  否则 resume 时 sessionId 一样的窗口；都没有用默认。面板上的 Restart and resume 先 `controller.flush()` 存白板，再给窗口发 `restart-resume`。
- 界面：`App.tsx` 的 `useSkillsTarget` 把聚焦的终端窗口交给 `ScmPanel` 的 `skills`；聚焦的不是终端时传 null。

## 额度上限（PL5）

`createLimits(...)`（`src/main/limits.ts`）建 agent-adapters 的 `LimitServiceImpl`，注册成 `limits`（只开放 contracts 的五个方法，`limitsApi`）。规则见 agent-adapters/AGENTS.md「额度上限」。

- 输入：`tapHook` → `noteHook`（StopFailure error、quota_auto_resume_*、UserPromptSubmit、SubagentStart）；`emit` 里的 `usage.changed` → `noteUsage`、`status.changed` → `noteStatus`；
  `terminal.input` → `noteInput`；`terminal.exit` → `noteTerminalGone`。退出时 `close()`。
- 账号目录：登录 shell 环境的 CLAUDE_CONFIG_DIR / CODEX_HOME；claude 会不会自己续看 `agents.list()` 里 claude 的版本（启动时读一次，之后半小时一次）。
- Auto-resume 开关和 Prompt queue 每次检查时从 `store.board.load()` 读（界面改了半秒后存进库）；Resume prompt 读 `settings.resumePrompt`。
- 不让 Mac 睡：`createKeepAwake` 把 Prompt queue（界面调 `app.setKeepAwake`，来源 queue）和 LimitService（来源 limits）合在一起，都不要了才放开。

## 运行

```bash
pnpm dev                                                   # 根目录。数据在仓库的 .agentdeck-dev/（git 忽略），tmux -L agentdeck-desktop-dev
AGENTDECK_DEMO=1 pnpm dev                                  # 自动把本仓库加成项目、建主目录工作区、开 Shell（git status / log）和 claude（只启动）
AGENTDECK_DEMO=1 AGENTDECK_SCREENSHOT=/abs/shot.png pnpm dev   # 白板加载完、终端有输出后截整个窗口，然后正常退出（tmux 里的终端留着）
pnpm --filter @agentdeck/desktop test
pnpm --filter @agentdeck/desktop typecheck
```

环境变量：

| 变量 | 作用 |
| --- | --- |
| `AGENTDECK_DATA_DIR` | 数据目录。默认：开发时 `<仓库>/.agentdeck-dev`，打包后 `~/.agentdeck`。打包后照样认，测试打包版就靠它和下一条（见「打包」） |
| `AGENTDECK_TMUX_SOCKET` | tmux `-L` 名字。默认：开发时 `agentdeck-desktop-dev`，打包后 `agentdeck` |
| `AGENTDECK_DEMO=1` | 演示：见上 |
| `AGENTDECK_SCREENSHOT=<png>` | 截图后退出；`AGENTDECK_SCREENSHOT_DELAY`（毫秒，默认 6000）是终端都有输出之后再等多久 |
| `AGENTDECK_RESUME_STAGGER_MS` / `AGENTDECK_LIMIT_GRACE_MS` | 测试用（PL5）：同一账号几个终端续跑的间隔（默认 30000）、恢复时间后再等多久（默认 60000），毫秒 |
| `AGENTDECK_DEBUG_PORT` | 只在开发时：界面开 Chrome DevTools 协议端口，脚本驱动界面用；控制台里 `__board` 是白板控制器 |

端到端测试（R2）：根目录 `pnpm e2e`，用 Playwright 启动 `out/` 里的应用，每个测试单独的 `AGENTDECK_DATA_DIR`、`AGENTDECK_TMUX_SOCKET`、HOME 和 `--user-data-dir`，agent 是假 claude。见 `e2e/AGENTS.md`。

清掉开发数据：退出应用，`tmux -L agentdeck-desktop-dev kill-server`，删 `.agentdeck-dev/`。

Electron 45 第一次运行时才下载二进制（pnpm 10 不跑依赖的 postinstall）：`node apps/desktop/node_modules/electron/install.js`（走代理时加 `ELECTRON_GET_USE_PROXY=1 GLOBAL_AGENT_HTTPS_PROXY=$https_proxy`）。

## 打包（IS-36）

```bash
pnpm dist                                      # 根目录。arm64、x64 两个 dmg → apps/desktop/dist/（git 忽略）
pnpm --filter @agentdeck/desktop dist:arm64    # 只打 arm64
pnpm --filter @agentdeck/desktop dist:dir      # 只出 dist/mac-arm64/AgentDeck.app，不做 dmg（本机试用最快）
```

第一次要联网：electron-builder 下载对应架构的 Electron 和做 dmg 的工具（缓存在 `~/Library/Caches/electron`、`~/Library/Caches/electron-builder`）。只能在 macOS 上打。

**大小**（0.1.0，Electron 45）：dmg arm64 约 113 MB、x64 约 120 MB；装好的 .app 约 254 MB，其中 Electron Framework 约 240 MB，我们自己的只有 app.asar 3 MB 加原生模块 2 MB。

**流程**（`scripts/dist.mjs`）：
1. `electron-vite build`（普通生产构建；e2e 的 `build-app.mjs` 那份带 `import.meta.env.DEV`，不能拿来打包）。
2. `scripts/stage-app.mjs` 准备 `.stage/app/`：`out/`、只有运行字段的 `package.json`（dependencies 只有 better-sqlite3、node-pty）、
   这两个模块的 lib 和 macOS 预编译（spawn-helper 补成 0755）、一份 `package-lock.json`。
   为什么不直接打本包：本包的 dependencies 是 workspace 的 TS 源码包（已经打进 out/），electron-builder 认出 pnpm workspace 后会把
   整棵依赖树（react、xterm、zod……）收进 app.asar（实测 app.asar 31 MB、unpacked 29 MB）。有 package-lock.json 时它按 npm 项目只收这两个。
3. electron-builder（`electron-builder.config.cjs`，projectDir 是 `.stage/app`，所以配置里都是绝对路径）：
   - 原生模块：两个都是 N-API 预编译（DR-27），**不重新编译**（`npmRebuild: false`），整个模块 `asarUnpack`。node-pty 自己会把
     `app.asar` 换成 `app.asar.unpacked` 去找 spawn-helper；better-sqlite3 经 Electron 的 asar 支持读 unpacked 里的 .node。
   - `extraResources`：`tmux.conf`、`agentdeck-notify.mjs`、`agentdeck-pi-extension.mjs`、`agentdeck.mjs`（CR15 的命令）放进 `Contents/Resources`（`process.resourcesPath`，
     路径在 `src/main/paths.ts`）。MCP 插件目录、自带 skill 是代码里的字符串，启动时写进数据目录，不用随包带文件。
   - `scripts/after-pack.cjs`（签名前）：缺 Resources 里的文件、缺这个架构的 .node 或 spawn-helper 就让打包失败；spawn-helper 保证 0755；删掉另一个架构的预编译。
   - 签名：**ad-hoc**（`identity: '-'`），不开 hardened runtime，不公证。Apple 芯片上完全不签名的程序内核不让跑；ad-hoc 能跑，但 Gatekeeper 不认。
   - Info.plist：`dev.agentdeck.app`，`NSAppleEventsUsageDescription`（Open in Terminal 用 osascript 驱动 Terminal / iTerm）。

**没签名的应用怎么打开**（写进 README / Release 说明）：从浏览器下载的 dmg 带隔离标记，第一次打开会被拦下。
- 访达里右键 AgentDeck › 打开 › 打开（macOS 15 起这一步不够：先双击一次被拦，再到 系统设置 › 隐私与安全性 最下面点“仍要打开”）；或者
- 终端里：`xattr -dr com.apple.quarantine /Applications/AgentDeck.app`

运行时还要用户自己装 tmux ≥ 3.5（`brew install tmux`）和 git（Xcode 命令行工具）；没有 tmux 时界面显示说明页和 Retry（TC-19）。

**测试打包版**：一定带临时的数据目录、tmux 名字和 Electron userData，别碰用户真实的 `~/.agentdeck`、`~/Library/Application Support/AgentDeck`：

```bash
hdiutil attach -nobrowse -readonly -mountpoint /tmp/ad-mnt apps/desktop/dist/AgentDeck-0.1.0-arm64.dmg
env -i HOME=$HOME AGENTDECK_DATA_DIR=/tmp/ad-test/data AGENTDECK_TMUX_SOCKET=agentdeck-pkgtest \
  AGENTDECK_SCREENSHOT=/tmp/ad-test/shot.png /tmp/ad-mnt/AgentDeck.app/Contents/MacOS/AgentDeck --user-data-dir=/tmp/ad-test/ud
tmux -L agentdeck-pkgtest kill-server; hdiutil detach /tmp/ad-mnt
```

`env -i` 模拟从访达 / 程序坞打开（launchd 给的环境很少）。打包版不开 `AGENTDECK_DEBUG_PORT`；要驱动界面用 Playwright 的
`_electron.launch({ executablePath: '<AgentDeck.app>/Contents/MacOS/AgentDeck', args: ['--user-data-dir=…'], env })`（Electron 的 inspect 开关没关），
页面里有 `window.agentdeck`，没有 `window.__board`（生产构建）。

**发布**：
1. 改 `apps/desktop/package.json` 的 `version`（dmg 文件名、Info.plist 的版本号都用它，和标签对上），提交。
2. `pnpm dist`，按上面试一遍 arm64 的 dmg。
3. 打标签 `v0.1.0` 并推上去：`.github/workflows/release.yml` 在 macOS 上 `pnpm check && pnpm dist`，
   把两个 dmg 传到同名 Release（草稿）。也可以不用 Actions：`gh release create v0.1.0 apps/desktop/dist/*.dmg --draft --generate-notes`。
4. 在 GitHub 上检查草稿、写说明（附上面“怎么打开”），Publish。README 的下载链接是 `https://github.com/Loveforwa/AgentDeck/releases/latest`，只指向已发布的最新版。

还没做：Developer ID 签名和公证（要 Apple 开发者账号，做了以后不用 xattr；那时要开 hardened runtime 并配 entitlements）、自动更新、universal 包（两个 dmg 更小）、随应用带 tmux（docs/decisions.md 推迟到 MVP 之后）。

## 接线要点

- **登录 shell 环境**：启动时读一次（`login-env.ts`），传给 tmux-host（窗格环境）、agent-adapters（检测、启动命令）、git-service、编辑器 / 系统终端。读失败时界面左下角提示。
  从访达 / 程序坞打开时（IS-11）环境里可能连 SHELL、USER 都没有：从 `os.userInfo()` 补；读到的 PATH 末尾补上存在的常见目录
  （`/opt/homebrew/bin`、`/usr/local/bin`、`~/.local/bin`、`~/.bun/bin`、`~/.npm-global/bin`、`~/Library/pnpm`、`~/.volta/bin`、`~/.cargo/bin`）。
- **终端**：tmux-host 跑在 utilityProcess（`src/utility/tmux-host.ts`）。主进程的 `terminals` 服务是转发层，attach 时带上 `registry.context().senderId`；输出不经过主进程，直接写进那个窗口的 MessagePort。窗口刷新或关掉时 detach 它的所有 view。tmux 起不来时界面显示说明页和 Retry（再起一次）。
- **状态机**：tmux-host 的 `terminal.*` 事件交给 agent runtime；`terminal.input` 时调 `noteInput`（claude 拒绝批准、Esc 打断没有钩子）。`agents.start` 之后把终端记进 store 的 terminals 表，重开应用时按记录 `track` 回来。
- **钩子**：每次启动在 `<数据目录>/bin/agentdeck-notify` 写一个 sh 入口（带 `AGENTDECK_HOOK_SOCKET`；用登录 shell 里的 node，没有就用 Electron 当 node），把它的绝对路径交给适配器。pi、omp 的扩展 `tools/agentdeck-notify/bin/agentdeck-pi-extension.mjs`（打包后放 Resources）的路径作为 `agentExtension` 传给 agent runtime。
  重开应用接回终端时，“带不带钩子”按 `agents.list()` 里各 agent 的 `capabilities.hooks` 定。
- **agentdeck 命令**（CR14、CR15）：每次启动在 `<数据目录>/bin/agentdeck` 写同样的 sh 入口（`writeNodeWrapper`，带 `AGENTDECK_API_FILE=<数据目录>/run/api.json`），
  运行 `tools/agentdeck-cli/bin/agentdeck.mjs`（打包后在 Resources）。MCP 服务起来后把地址写进那个 api.json（数据目录就是 `~/.agentdeck` 时正好是 contracts 的默认位置）。
  密钥（`<数据目录>/run/mcp-token`）在建 agent runtime 前就读好：`terminalKey` 给每个终端算钥匙，`binDir` 放在每个终端 PATH 最前面（agent-adapters）。
  只在 AgentDeck 开的终端里有这个命令；不改用户的 shell 配置。crew、sessions 还没注册（CR2、SE2）时 /cli 的相应命令回 “… is not available yet”，被拒的命令记一行 `[agentdeck:cli]` 日志。
  `custom` 照常交给界面，白板自己不列它（IS-21，见 `packages/ui/canvas/src/model/agents.ts`）。
- **git**：git-service 的 `git.status` 事件同时交给 workspace-service 的 `noteStatus`（分支变了更新框标题）和 doc-service 的 `noteGitEvent`（HEAD 变了重算开着的文档的引用）。
- **文档、代码锚点**（M15 · DC2）：`createDocServices({ git, store: store.docAnchors, emit, readOnlyRoots: [数据目录] })`，`docs`、`anchors` 注册的是只含 contracts 方法的 `api`。git 传的是 git-service 的 `SystemGitService`（多出的 `renamedPath`、`listFiles` 一起用上）。钩子经 `tapHook` 给 `noteToolUse`（PostToolUse 的 `tool_input.file_path`，相对路径按 store 里终端的 cwd 算）认“谁改的”；退出时 `close`。测试：`test/doc-anchors.test.ts`（真 git + 真 store：TC-97–100、106 的后台部分、100 处引用的耗时；`AGENTDECK_DRIFT=1` 时对照第 11 点的 drift.py）。
- **token 用量**（PL2）：`UsageServiceImpl`（agent-adapters）注册成 `usage` 服务；`lookup` 用状态机的 agent / 会话 id 和 store 的 cwd，启动时间只记本次运行里 `agents.start` 的（kimi 推断用；重开应用接回的终端没有，退回取同目录最近活动的会话）；钩子经 `tapHook` 先给它；`status.changed` 时 `noteSession`；退出时 `close`。
- **网页**：`registerBrowserService(registry)`。onHeadersReceived 每个 session 只能有一个，现在只有 browser 模块用；别的地方要改响应头，合进 `browser/index.ts` 的 `installOnSession`。
- **菜单**：白板快捷键注册成 accelerator，点击时发给界面（`agentdeck-desktop:shortcut`），界面调 `runShortcut`；同一组合键白板页面刚处理过（500ms 内）就不再执行。编辑菜单是 copy / paste 必需的。
- **关窗口和退出**：关窗口默认隐藏（后台继续），程序坞点回来；⌘Q、程序坞 Quit 先让界面存白板，再断开 tmux-host（会话留着）；Stop All Terminals and Quit 才 kill-server。

## 线路（F3）

- 调用：`api.git.status(repo)` → `ipcRenderer.invoke('agentdeck:invoke', { service, method, args })` → 注册表 → 结果或 `{ error }`；preload 把 `{ error }` 还原成 `AgentDeckError` 抛出。
- `FIRE_AND_FORGET` 里的方法（`terminals.write/resize`、`app.setBadge`）走 `ipcRenderer.send('agentdeck:send', ...)`，没有返回，出错只记日志。
- 事件：服务调 `emit(event)` → 所有窗口的 `agentdeck:event` → `api.on(type, listener)`。
- 只接受顶层 frame 的 IPC；子 frame（嵌进来的网页）的调用返回 invalid-argument。
- 服务抛 `AgentDeckError`（或 `AgentDeckErrorData` 形状的对象）会原样传到界面；其他异常变成 `internal`。没注册的服务或方法返回 `not-found`。

## 安全

`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；页面只能用 `window.agentdeck` 和上面两个小接口。禁止页面跳转；`window.open` 一律拒绝，http(s) 交给系统浏览器。index.html 的 CSP 带 `frame-src http: https: agentdeck-file:`（网页窗口的 iframe）。

## 不许碰

- `packages/contracts`：线路约定有问题写进 `CONTRACT_NOTES.md`；组装时发现的问题登记进 `docs/status/tracking.py`（IS-xx）。
- 其他包的目录（问题登记进 `docs/status/tracking.py`）。
