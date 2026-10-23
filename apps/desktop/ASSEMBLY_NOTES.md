# 组装（第 3 波）时发现的问题

第一次把各包接进真的 Electron 窗口（2026-10-23，Electron 45、tmux 3.6a、claude 2.1.291、codex 0.164.0，macOS）。
能在 apps/desktop 里绕过的已经绕过，这里记的是要别的包（或 contracts）改的地方，每条写了哪个包、怎么复现、现在怎么绕的。

## 要改别的包

### 1. tmux-host：顶层 `const require` 和 electron-vite 的 shim 撞名（会让终端进程起不来）
- 包：`packages/tmux-host/src/pty.ts`。
- 复现：去掉 `apps/desktop/electron.vite.config.ts` 里的 `renameLocalRequire` 插件，`pnpm dev`：
  终端 utilityProcess 启动即退出，`SyntaxError: Identifier 'require' has already been declared`（`out/main/chunks/tmux-host-*.js`）。
  原因：electron-vite 给用到 `require(` 的 ESM 产物顶部插 `const require = createRequire(import.meta.url)`（vite:esm-shim），pty.ts 自己也声明了一个。
- 现在：apps/desktop 的构建配置在打包前把这种模块自己的 `require` 改名。
- 建议：pty.ts 改成 `const nodeRequire = createRequire(import.meta.url)`，然后删掉那个插件。

### 2. tmux-host：`DEFAULT_TMUX_CONF` 打包后指错地方
- 包：`packages/tmux-host/src/host.ts`（`new URL('../tmux.conf', import.meta.url)`）。
- 复现：不传 `configPath`，打进 `out/main/chunks/` 后它指向 `apps/desktop/out/main/tmux.conf`（不存在），tmux 启动报找不到配置。
- 现在：组装总是传 `configPath`（开发时是仓库里的 `packages/tmux-host/tmux.conf`，打包后是 `resources/tmux.conf`）。AGENTS.md「给组装」第 4 条已经说了，只是默认值在任何打包形式下都不对，建议去掉默认值改成必填。

### 3. workspace-service：worktree 位置只能靠 `homeDir` 间接改
- 包：`packages/workspace-service`（`project-service.ts` 里 `join(homeDir, '.agentdeck', 'worktrees', …)`）。
- 问题：dev 数据目录（`.agentdeck-dev/`）下没法让新项目的 worktree 默认放进数据目录，只能把 `homeDir` 设成一个假的家目录。
- 现在：数据目录不是 `<home>/.agentdeck` 时传 `homeDir: <数据目录>/home`，worktree 落在 `<数据目录>/home/.agentdeck/worktrees/<项目>/`。
- 建议：`WorkspaceServiceDeps` 加 `worktreesDir?: string`（默认 `<home>/.agentdeck/worktrees`）。

### 4. canvas：白板“加载完”没法从外面等
- 包：`packages/ui/canvas`（`BoardController.start()`）。
- 问题：`start()` 第二次调用直接返回已完成的 Promise（`if (this.started) return;`），不等 `board.load` 完成。组装要在白板恢复后跑演示、报“白板好了”，
  如果 `Workbench` 的 effect 先调了 `start()`，外面再调拿到的 Promise 不代表已加载。
- 现在：控制器在 React 之外建好并先 `start()`，把这个 Promise 留着，再交给 `Workbench`（`controller` prop）。
- 建议：`start()` 返回同一个 Promise（记下来），或加 `controller.ready`。

### 5. canvas：New terminal ▸ 列出 “custom”
- 包：`packages/ui/canvas/src/react/BoardMenu.tsx`（`terminalItems`）。
- 复现：右键白板 → New terminal ▸，菜单里有 `claude`、`codex`、`custom`、Shell。选 custom 会以没有命令的方式调 `agents.start({ agent: 'custom' })`，失败。
  另外菜单项用的是 `a.id`（`claude`），不是适配器的 `label`（`Claude Code`）——如果是有意的（等宽的 agent 名），可以忽略这半条。
- 现在：apps/desktop 的 `agents.list()` / `refresh()` 把 custom 过滤掉了（界面暂时没有“输入自定义命令”的入口）。
- 建议：菜单不列 custom，或者选它时先弹一个输入命令的对话框；之后 apps/desktop 去掉过滤。

### 6. agent-adapters：claude 启动时的“信任这个文件夹”提示显示成 Idle
- 包：`packages/agent-adapters`（状态机）。
- 复现：`AGENTDECK_DEMO=1 pnpm dev`，在一个 claude 没信任过的目录里开 claude：屏幕上是 “Quick safety check: Is this a project you created…”，等用户选，
  标题栏却是 “Idle · now”（有钩子的 agent：有输出 → running，3 秒没输出 → idle，第 14 行）。这时还没有 SessionStart，钩子都不来。
- 建议：有钩子的 agent 在收到 session-start 之前不要因为 silence 变 idle（留在 starting，或者算 needs-reply）；或者 claude 适配器在启动前检查信任状态。
  没有改：试的时候没有替用户点“信任”（会写进 `~/.claude.json`）。

### 7. scm-panel：什么都没聚焦时写 “This window isn’t in a workspace.”
- 包：`packages/ui/panels/scm`。
- 复现：启动后不点任何窗口（或点白板空白处），右侧面板显示 “This window isn’t in a workspace.”，但这时根本没有聚焦的窗口。
- 建议：`workspaceId` 为 null 时区分“散放窗口”和“没有聚焦”（加一个 prop，或者文案改成 “Select a window or a workspace.”）。组装能传的只有 workspaceId。

### 8. 重开应用后状态时间从“现在”算
- 包：contracts / agent-adapters（`StatusMachine.track` 没有 `since`）。
- 现象：⌘Q 再打开，接回的终端都是 “Idle · now”，看不出它实际空闲了多久；store 的 `terminals` 表有 `updated_at`，但 track 不收时间。
- 建议：`TrackOptions.since?: IsoTime`。不急。

### 9. 终端窗口：紧接着新建的终端显示 “Previous session ended”
- 包：`packages/ui/widgets/terminal/src/router.ts`（`listTerminals` 把 500ms 内的 `terminals.list()` 合成一次）。
- 复现：500ms 内连着建两个终端（演示模式里先 Shell 再 claude，不加间隔）。第二个窗口拿到的是第一个窗口发起、还不含自己的列表，
  于是显示 “Previous session ended” + Restart，而 tmux 里 claude 其实在跑（`tmux -L agentdeck-desktop-dev ls` 能看到）。重开应用后又正常。
  手动连按两次 ⌘N、或者新建工作区时 setup 的 Shell 和随后开的 agent 都可能碰上。
- 现在：演示模式在两个终端之间等 700ms。
- 建议：缓存的列表里找不到时再单独查一次（或者只合并“启动时恢复”的那一批，新建的窗口不走缓存）。

## 接口不够用（contracts，没改）

- **设置存哪里**：store 还没有 settings 表（store/CONTRACT_NOTES.md 第 1 条）。现在是数据目录里的 `settings.json`（`src/main/settings.ts`）。也还没有设置界面：顶栏 Settings、菜单 Settings…、终端里的 Open Settings 都是用系统默认程序打开 `settings.json`。
- **拖进来的文件路径**：preload 暴露了 `window.agentdeckFiles.pathFor(file)`（终端窗口已经按这个名字找，tmux-host/CONTRACT_NOTES.md 第 4 条），不在 contracts 里。
- **外部网址**：`setWindowOpenHandler` 把 http(s) 交给 `shell.openExternal` 并拒绝新窗口（tmux-host/CONTRACT_NOTES.md 第 5 条）；contracts 里仍没有 `openExternal`。
- **应用壳自己的 IPC**：启动信息（登录 shell 环境读失败、tmux 不可用、演示 / 截图模式）、菜单快捷键、退出前存白板，走 `src/shared/desktop-bridge.ts` 里的几条通道（`window.agentdeckDesktop`），不进 contracts。
- **角标两个来源**：白板自己调 `app.setBadge(n)`（含网页窗口报的 attention），状态机也算一份（`badgeCount`）。现在主进程取两者较大值，前台时为 0（`src/main/alerts.ts`）。建议 contracts 写明 `setBadge` 由谁调。

## 没试到 / 只部分试到

- 真键盘按 ⌘ 快捷键时焦点在网页 iframe 里：只用主进程调菜单项 `click()` 验证了“菜单 → 界面 → runShortcut”这条路（⌘B、⌘W 都对）；系统把真实按键交给菜单这一步没法在后台验证（没有拿到控制 Electron 窗口的权限）。白板页面里按快捷键时白板先处理，界面里按时间去重，防止菜单再执行一次。
- claude 的钩子全流程：claude 停在“信任这个文件夹”，没替用户确认，所以没有真的 SessionStart / Stop。用 `.agentdeck-dev/bin/agentdeck-notify` 手动发 PermissionRequest / Stop 验证了 钩子 socket → 状态机 → 标题栏 “Needs approval”（橙色）、顶栏 “1 waiting”、程序坞角标 1 → Stop 后回到 Idle、角标清掉。
- Open in editor、Open in system terminal、Settings（打开 settings.json）、系统通知的点击：会在用户桌面上开别的程序，没点。
- 单击被别的工作区占用的分支跳到那个框：只有一个工作区（建 worktree 会在仓库里新建分支），没试；`onGoToWorkspace` 接的是 `selectFrame` + `fitFrame`。
- codex：只确认检测到了（0.164.0），没开。
- 打包（electron-builder、asar.unpacked、签名）：不在这次范围。
