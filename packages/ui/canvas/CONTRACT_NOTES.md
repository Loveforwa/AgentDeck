# 对 contracts 0.1.2 的意见（线 2 白板）

没有改 `packages/contracts`。下面是做白板时发现接口不够用或说得不清的地方，交给集成负责人决定；每条都写了白板现在的临时做法。都是“只加不改”。

## 需要加东西

### 1. 窗口类型没法声明“不能换框”“关闭前确认”“默认标题”
- 白板现在按 `type === 'terminal'` 和 `TerminalWindowData` 的形状判断：终端不能换框（W5）、运行中的终端关闭前确认并 `terminals.kill`、标题栏显示 `data.agent`（Shell 显示命令名）、按 `data.terminalId` 对状态。网页按 `type === 'browser'` 显示主机名。
- 以后加一种窗口（比如日志、编辑器）就得改白板，违背“加一种窗口 = 一个文件夹 + 一行注册”。
- 建议在 `WindowTypeDefinition` 上加可选字段：
  - `pinnedToWorkspace?: boolean`（创建后不能换框）；
  - `title?(data: TData): string`（标题栏等宽的名字）；
  - `closeConfirm?(data: TData): { title: string; body: string; confirm: string } | null` 和 `onClose?(data: TData): Promise<void>`（关闭前确认、关闭时做的事，例如 kill）。
- 影响：线 1、线 5（注册时填）、线 2（读）。

### 2. 窗口拿不到白板发的命令（⌘K 清屏、右键菜单里的 Clear / Restart）
- `WindowComponentProps` 只有窗口往白板的方向（updateData、setStatus……），没有白板往窗口的方向。
- 白板现在往聚焦窗口的 `.ad-window-content` 上发 DOM 事件 `agentdeck:window-command`（`detail: { command: 'clear' }`），线 1 要自己监听。
- 建议加：`WindowComponentProps.onCommand(listener: (command: WindowCommand) => void): Unsubscribe`，`type WindowCommand = 'clear' | 'restart' | (string & {})`；
  再在 `WindowTypeDefinition` 加 `menu?: { id: string; label: string; shortcut?: string }[]`，让窗口给自己的标题栏右键菜单加项（需求里终端的 Rename / Clear / Restart / Open in system terminal），选中时走同一个 `onCommand`。
- 影响：线 1（终端菜单、⌘K）、线 5（网页的 ⌘L ⌘[ ⌘] ⌘R 也可以走这里）。

### 3. `WindowNode` 没有 reuseKey
- `OpenWindowRequest.reuseKey` 说“同 key 的窗口已经开着时聚焦它”，但 key 没地方存，白板只能记在内存里，重启后同一个 localhost 再点会新开一个。
- 建议加：`WindowNode.reuseKey?: string | null`，随白板保存。
- 影响：线 2、线 5、store（只是多存一个字段，整份 JSON 存的话不用改）。

### 4. 拿不到用户主目录
- 散放的终端要在 `~` 运行（需求「1 · 整体布局」），`StartAgentRequest.cwd` 要求绝对路径（`AbsPath`），界面没有接口取主目录。
- 白板现在用 `Workbench` 的 `homeDir` 选项，不给就传 `'~'`。
- 建议二选一：加 `AppService.homeDir(): Promise<AbsPath>`；或者在 `StartAgentRequest.cwd` 的注释里写明 `'~'` 和 `'~/…'` 由 agent-adapters / tmux-host 展开。
- 影响：组装、线 4（或线 1）。

## 需要说清楚

### 5. 放大和“拉小成摘要卡”共用 `restoreRect`
- `WindowNode.restoreRect` 注释是“放大前的位置”。需求还要求摘要卡单击后“恢复到拉小之前的大小”，白板也用 `restoreRect` 记拉小前的大小，然后按“当前尺寸是不是摘要尺寸”区分是放大还是拉小。两种不会同时出现，能用，但字段含义变宽了。
- 建议：注释改成“放大前、或拉小成摘要卡前的位置”；或者另加 `WindowNode.maximized?: boolean`。

### 6. 终端的行列数谁来估
- `StartAgentRequest.size` 让新建时就按窗口大小起 TUI。白板知道窗口像素大小，但字体和内边距是线 1 定的。白板现在按 13px 等宽字体（7.8×17）粗估，attach 后线 1 再 resize。
- 建议：`WindowTypeDefinition` 上加可选的 `termSize?(contentSize: Size): TermSize`，或者在 contracts 里写明“白板粗估，终端窗口 attach 时校正”。

### 7. 快捷键在网页窗口里收不到
- 焦点在网页窗口的 iframe / webview 里时，按键事件到不了白板的 window 监听。需求的 ⌘J ⌘W ⌘B 等要全局可用。
- 建议组装时把这些快捷键也注册成 Electron 应用菜单的 accelerator，回调 `BoardController.runShortcut(id)`（canvas 已导出 `ShortcutId`、`SHORTCUT_LABELS`）。不需要改 contracts，记在这里给第 3 波。
