# @agentdeck/board-nav-panel

右侧面板在什么都没选中时（没有聚焦的窗口、没有选中的框）显示的快速定位列表（MVP v2 · V5，IS-56，TC-33）。需求见设计画布「11 · V5」。

界面包：只依赖 contracts、design-tokens 和 React。白板数据由组装方（apps/desktop）用普通 props 传进来；对话主题自己从 `window.agentdeck.terminals.list()` 取。不 import 白板（ui/canvas）的内部，也不 import 别的面板。

## 用法

```tsx
import { BoardNav } from '@agentdeck/board-nav-panel';

<BoardNav
  projects={s.projects}       // 白板状态里的这几项，原样传
  workspaces={s.workspaces}
  frames={s.frames}
  windows={s.windows}
  statuses={s.statuses}       // 按 terminalId
  badges={s.badges}           // 按 windowId
  onJump={(id) => controller.jumpAndFlash(id)} // 和 ⌘J 一样：平移、闪一下、聚焦
  // api={...}                 // 默认 window.agentdeck（只用 terminals.list 和 on）；测试传假实现
  // refreshMs={3000}          // 对话主题多久刷新一次
/>
```

聚焦窗口后由组装方换回源代码管理面板（apps/desktop 的 `SidePanel`）。

## 有什么

- 顶部 “BOARD”。下面：项目名（粗体）→ 工作区（分支名，等宽、灰；plain 项目没有分支时写工作区名）→ 窗口。
- 顺序按位置：框从上到下、同一行从左到右，框里的窗口也一样（和 ⌘⇧] 一样）；项目按项目列表的顺序。
- 窗口一行：状态灯（V2 那套：绿 running、黄 waiting、红 error、空心灰 idle 和 starting、灰线 exited；没有状态的网页窗口画一个小窗口图标）、名字（改过名用改的名，否则 agent 名 / 命令名 / 网页的 host；终端用等宽字）、在等你时 “· Waiting”（悬停看 Needs approval / Needs reply）、终端的对话主题 “· Check local git history”（灰）。
- 在等你的行浅黄底（`--attention-soft`）。不是终端的窗口，badge 的 tone 是 attention 也算在等你（和 attention.ts 一致）。
- 没有框的项目写 “no workspaces”；框里没有窗口写 “no windows”；散放的窗口（以及工作区没有框的窗口）放在最后一组 “Not in a workspace”；白板上什么都没有时写 “Nothing on the board yet.”
- 每行是一个按钮，读屏名字是 “claude, Running, Check local git history”。

## 对话主题

`TerminalInfo.title`（程序设的终端标题）。列表显示期间：打开时取一次，之后每 3 秒取一次，收到 `status.changed` 时也取（200ms 内合成一次）；列表关掉就停。旧的结果晚到时丢掉。

## 测试

```bash
pnpm --filter @agentdeck/board-nav-panel test       # Vitest + jsdom + Testing Library，对着 createFakeApi() 的示例白板
pnpm --filter @agentdeck/board-nav-panel typecheck
```

- `test/model.test.ts`：名字、每种状态对应的灯、按位置排序、没有框的工作区。
- `test/board-nav.test.tsx`：树形列表、灯和网页图标、exited 灰线、对话主题（轮询和 status.changed 时刷新）、在等你的行浅黄底、单击调 onJump、no workspaces、散放窗口、空白板。

## 不许碰

只改本目录。颜色只用 design-tokens 的变量（`pnpm colors` 会查）。不 import 服务包、Electron、node 内置模块、ui/canvas 的内部；`tools/fakes` 只能在 `test/` 里用。
