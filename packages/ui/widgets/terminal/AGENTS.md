# @agentdeck/ui-widget-terminal

白板上的终端窗口（线 1 · T2 T3 T5 T6 T8）。需求见设计画布「5 · 终端窗口」「3 · 白板」（摘要卡）「9 · 保存与重启」「6 · 终端状态与提醒」（标题栏状态）。进程在 tmux 里（`packages/tmux-host`），这里只负责显示和输入。

## 对外接口

```ts
import { registerTerminalWindow, terminalWindowType, TerminalWindow, OPEN_SETTINGS_EVENT } from '@agentdeck/ui-widget-terminal';

registerTerminalWindow(); // = registerWindow(terminalWindowType)，registerWindow 来自 @agentdeck/ui-canvas/registry
```

`terminalWindowType`（contracts 0.1.3 的 `WindowTypeDefinition<TerminalWindowData>`）：

| 字段 | 值 |
| --- | --- |
| `type` / `label` | `'terminal'` / `'Terminal'` |
| `defaultSize` / `minSize` / `summaryBelow` | 560×360 / 110×60 / 320×200 |
| `pinnedToWorkspace` | `true` |
| `title(data)` | agent 名（claude、codex）；Shell 用命令名（`zsh`）；自定义命令用命令的第一个词 |
| `closeConfirm(data)` | 有 terminalId 时：“Close claude?” / “claude will be stopped. This can’t be undone.” / “Stop and close”（拿不到进程是否活着，见 tmux-host/CONTRACT_NOTES.md 第 1 条） |
| `onClose(data)` | `terminals.kill(terminalId)` |
| `menu` | Clear（⌘K）、Restart、Restart and resume conversation、Open in system terminal（命令 id：`clear`、`restart`、`restart-resume`、`open-in-system-terminal`）。Rename 由白板做 |
| `termSize(contentSize)` | 13px JetBrains Mono（7.8×17）加内边距 8/4 算行列数；attach 时按 xterm 实际量到的格子再校正 |
| `restore`（X6） | `describe(data, live)`：terminalId 为 null 或不在 `terminals.list()` 里时说明恢复后的样子；`restore(data, ctx)`：按 `src/restore.ts` 重开，返回新的 terminalId 等。白板的 “Restore your last session?” 用它 |

## 行为

- **显示（T2）**：`visible` 为 true 且不是摘要卡时 attach，否则 detach。attach 前 `reset()` xterm，按 FitAddon 量到的行列数 attach；`contentSize` 变了（白板保证松手后才变）才 resize，行列数没变不发。attach 在路上时大小又变了（字体刚加载完），返回后补一次 resize。看不见的终端卸掉 WebGL 插件（浏览器同时只给十几个 WebGL 上下文）。
- **tmux 那边要求的几件事**（tmux-host/AGENTS.md F7 问题 1、2、10、11）：替 xterm 回答 XTVERSION（`CSI > q`）、OSC 10/11（颜色取 tokens）、`CSI ? 996 n`；收到第一段输出之前用户输入先扣住；Shift+Enter 发 `ESC [ 13 ; 2 u`；`macOptionClickForcesSelection`、`macOptionIsMeta`（Option 当 Meta：claude / codex 的 Option+Enter 换行、shell 的 Option+b/f 要它；代价是非美式键盘上 Option 打不出特殊字符，以后可以做成设置）；OSC 52 经 clipboard 插件写系统剪贴板（不许程序读）。
- **输入（T3）**：聚焦时不带 ⌘ 的按键全部交给 xterm（Esc、⌃C、Tab、方向键、空格）；⌘C / ⌘V 不让 xterm 处理，由浏览器发 copy / paste 事件、xterm 自己接（多行粘贴按程序的 bracketed paste 模式发）；其他 ⌘ 组合冒泡给白板。从访达拖进来的文件写入带单引号的路径（当作粘贴）。
- **链接**：屏幕上的 localhost 地址和“文件:行号”画下划线（规则是 port-watch 的副本，见下）。单击 localhost → `openWindow({ type: 'browser', data: { url, mode: 'frame', openedBy: { terminalId, label } }, reuseKey: <origin> })`，label 是 “zsh · pnpm dev” 这种；单击文件 → `app.openInEditor(绝对路径, 行)`（相对路径按 `data.cwd` 拼）；OSC 8 里的其他网址 → `window.open`（组装时转系统浏览器）。
- **标题栏状态**：`status.snapshot()` 取一次，之后 `status.changed` 按 terminalId 对上，`setStatus`：Starting / Running · 4m / Needs approval · 3m（attention）/ Needs reply · 3m（attention）/ Idle · 12m / Exited / Error · exit 1，每 30 秒刷新时间。没有状态机的数据时，进程退出用 Exited / Error · exit N。`status.changed` 带 `sessionId` 且和 data 里不同时 `updateData({ sessionId })`。
- **cd 出了工作区（IS-57，MVP v3 · N7）**：只是提示。在框里的终端（`props.workspace` 不为 null）、进程还活着时，盯着 `TerminalInfo.cwd`（tmux 的 `pane_current_path`）：挂上时取一次，之后所有终端窗口共用一个 3 秒的定时器 `terminals.list()`，这个终端 `terminal.silence` 时也取；窗口看不见时不取。cwd 不在 `workspace.path` 里面时，标题栏状态带 `tag: { text: 'outside workspace', detail: 'Now in …\nWorkspace: …' }`（contracts 的 `WindowStatusBadge.tag`，window-shell 画成淡色小标签），回到里面就去掉。散放的终端、还没有状态文字时不显示。不拦、不改源代码管理面板、不锁目录。路径比较见 `src/cwd.ts`：去掉末尾 /、. 和 ..；macOS 上 `/tmp` `/var` `/etc` 当作 `/private/...`、不分大小写；拿不到 realpath，其他符号链接认不出（只会多提示，不会漏）。
- **退出（T5）**：`terminal.exit` 或 list() 里 `alive: false` → 内容保留，底部 “Process exited (code 1)”（0 时 “Process exited”）+ Restart / Close。Restart = 先 kill 旧会话，再 `agents.start({ agent, cwd, workspaceId, mode: new, size, command: startCommand })`，`updateData({ terminalId, cmd, args, sessionId })`。`command-not-found` → “Command not found: claude” + Open Settings（发冒泡的 `agentdeck:open-settings` 事件）/ Use Shell instead（`agents.start({ agent: 'shell' })`，data 改成 shell）。
- **重开应用（T6）**：按保存的 terminalId 在 `terminals.list()` 里找（同一时刻多个窗口合成一次调用；合并的结果里没有时再直接问一次，免得连着新建、Restore all 换上新 id 时拿到旧列表，IS-07）。找到就接回；没有（或 terminalId 为 null）→ “Previous session ended”，`terminal.host-lost` → “Session ended”。下面一行灰字写 Restore 会怎样，按钮 Restore（主按钮）+ Restart（新对话 / 按原命令重跑）；Restore 和 Restart 一样时（agent 没记下会话 id、Shell 没有可填的命令）只有 Restart。
- **恢复上次会话（X6，`src/restore.ts`，需求 DR-14 / TC-14）**：
  - agent（claude、codex、pi、omp、kimi）：有 `sessionId` 就 `agents.start({ mode: { kind: 'resume', sessionId } })`，命令由各自的适配器拼（claude `--resume <id>`、codex `resume <id>`、pi `--session <id>`、omp `--resume <id>`、kimi `-S <id>`）；没有会话 id 就新开，Restore 时标题栏状态后面挂 60 秒的 “new conversation” 标签（Restore all 时由白板的提示说）。适配器报 `unsupported`（不能接回）时退回新对话。
  - Shell：`agents.start({ agent: 'shell', mode: new, prefill })`，不带 command，在原目录（`data.cwd`）开交互的 shell，把 `lastCommand`（没有就 `startCommand`）填进输入行、不运行（tmux-host 等提示符画出来再 `send-keys -l`，去掉换行）。自定义命令（custom）也这样恢复：变成 Shell（`agent: 'shell'`，`startCommand` 记那条命令），命令填好、不直接再跑。
  - 窗口 id 和位置不变，终端换新 id。
  - **记下 Shell 上次跑的命令**：`agent === 'shell'`、进程活着时（看不见也盯，电脑随时可能重启），`watchTerminalInfo` 读 `TerminalInfo.foregroundCommand`（tmux-host 用 ps 看前台进程组，见 tmux-host/AGENTS.md），有值且和 `lastCommand` 不同就 `updateData({ lastCommand })`；回到提示符（null）时保留上一次的。共用 3 秒的定时器，`terminal.silence` 时、用户输入 1.5 秒后也取，所以跑了 1.5 秒以上的命令（dev server、测试）记得到，`ls` 这种记不到。agent 窗口不记。
- **摘要卡（T8）**：`summary` 为 true 时不 attach、不改行列数，显示 `lastLines(id, 3)`；有 activity / silence / exit 时最多每秒重读一次。在等你时最后一行用 attention 色。恢复原大小由白板做（单击摘要卡）。
- **命令（onCommand）**：`clear` → xterm `clear()` + `sendKeys(['C-l'])`（tmux 历史清不掉，见 CONTRACT_NOTES.md 第 2 条）；`restart`（新对话）；`restart-resume`（带原来的会话 id 重启，对话接着、启动参数换成最新的；没有会话 id 时同 restart）；`open-in-system-terminal` → `app.openInSystemTerminal`。

## 目录

| 路径 | 内容 |
| --- | --- |
| `src/definition.ts` | `terminalWindowType` |
| `src/TerminalWindow.tsx` | 组件：状态（checking / live / starting / ended / not-found / failed）、退出条、提示页、摘要卡 |
| `src/session.ts` | `TerminalSession`：xterm、插件、attach / detach / resize、输入扣留、按键、链接。不依赖 React |
| `src/router.ts` | 终端输出按 viewId 分发（早到的先缓存）；`list()` 合并调用；`watchTerminalInfo` / `watchTerminalCwd`（共用定时器盯当前目录、正在跑的命令） |
| `src/restore.ts` | X6：`needsRestore`、`planRestore`（每种终端怎么恢复）、`refillCommand`、`restoreTerminal` |
| `src/cwd.ts` | 纯函数：路径规范、`isPathInside`、`outsideWorkspaceTag`（IS-57） |
| `src/queries.ts` `keys.ts` `links.ts` `status.ts` `theme.ts` `metrics.ts` `title.ts` | 纯函数 |
| `test/` | jsdom + `createFakeApi()`；xterm 用 `@xterm/headless` 垫（`test/setup.ts`） |
| `dev/` | dev 页面（假 api；`?real=1` 接 tmux-host 的 dev bridge） |

## 和 port-watch 的约定

`src/links.ts` 是 `packages/port-watch/src/links.ts` 的副本，`test/link-cases.json` 是 port-watch 那份的副本（界面包不能 import 服务包，也不能用 fs 读）。port-watch 的测试检查两份 json 一样。改规则时两边一起改。

## 不许碰

只改 `packages/ui/widgets/terminal/`。依赖只有 contracts、design-tokens、ui-kit、`@agentdeck/ui-canvas/registry` 和 xterm；服务只走 `window.agentdeck`。组件里不写颜色值（xterm 主题从 tokens 的 CSS 变量读）。

## 怎么跑

```bash
pnpm --filter @agentdeck/ui-widget-terminal test
pnpm --filter @agentdeck/ui-widget-terminal dev            # http://localhost:5340，假数据
pnpm --filter @agentdeck/tmux-host dev:bridge              # 另开终端，然后打开 http://localhost:5340/?real=1（真 tmux，刷新 = 重开应用）
```

调试：`document.querySelector('.ad-terminal__xterm').agentdeckSession` 能拿到 `TerminalSession`（`.term` 是 xterm 实例），端到端测试可以用。

## 需要人工确认

见 `packages/tmux-host/AGENTS.md`「需要人工确认」，第 1、2、5 步是这个包的。
