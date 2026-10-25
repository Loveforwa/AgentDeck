# @agentdeck/desktop

Electron 应用：IPC 层（F3）加第 3 波组装。只有这个包能把服务包和界面包接在一起（根目录 AGENTS.md「模块边界」）。

## 结构

```
electron.vite.config.ts   main / preload / renderer 三份构建；@agentdeck/* 打进产物，better-sqlite3 / node-pty 外部化；preload 输出 CJS
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
  menu.ts           应用菜单：白板快捷键注册成 accelerator；不占 ⌘R ⌘[ ⌘] ⌘L；Edit › Undo / Redo（X10）也发给界面，不归白板时界面回 nativeEdit 让主进程 webContents.undo() / redo()
  screenshot.ts     AGENTDECK_SCREENSHOT 截图模式
  window-options.ts 主窗口选项：macOS 上 hiddenInset 标题栏，红黄绿按钮在 34px 顶栏里居中（MVP v2 · V1）；StartupInfo.trafficLights 告诉界面留位置
  services.ts / registry.ts / ipc.ts / events.ts   注册表、IPC 路由、事件广播（F3）
  browser/          网页窗口的主进程部分（线 5）：BrowserService、响应头改写、agentdeck-file://、iframe 小桥
  mcp.ts            AgentDeck 的 MCP 服务（M1，packages/mcp-server）：工具通过注册表调服务
  skills.ts         Skills · MCP（N9）：写自带 skill、记下刚 kill 的终端、启动时按白板找这个终端的选择
src/utility/
  tmux-host.ts      utilityProcess 入口：startTmuxHost + port-watch，输出按 viewId 写进窗口端口
src/preload/        window.agentdeck（contracts 的 AgentDeckApi）、window.agentdeckDesktop、window.agentdeckFiles
src/shared/         方法名单、线路工具、主进程 ↔ utilityProcess 协议、应用壳自己的 IPC（desktop-bridge.ts）
src/renderer/       顶栏 + 白板（ui-canvas）+ 源代码管理面板（scm-panel），什么都没选中时换成快速定位列表（board-nav-panel，V5）；注册终端、网页两种窗口；演示模式（demo.ts）
test/               Vitest：注册表、preload 代理、主进程接线、组装用到的纯逻辑（assembly.test.ts）、browser
```

## MCP（M1）

`startAppMcp({ registry, emit })` 在 `app.whenReady` 后启动 `packages/mcp-server`，听 `127.0.0.1:47621`（被占用时随机端口），
token 在 `~/.agentdeck/run/mcp-token`。工具用 `viaRegistry` 调注册表里的服务（发起者 senderId 为 0，不是任何窗口），
所以服务注册上之后工具就能用；没注册的返回 `Service not available: …`。白板事件（`board.add-frame`、`board.open-window`）走 `emit` 广播。

已接好：`createAgentRuntime({ mcp: () => mcp?.endpoint ?? null })` 让 claude 启动时挂上它；`startAppMcp` 带 `workspaceOf`、`onInput`；`electron.vite.config.ts` 把 `@agentdeck/mcp-server` 打进主进程产物；退出时关掉。

N1（MVP v3）：
- codex 启动时也挂（`-c mcp_servers.agentdeck.*`，agent-adapters 自己算）；omp 用 `--plugin-dir`：启动时 `writeMcpPluginDir(<dataDir>/mcp-plugin)` 写一次固定内容的插件目录，传给 `createAgentRuntime({ mcpPluginDir })`。pi、kimi 挂不上，原因见 agent-adapters/AGENTS.md。
- `startAppMcp` 另给 `board`（`viaRegistry(registry, 'board')`，list_windows、focus_window 读保存的白板）、`confirm`（open_terminals 超过 6 个时系统对话框，默认按钮 Cancel）、`onNotify`（notify 工具：应用不在前台、通知开着时发系统通知，标题和状态提醒一样是 “claude · 工作区”，点了跳到那个终端）。
- 新的白板事件 `board.open-group`、`board.focus-window`、`board.notify` 同样走 `emit` 广播，白板（ui/canvas）处理。

## Skills · MCP（N9）

源代码管理面板里的 SKILLS · MCP 小节，跟着聚焦的终端。规则见 agent-adapters/AGENTS.md「Skills · MCP」。组装：

- 数据目录下：`skills/<name>/`（库里的 skill，Add skill… 复制进来）、`mcp/<name>.json`（库里的 MCP，Add MCP…）、
  `builtin/skills/agentdeck/`（自带 skill，每次启动用 `writeBuiltinSkills` 重写）、`skill-sets/<agent>-<哈希>/`（启动时写的那套目录，内容一样就复用）、
  `skills-state.json`（每个终端启动时带了什么，面板的 running）。都不碰用户自己的 ~/.claude*、~/.codex、~/.pi、~/.omp、~/.kimi-code 和仓库。
- `SkillsServiceImpl` 注册成 `skills`；lookup 用状态机的 agent 和库里终端记录的 cwd；`mcpRunning` 是 MCP 服务起来了没有（agentdeck 那一行的状态点）。
- `createAgentRuntime({ skills, onStarted })`：启动前 `skills.prepareLaunch({ agent, cwd, selection })`，起来后 `noteLaunched(终端, ids)`。
- 选择存在白板上（`TerminalWindowData.skills`，界面勾选时 `controller.updateData`）。主进程启动时读保存的白板找（`skillSelectionFor`）：
  15 秒内刚 `terminals.kill` 的、agent 和目录一样的终端所在的窗口（终端窗口重启都是先 kill 再 start；注册表里的 terminals 包了一层记 kill）；
  否则 resume 时 sessionId 一样的窗口；都没有用默认。面板上的 Restart and resume 先 `controller.flush()` 存白板，再给窗口发 `restart-resume`。
- 界面：`App.tsx` 的 `useSkillsTarget` 把聚焦的终端窗口交给 `ScmPanel` 的 `skills`；聚焦的不是终端时传 null。

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
| `AGENTDECK_DATA_DIR` | 数据目录。默认：开发时 `<仓库>/.agentdeck-dev`，打包后 `~/.agentdeck` |
| `AGENTDECK_TMUX_SOCKET` | tmux `-L` 名字。默认：开发时 `agentdeck-desktop-dev`，打包后 `agentdeck` |
| `AGENTDECK_DEMO=1` | 演示：见上 |
| `AGENTDECK_SCREENSHOT=<png>` | 截图后退出；`AGENTDECK_SCREENSHOT_DELAY`（毫秒，默认 6000）是终端都有输出之后再等多久 |
| `AGENTDECK_DEBUG_PORT` | 只在开发时：界面开 Chrome DevTools 协议端口，脚本驱动界面用；控制台里 `__board` 是白板控制器 |

端到端测试（R2）：根目录 `pnpm e2e`，用 Playwright 启动 `out/` 里的应用，每个测试单独的 `AGENTDECK_DATA_DIR`、`AGENTDECK_TMUX_SOCKET`、HOME 和 `--user-data-dir`，agent 是假 claude。见 `e2e/AGENTS.md`。

清掉开发数据：退出应用，`tmux -L agentdeck-desktop-dev kill-server`，删 `.agentdeck-dev/`。

Electron 45 第一次运行时才下载二进制（pnpm 10 不跑依赖的 postinstall）：`node apps/desktop/node_modules/electron/install.js`（走代理时加 `ELECTRON_GET_USE_PROXY=1 GLOBAL_AGENT_HTTPS_PROXY=$https_proxy`）。

## 接线要点

- **登录 shell 环境**：启动时读一次（`login-env.ts`），传给 tmux-host（窗格环境）、agent-adapters（检测、启动命令）、git-service、编辑器 / 系统终端。读失败时界面左下角提示。
- **终端**：tmux-host 跑在 utilityProcess（`src/utility/tmux-host.ts`）。主进程的 `terminals` 服务是转发层，attach 时带上 `registry.context().senderId`；输出不经过主进程，直接写进那个窗口的 MessagePort。窗口刷新或关掉时 detach 它的所有 view。tmux 起不来时界面显示说明页和 Retry（再起一次）。
- **状态机**：tmux-host 的 `terminal.*` 事件交给 agent runtime；`terminal.input` 时调 `noteInput`（claude 拒绝批准、Esc 打断没有钩子）。`agents.start` 之后把终端记进 store 的 terminals 表，重开应用时按记录 `track` 回来。
- **钩子**：每次启动在 `<数据目录>/bin/agentdeck-notify` 写一个 sh 入口（带 `AGENTDECK_HOOK_SOCKET`；用登录 shell 里的 node，没有就用 Electron 当 node），把它的绝对路径交给适配器。pi、omp 的扩展 `tools/agentdeck-notify/bin/agentdeck-pi-extension.mjs`（打包后放 Resources）的路径作为 `agentExtension` 传给 agent runtime。
  重开应用接回终端时，“带不带钩子”按 `agents.list()` 里各 agent 的 `capabilities.hooks` 定。
  `custom` 照常交给界面，白板自己不列它（IS-21，见 `packages/ui/canvas/src/model/agents.ts`）。
- **git**：git-service 的 `git.status` 事件同时交给 workspace-service 的 `noteStatus`（分支变了更新框标题）。
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
