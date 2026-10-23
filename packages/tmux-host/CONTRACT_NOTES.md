# 对 contracts 0.1.3 的意见（线 1 终端）

没有改 `packages/contracts`。下面是做 tmux-host、port-watch、终端窗口时发现接口不够用或说得不清的地方，交给集成负责人决定；每条都写了现在的临时做法。都是“只加不改”。

## 需要加东西

### 1. 关闭确认拿不到“进程还活着吗”
- `WindowTypeDefinition.closeConfirm(data)` 只有 `TerminalWindowData`，判断不了进程是否已经退出（需求：只有运行中的终端关闭前要确认）。
- 现在：有 `terminalId` 就返回确认文案（“Close claude?” / “claude will be stopped. This can’t be undone.” / “Stop and close”）。白板现在按 `status.changed` 自己判断已退出的直接关，所以实际效果对，但窗口类型自己说不清。
- 建议二选一：`closeConfirm(data, ctx: { status: TerminalStatus | null })`；或者窗口组件在运行中通过 props 声明 `setCloseGuard(confirm | null)`。
- 影响：线 1、线 2。

### 2. 没有“清屏并清掉历史”的接口
- ⌘K / Clear 要清掉终端画面和回滚历史。历史在 tmux 里，界面的 xterm 清不到（xterm 本身没有回滚：tmux 用外层的备用屏）。
- 现在：xterm `clear()`，再 `sendKeys(id, ['C-l'])` 让程序自己清屏重画；tmux 的历史还在（往上滚还能看到）。
- 建议：`TerminalHost.clear(id): Promise<void>`，实现是 `send-keys -R -t =<id>: \; clear-history -t =<id>:`（再按需发 C-l）。
- 影响：线 1（tmux-host 加方法、终端窗口改调用）。

### 3. 打开设置的入口
- “Command not found: claude” 的 “Open Settings” 要打开 Settings › Agents，contracts 里没有这个能力（`AppService` 没有 `openSettings`，`WindowComponentProps` 也没有）。
- 现在：按钮在自己元素上发冒泡的 DOM 事件 `agentdeck:open-settings`（`detail: { section: 'agents', agent }`），常量 `OPEN_SETTINGS_EVENT` 从 `@agentdeck/ui-widget-terminal` 导出，组装时由应用壳监听（白板 `Workbench` 已经有 `onOpenSettings`）。
- 建议：`WindowComponentProps.openSettings?(section: string)`，或 `AppEvent` 里加界面内部事件。
- 影响：线 1、线 2、组装。

### 4. 拖进来的文件拿不到路径
- Electron 32 起拖进来的 `File` 没有 `path`，要 preload 用 `webUtils.getPathForFile(file)` 换。
- 现在：终端窗口依次试 `window.agentdeckFiles?.pathFor(file)`（约定的 preload 小接口）、`file.path`、`text/uri-list` 里的 `file://` 地址。
- 建议：`AgentDeckApi` 加 `pathForFile(file: File): string`（preload 实现，同步）。网页窗口拖入 .html 也要用（需求「3 · 白板」）。
- 影响：组装（preload）、线 1、线 2。

### 5. 打开外部网址
- 需求：“其他网址用系统浏览器打开”（OSC 8 超链接里不是 localhost 的地址）。contracts 没有 `openExternal`。
- 现在：`window.open(url, '_blank', 'noopener')`，要组装时在主进程的 `setWindowOpenHandler` 里转 `shell.openExternal` 并拒绝新窗口。
- 建议：`AppService.openExternal(url): Promise<void>`（只允许 http/https/mailto）。网页窗口的 “Open in browser” 也能用。
- 影响：组装、线 1、线 5。

### 6. 窗口不能自己改名
- 需求里终端的标题栏菜单有 Rename，但改的是 `WindowNode.title`，窗口组件改不了。
- 现在：`terminalWindowType.menu` 只有 Clear / Restart / Open in system terminal，Rename 由白板自己的菜单项做（BoardMenu 已经有）。
- 建议：不用改；在 `WindowTypeDefinition.menu` 的注释里写明“Rename、Close、Maximize 由白板提供，窗口不要重复加”。

### 7. 终端调色板
- tokens 里只有界面颜色，没有终端的 16 色。xterm 默认调色板是给深色底设计的：浅色主题下“白色”文字几乎看不见，深色主题下蓝色很暗（pnpm dev 打印的地址几乎看不清，dev 页面截图里能看到）。
- 现在：背景、前景、光标、选区用 tokens 的 `--surface` `--ink` `--hover`，16 色用 xterm 默认。
- 建议：design-tokens 加 `terminal: { light: { black…brightWhite }, dark: {…} }` 并生成 CSS 变量（如 `--term-blue`），终端窗口读它们。不是 contracts 的事，记在这里给 F4 / 组装。

## 需要说清楚

### 8. `TerminalHost` 在 utilityProcess 里时，data 怎么回到发起 attach 的窗口
- `ipc.ts` 的线路约定 3 说 utilityProcess 直接往窗口的 MessagePort 写，但 `attach()` 本身不知道是哪个窗口调的。
- 现在：`startTmuxHost({ onData })` 把所有输出交给一个回调，组装在转 invoke 时记下 viewId → 窗口（见 AGENTS.md「给组装」第 1、2 条）。窗口刷新或关掉时要 detach 它的所有 viewId。
- 建议：在 `ipc.ts` 注释里写明“attach 的返回值经主进程时登记 viewId 属于哪个窗口”，以及“窗口关闭时 detach 它的 view”。

### 9. `terminal.silence` 的定义
- 注释写的是“一段时间没有输出”。为了状态机的兜底规则（用户按 Esc 后程序什么都不输出），tmux-host 在输入后也重新计时：最后一次输出或输入之后 3 秒发 silence，前提是这之间有过输出或输入。
- 建议：注释改成“最后一次输出或输入之后 3 秒没有新输出”。

### 10. `terminal.activity` 发多频繁
- 现在：一段连续输出只发一次（和假实现一样），silence 之后再有输出才再发。状态机用得上的也只有这个。
- 建议：注释里写明“每段连续输出发一次，不是每次输出”。

### 11. `recentLinks` 和 `terminal.link` 的去重
- 现在：同一个终端里同一个链接只发一次 `terminal.link`；再出现时只在 `recentLinks` 里挪到最前。重开应用后第一次 `recentLinks` 会从 tmux 历史补找，但不发事件。
- 建议：写进注释。

### 12. 命令找不到在哪一步报
- `CreateTerminalRequest.cmd` 找不到时，tmux-host 在 create 里就按合并后的 PATH 检查并抛 `command-not-found`（不进 tmux）。agent-adapters 的 `AgentService.start` 也会先检查一次。
- 建议：在 `TerminalHost.create` 注释里写明会抛 `command-not-found`、`invalid-argument`（id 不合法或已存在、目录不存在）。

### 13. Approve all 的按键
- `AgentAdapter.approveOnceKeys` 注释里的例子是 claude `['Enter']`。实测 `Enter` 和 `1` 都是“允许一次”，但 `Enter` 取决于高亮在哪一项；建议例子改成 `['1']`，适配器同步改（见 tmux-host/AGENTS.md「Approve all 的按键核对」）。
