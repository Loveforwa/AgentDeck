# @agentdeck/ui-canvas

白板（第 2 波 · 线 2）：任务 B1 B2 B3 B4 B5 W3 W5 S3 R1。需求见设计画布「1 · 整体布局」「3 · 白板」「4 · 工作区框」「5 · 终端窗口」「6 · 终端状态与提醒」「10 · 全局规则」。

白板上的窗口外框在 `@agentdeck/ui-window-shell`，顶栏在 `@agentdeck/ui-topbar`，都只管外观；这个包把它们和 React Flow、服务（`window.agentdeck`）接起来。canvas 能依赖这两个包是 `.dependency-cruiser.cjs` 的 `ui-canvas-allowed-deps` 规定的，反过来不行。

## 对外接口

### 给 widget（线 1 终端、线 5 网页）：`@agentdeck/ui-canvas/registry`

widget 只能 import 这个子路径。

```ts
import { registerWindow } from '@agentdeck/ui-canvas/registry';

registerWindow<TerminalWindowData>({
  type: 'terminal',
  label: 'Terminal',
  defaultSize: { w: 560, h: 360 },
  minSize: { w: 110, h: 60 },
  summaryBelow: { w: 320, h: 200 }, // 宽或高小于它，或白板缩到 50% 以下时，props.summary 为 true
  component: TerminalWindow, // props 是 contracts 的 WindowComponentProps<TerminalWindowData>
  create: (init) => ({ ...defaults, ...init }),
});
```

- CO3 · 窗口内容（Send selection to ▸）：`registerWindowContent(windowId, { selectionText(), paste(text, { requireBracketed?, fresh? }) })` 在窗口组件挂上时登记选中文字和粘贴的句柄（返回撤销函数，`PasteResult` 不成功时带给用户看的原因）；内容区要白板的右键菜单时从内容里的元素发冒泡的 `CONTENT_MENU_EVENT`（detail `{ clientX, clientY }`）。只在界面里，不经过服务、contracts 里没有。`createWindowContentRegistry()` 测试用，`BoardController` 的 `contents` 选项可以换。
- `registerWindow(def)` 返回撤销函数；同一个 type 再注册会替换（热更新）。`getWindowType`、`listWindowTypes`、`isSummarySize`、`createWindowRegistry`（测试用的独立注册表）。
- 白板给组件的 props 照 contracts 0.1.2 的 `WindowComponentProps`：
  - `contentSize` 是内容区（不含 28px 标题栏和边框）的像素，**改大小松手后才变**；拖动中外框在变，组件拿到的不变。
  - `visible`：窗口和视口有交集。终端据此 attach / detach。
  - `focused` 为 false 时内容上盖了一层：第一下单击只聚焦；滚轮由白板交给下面的内容（N6，见「手势」），所以组件不用自己处理“没聚焦时的滚轮”，照常听 wheel 就行（普通 DOM 收到的是白板再派发的一个 wheel，iframe / webview 收到原生的）。
  - `setStatus` 的 `tone: 'attention'` 也会算进“在等你”（不是终端的窗口用）。
  - ⌘K 时白板调用聚焦窗口的 `onCommand('clear')`（contracts 0.1.3 的 `WindowComponentProps.onCommand`，实现是 `BoardController.sendWindowCommand`）。
- 白板对 `type: 'terminal'` 有几条特别规则（不能换框、关闭前确认、按 `data.terminalId` 对状态、标题栏显示 `data.agent`），网页是 `type: 'browser'`（标题栏显示主机名、New browser 和 ⌘T 用它）。两种类型没注册时对应菜单项变灰。

### 给组装（apps/desktop，第 3 波）

```tsx
import { Workbench } from '@agentdeck/ui-canvas';
import '@agentdeck/ui-kit/base.css';

<Workbench
  api={window.agentdeck}
  homeDir={home} // 散放终端的目录；不给就传 '~'，见 CONTRACT_NOTES.md
  renderPanel={({ workspace }) => <ScmPanel workspace={workspace} />} // 右侧面板，跟随聚焦窗口或选中的框
  onOpenSettingsFile={openSettingsFile} // Settings 对话框底部的 Open settings.json；不给就没有这个按钮
/>
```

- `Workbench` = 顶栏 + 白板 + 右侧面板（宽 280–480、⌘B 开关，跟布局一起保存），外面包好 ToastProvider 和 ReactFlowProvider。
  - 面板收起（MVP v2 · V4，`BoardState.panel.open` 为 false）时是 28px 竖条：展开按钮（Expand panel）、分支图标（没有聚焦的工作区时也在，更淡，IS-67）、聚焦的工作区有未提交改动时一个黄点（竖条自己问 `git.status`、听 `git.status` 事件）。
  - `renderPanel` 的参数里有 `collapseButton`（Collapse panel 按钮）和 `collapse()`：面板内容把按钮放进自己的标题栏（源代码管理面板放在 Refresh 后面，`ScmPanel` 的 `headerActions`）。
  - `trafficLights`：macOS 的 hiddenInset 标题栏，顶栏左边给红黄绿按钮留位置（MVP v2 · V1）。
  - 拖动窗口（IS-63）：`.ad-workbench-drag` 是顶栏那么高的一条 `-webkit-app-region: drag`，DOM 里排最前、画在白板下面；窗口节点、框（含改大小把手）、面板、浮层（`.ad-popover` `.ad-dialog` `.ad-toast`）都 `no-drag`，压在这一条上时能点，空着的地方拖得动窗口。顶栏不接指针，点在它的空白处落到白板上。
- `BoardController`：白板的全部行为，不依赖 React，测试里直接用。X10 的 `undo()` / `redo()`（返回有没有做）、`history`（`BoardHistory`：`canUndo`、`canRedo`、`size`）、`setSelection` / `clearSelection` / `toggleSelected`。`Workbench` 可以传自己建的 `controller`。`runShortcut(id)` 可以接到应用菜单的快捷键上（焦点在网页窗口的 iframe 里时按键到不了白板）。
- MP1 / MP2 · 左边管理面板：`BoardState.pins`（contracts 0.1.24）在 store 里总有（老白板按空数组），随白板保存；`togglePin(pin)`（按 `boardPinKey` 去重，已置顶就取消）、`movePin(from, to)`、`isPinned(pin)`。`newMenuItems(controller)`（`react/BoardMenu.tsx`，从入口导出）给管理面板的 New 菜单：Terminal ▸、Browser、Workspace…、Add project…，和右键白板同一份，新开的放在聚焦的工作区框里并跳过去。左边栏的按钮叫 “Show sidebar” / “Hide sidebar”，外壳 `aria-label="Sidebar"`。测试 `test/pins.test.ts`。
- CO4 · ⌥⌘1–9：`ShortcutId` 多了 `jump-agent-1` … `jump-agent-9`（`matchShortcut` 按物理键 `Digit1`–`Digit9` 认，按住 ⌥ 时 key 是 ¡ ™ £；⌘1 仍是 Show all，⌥⌘0 和 ⌥⌘⇧n 不拿；2026-10-28 核对过白板、终端、网页窗口、应用菜单里没有别的 ⌥⌘ 数字绑定，只有开发时的 ⌥⌘I）。跳到哪一行由组装方给的 `BoardControllerOptions.agentOrder(state)` 决定（MP3 起是 manager-panel 的 `needsYouOrder`，和左边管理面板 NEEDS YOU 一段同一个顺序；白板不能 import 面板）；`jumpToAgentRow(n)` 和单击那一行一样跳过去、闪一下、聚焦，没有这一行不动；没给 `agentOrder` 时 `runShortcut` 返回 false。CO4 原来的 Unseen（一轮结束没聚焦就记上、聚焦清掉）2026-10-28 按用户决定去掉：状态本身（Idle）已经看得见。`TerminalWindowData.unseen` 留在 contracts 里（只加不改），白板不再写也不再读；旧白板里带着 `unseen: true` 的照常加载、原样存回，没有影响。
- `addProject` 选项可以换掉默认的 Add project… 流程（线 3 的 W1 做好后接上）。
- Settings 对话框（X12，TC-15）在白板里：`controller.openSettings({ section?: 'projects' | 'general', projectId? })`。入口：顶栏右边的齿轮、顶栏左边的项目菜单 › 项目 › Project settings…、⌘,（`ShortcutId` 的 `open-settings`，输入框里也生效；应用菜单的 Settings… 发这个快捷键）。组装方把终端窗口的 `agentdeck:open-settings` 事件接到 `openSettings`。
  - 没给 `projectId` 时（齿轮、⌘,、应用菜单）停在当前项目上（IS-71）：选中的框或聚焦窗口所在工作区的项目，和右侧面板跟随的是同一个（`activeWorkspaceId`）；什么都没聚焦、没选中，或聚焦的是散放窗口时，停在列表第一个项目上。
  - 左边项目列表 + General。项目页：Name、Path（只读，找不到时 Locate… → `projects.locate`）、每个仓库的 Base branch（选项来自 `git.branches`）、Worktree location（Browse… 用 `app.pickFolder`）、Files to copy（一行一个）、Setup command。General：closeWindow、notifications、defaultAgent、editorCommand、terminalApp。
  - 各页改的是草稿（`src/model/settings.ts`），换页不丢；Save 把所有改过的页一起保存，只发改了的字段（`projects.update` / `app.updateSettings`），都成功才关；失败用 Toast 提示、对话框不关。Agents、Approvals 页以后再加。

## 目录

| 路径 | 内容 |
| --- | --- |
| `src/registry.ts` | 窗口注册表（唯一对别的界面包开放的文件） |
| `src/controller.ts` | `BoardController`：启动和事件、拖动、改大小、放大、新建、关闭、工作区、视口、快捷键 |
| `src/store.ts` | zustand vanilla store：保存的部分（BoardState）+ 临时状态 |
| `src/model/` | 纯函数：`history`（X10 撤销：`diffLayout`、`applyStep`、`BoardHistory`）、`selection`（X10 多选：`boxFrom`、`windowsInBox`、`toggleSelection`、`byWorkspace`）、`groups`（N1 窗口组：`listGroups`、`dissolveGroups`；N2 侧边栏：`groupView`、`hiddenMembers`、`syncGroups` 停靠、`lampOf`、`memberName`）、`geometry`（框跟着长、框的最小尺寸、视口）、`attention`（S3 计数、⌘J ⌘⇧J 顺序、顶栏的第几个）、`navigation`（S3 ⌘⇧] ⌘⇧[ 按位置切窗口的顺序）、`autosave`（B5 防抖）、`shortcuts`（R1 按键表）、`drop`（W5 落点）、`snap`（V3 吸附和对齐线）、`avoid`（V3 松手避让、框之间 20px、挤开别的框）、`windows`（终端相关的判断）、`gestures`（N6 手势规则和 React Flow 参数）、`branch`（分支名检查）、`settings`（Settings 的草稿和补丁）、`fork`（X4：能不能 Fork、原因） |
| `src/react/` | `Workbench`、`Board`（React Flow）、`WindowNodeView`、`FrameNodeView`、`GroupSidebar`（N2 窗口组的侧边栏节点）、`Guides`（V3 对齐线，屏幕坐标画；跟踪 ⌘）、`BoardMenu`（右键菜单，含 PLUGINS 一组）、`PluginMarks`（把登记表里插件的标记放到窗口节点和框标题上）、`approvals`（第一次开 Auto-approve 的确认、Approval history、Approve all 对话框）、`dialogs`（新建 / 删除工作区、W5、停止终端、改名）、`SettingsDialog`、`useShortcuts`、`gestures`（N6：空格平移、窗口上的缩放滚轮、盖层把滚轮交给内容）、`selection`（X10：Shift + 拖空白处框选、框选的矩形） |
| `src/plugins/` | 插件（PL0，规则见 docs/plugins.md）：`types.ts`（`PluginDefinition`：能贴在 terminal / browser / frame / board 哪几种上、支持哪些 agent、能不能开和原因、开没开、开关、额外菜单项、窗口和框上的标记组件；`pluginMenuSection` 生成右键菜单的 PLUGINS 一组）、`index.ts`（登记表 `PLUGINS`，加插件就是加一行）、`auto-approve.tsx`（PL1：书签、小卡片、框标题的小标签）、`usage.tsx` + `usage-model.ts`（PL2：用量条、拖动换边、小卡片、watch / unwatch；纯函数）、`auto-resume.tsx` + `auto-resume-model.ts`（PL6：白板 / 框 / 终端三级开关、只在终端被额度停下时挂的书签、改这一次续跑话的卡片；`LimitsModel` 即 `controller.limits`，读 LimitService 的列表，框给书签留地方也看它。PL3 Prompt queue 2026-10-28 退役，代码已删）。`PluginTarget` 有 `{ kind: 'board' }`：右键白板空白处的 PLUGINS 一组 |
| `src/approvals/` | 批准在界面这边的状态（PL1、X3）：`model.ts` 的 `ApprovalsModel`（`controller.approvals`，zustand vanilla store：服务报的开关、每种 agent 能不能开、needs-you、这次运行收到的自动批准、书签闪的次数、小卡片、Approval history、Approve all 的列表；开关、把开关写进白板、终端换 terminalId 时补推）、`text.ts`（原因、谁批的、时间、在等批准的请求） |
| `src/canvas.css` | 白板、框、面板、对话框字段的样式，只用 tokens |
| `src/group-sidebar.css` | N2 侧边栏的样式（单独一个文件，少和别的线在 canvas.css 里冲突） |
| `src/selection.css` | X10 选中窗口的外圈、框选的矩形 |
| `dev/` | dev 页面（Vite） |

## 行为要点

- 手势（N6，IS-59，调研 DR-53；代码 `src/model/gestures.ts` + `src/react/gestures.ts`）：
  - 两指滚动：在任何窗口上（聚焦不聚焦、标题栏、摘要卡都一样）给窗口内容，**不平移白板**；在空白处（含框里的空白、框标题）平移白板。窗口节点都带 `nopan nowheel`（`WINDOW_NODE_CLASS`），React Flow 不管窗口上的滚轮。没聚焦的窗口盖着一层：滚轮落在盖层上时，下面是普通 DOM（终端）就照原样再派发一个 wheel 给它（xterm 的回滚和鼠标模式都是 JS 处理的，认这个事件；没人 preventDefault 时滚最近的 overflow 可滚动的祖先，合成事件不会触发原生滚动；盖层不动，第一下单击还是只聚焦）；下面是 iframe / webview 就让盖层 `COVER_PASS_MS`（600ms）不接指针，后面的滚动原生地进网页（这段时间里单击会直接点进网页）。
  - 缩放：双指捏合（`zoomOnPinch`，macOS 给 ctrlKey）和 ⌘ + 滚轮，25%–200%，以指针为不动点。空白处由 React Flow 做；窗口上由 `useWindowZoomWheel` 在捕获阶段先拿走、按 React Flow 同样的换算做（终端收不到）。焦点在网页里时，网页上的捏合进网页（事件到不了白板）。还有 ⌘0 100%，⌘1 Show all（最大 100%），⌘= ⌘−，左下角比例菜单。
  - 按住空格拖动平移（`useSpacePan`，React Flow 自带的 `panActivationKeyCode` 关掉了：它会在终端里吞掉 Shift+空格，而且窗口上拖不动）：按住时白板加 `ad-board--space-pan`，框和窗口都不接指针，拖哪里都平移，光标是手。单独的空格才算（不带修饰键、不在输入法组字中）；焦点在终端（`.xterm`）、输入框、contenteditable、按钮和链接、菜单、对话框、`.nokey` 里时空格照常给它们，网页里的按键本来到不了白板。松开空格、窗口失焦、页面隐藏时结束。
  - 左键或中键拖空白处平移（`panOnDrag={[0, 1]}`）。不响应双击缩放。
  - Shift + 左键拖空白处（含框里的空白）是框选（X10），见下面「多选和撤销」。
- 点阵 20px，缩到 50% 以下隐藏。
- 框和窗口是不可拖的 React Flow 节点，移动和改大小走 window-shell 的手势（只能拖标题栏），所以节点要显式 `pointer-events: all`。屏幕坐标换算用 store 里的视口（`controller.clientToFlow`），不用 React Flow 的 `screenToFlowPosition`（受控视口动画后它会落后）。
- 框里的窗口拖向框外：框跟着长（W3）；指针进了别的框：那个框虚线，松手时终端弹回原处并问“Open new”（W5），网页直接换框。
- Fork 对话（X4）：W5 对话框里 agent 终端多一个 Fork（悬停 “Fork conversation into <工作区>”），终端标题栏菜单在 Open in another workspace 下面有
  Fork conversation into… ▸ 别的框。都调 `forkInWorkspace(windowId, to, at)`：在目标框里照常放一个同款 agent，`agents.start` 的 mode 是
  `{ kind: 'fork', sessionId }`，原来的终端不动。能不能 Fork 看 `model/fork.ts` 的 `forkCheck`：shell、自定义命令不提供（按钮和菜单项都没有）；
  agent 不支持（kimi）、没装、还没有会话 id（codex 第一次输入前）时灰掉，原因写在菜单项后面 / 对话框里。会话 id 有了但还没说过话时由
  agents.start 报 “No conversation to fork yet…”，白板照常弹提示、不加窗口。测试：`test/fork.test.tsx`。
- 吸附和不重叠（V3，TC-31，调研见 DR-52）：
  - 拖窗口、改窗口大小、拖框时屏幕 6px 内吸附（`SNAP_PX / zoom`）：同一个框里别的窗口（散放的：视口里的散放窗口）和框的内边；边对边、中线、标准间距 20（`avoid.ts` 的 `GAP`，和框之间一样，IS-66）、等间距、照别人的间距再排一个，改大小时还有同宽同高。拖窗口时还对齐附近的框（IS-65）：视口里、离窗口所在的框不到 `NEAR_FRAME_PX`（200 屏幕像素）的别的框，只看外边和中线（`SnapOptions.alignTo`，不算间距）。改框的大小也吸（IS-65）：别的框的边、隔 `GAP`、同宽同高，还有正好装下里面窗口的位置（`fit`，线画在窗口的边上）；不吸时就会被挤开的框不当对象，吸附本身不去挤别的框（`keepApart`）。画 `--guide` 蓝色虚线，间距和尺寸标数字。按住 ⌘ 不吸。控制器的 `moveWindow` / `resizeWindow` / `moveFrame` / `resizeFrame` 带 `{ snap }`，不给就不吸（测试、程序调用）。
  - 松手时（也包括新放上来的窗口）盖住了同一个框里别的窗口：挪到离松手位置最近、隔 16 的空位，优先在框里，放不下就放到框外让框长。不推别的窗口。放大中的窗口不挪，别人按它还原后的位置避让。
  - 框之间至少 20px：拖框碰到别的框停在边上（可以沿边滑，不会穿过去）；框变大（窗口拖到边上松手、改窗口大小、拖框边、新窗口）挤到别的框，别的框连同窗口往外挪，拖动中拉回来它也回去。原来就挨得近但没重叠的框不动。
  - IS-54：指针还在自己的框（拖动前的位置）里就不算进了别的框；启动时老布局里重叠的框被分开。
- 新建的东西放在右键的位置；⌘N / ⌘T 放在聚焦窗口右边、同一个工作区；没有聚焦时在视口中心。新工作区没给位置时放在空的地方。
- 关闭运行中的终端要确认（Stop and close，调 `terminals.kill`）；已退出的终端和网页直接关。
- 删除工作区：Remove from board / Also delete the worktree folder；服务抛 `dirty-worktree` 后要勾“I understand these changes will be lost”再带 `force: true`。成功后结束框里的终端。
- 服务开的东西（M1，agent 通过 MCP）：`board.add-frame` 把已建好的工作区放到空位（`addFrameFromService`）；`board.open-window` 照 `openWindow` 放进框里，框不在白板上时散放（`openWindowFromService`）。都不抢键盘焦点、不动视口，`highlight` 时窗口闪一下。
- N1（MVP v3）：
  - `board.open-window` 的 `nearTerminal`（open_browser 的调用者）：那个终端的窗口和网页在同一个框里时放在它右边，被占了照 V3 挪到最近的空位。
  - `board.open-group`（open_terminals，`openGroupFromService`）：一组终端放在 lead 窗口右边，按网格排（列数 ⌈√n⌉），照常避让、框跟着长；然后记进窗口组 `WindowNode.group`（lead 的 role 为 `lead`，子终端 `member` + label），随白板保存。lead 已经在组里（它自己是子终端）时新开的加进同一个组。找不到 lead 的窗口时只开窗口、不成组。N2 起新组只显示第一个子终端，其余收起（见下面 N2）。
  - 关窗口时 `dissolveGroups`：lead 没了，子终端去掉 group 变回普通窗口；子终端都没了，lead 也去掉。`listGroups(windows)`（从包里导出）给 N2 的侧边栏用：每组的 lead 和按打开先后排的子终端。
  - `board.focus-window`（`focusFromService`）：照 ⌘J 跳过去、闪一下、聚焦；`board.notify`（`notifyFromService`）：发通知的窗口闪一下，Toast 写 “claude · agentdeck · feat/login: Tests passed”。用户 2 秒内按过键（`TYPING_MS`，`window` 上捕获阶段的 keydown，网页 iframe 里的按键收不到）时两者都只闪一下：不抢焦点、不动视口、不弹 Toast。
  - `reuseKey` 改成存在窗口上（`WindowNode.reuseKey`，随白板保存），重启后 open_browser 同一个 origin 仍然复用那个窗口（以前是控制器里的 Map，重启就丢）。
- 插件（PL0，docs/plugins.md）：右键终端标题栏、右键框（标题和框里的空白）时菜单中间有一组 PLUGINS（`{ type: 'heading' }`），直接列出能贴在它上面的插件（不套子菜单），开着打钩，再点关掉；用不了的灰掉，原因写在后面（`MenuItem.hint`，例如服务报的 “Not supported for kimi yet”、Usage 的 “Not supported for shell”）；`agentsOnly` 的插件（Auto-approve）在 shell、自定义命令的终端菜单里根本不列（IS-68）。网页窗口目前没有插件，不出这一组。插件的标记由插件自己画：`WindowMark` 放在 `.ad-window-node` 里（相对节点绝对定位，跟着移动、改大小、放大），`FrameMark` 放在框标题里。
- Auto-approve（PL1）：开关以主进程的 `ApprovalService` 为准。界面启动时取 `autoApproveState` / `autoApproveSupport` / `autoApproveNeedsYou`，之后听 `approval.auto-approve-changed` / `approval.needs-you` / `approval.auto-approved`。点开关调 `setTerminalAutoApprove`（框开着时单独关传 false、再开传 null；框关着时单独开传 true、再关传 null）或 `setAutoApprove`，收到 `approval.auto-approve-changed` 再写进白板（`FrameNode.autoApprove`、`TerminalWindowData.autoApprove`）随白板保存。重开应用由 apps/desktop 在终端接回状态机后按白板恢复一次，界面不再推；只有终端换了 terminalId（重启后新开）时界面把它单独的设置补推。第一次打开时问一句（记在 localStorage 的 `agentdeck.auto-approve.confirmed`）。
  - 书签：终端底边左侧、贴着下边框外沿（`top: 100%`），16px 高、9.5px 半粗体，红底白字（`--plugin-auto-approve` / `-fg`），不挡内容；服务报 needs-you 且终端还在等时变橙 “Needs you”（`--attention`），悬停写原因（Destructive command / Question for you / Couldn’t approve / Not supported）和请求；每次 `approval.auto-approved` 闪一下；单击弹小卡片：Auto-approve、since HH:MM、最近几条批准、Approval history…、Turn off。框上开着时框标题里一个红色小标签 “Auto-approve”。
  - 只有 agent 终端有 Auto-approve（IS-68）：`ApprovalsModel.canAutoApprove`（agent 终端、服务的 support 不是 unsupported；没取到时按 claude、codex、omp、pi）是唯一的判断，`windowOn` / `since` / `needsYouOf` 都先过它。框上开着只管框里能自动批准的 agent：shell、自定义命令、kimi 不打钩、不挂书签（包括 Needs you），哪怕服务按框记的开关把它们算进去。
  - Approval history：右键框 › Approval history…（这个工作区），或小卡片里（这个终端）。服务的 `history(workspaceId)` 加上这次运行收到的事件，新的在前：时间、终端、请求、谁批的（You / Approve all / Auto-approve）。散放的终端只有这次运行的记录。
- Usage（PL2）：右键终端 › PLUGINS › Usage（claude、codex、pi、omp、kimi；shell 灰掉）。开关和位置写进 `TerminalWindowData.usage`。开着时 `.ad-window-node` 里画一条 `.ad-usage-strip`（`--plugin-strip-height` 24px、圆角、`--surface` 底、`--shadow-mark`），左右贴齐窗口、隔 `--plugin-strip-gap` 6px，在上边或下边；内容：点阵把手、in、out、cache 读 / 写（agent 不报写时只写读）、右边 ctx + 进度条 + 百分比，percent ≥ 85 时 `--attention`；数字照各 agent 自己界面的写法（IS-69，`usage-model.ts` 的 `AGENT_FORMATS`：claude 52.5k / 1m、5%，codex 27.8K / 475K、97% left，pi 52k / 1.0M、5.2%，omp 52K / 1M、5.2%，kimi 68.8k / 977k、8%；进度条都按用了多少）；state 不是 ok 写 “No usage data”，悬停写原因；悬停写准确数、模型名，推断出来的会话写明。拖把手：条跟着指针上下走、蓝边，`--guide` 落点线标出松手后贴到哪边（看指针在窗口上半还是下半），松手写进位置；不会离开这个终端。单击条弹小卡片：模型、window、last request、requests，codex 的 5h / Weekly limit（照 codex /status 写 “99% left (resets 14:05)”：used_percent 先四舍五入再 100 − used，同一天只写时间、不是同一天加 “on 27 Oct”，12 / 24 小时制看系统），Move to bottom / top，Hide（关掉插件）。条画着时 `usage.watch` + 听 `usage.changed`，卸下时 `unwatch`。放大窗口时 `toggleMaximize` 按 `usageOutset` 给条留出位置。
- Approve all（X3，不设快捷键）：有请求在等“允许一次”时顶栏出现 “Approve all…”，单击弹出 “Approve these requests?” 列表（agent · 项目 · 分支、要运行的命令；看起来有破坏性的默认不勾，写 “Unchecked: this looks destructive.”；提问不在列表里，底下说一句）。“Approve n” 调 `approve(ids, { by: 'approve-all', includeDestructive })`（勾了破坏性的才传 true）；批成的去掉，没批成的（couldnt-approve 等）那一行写 “Couldn’t approve”、不勾、留给你，全批成了就关掉并提示 “Approved 1 request · 2 still need you”。
- N2（MVP v3，形态 A）窗口组的侧边栏（`src/react/GroupSidebar.tsx`，`src/model/groups.ts`）：
  - lead 窗口右边隔 8px 一列（宽 168，和 lead 一样高），是一个单独的 React Flow 节点，位置由 lead 算，跟着 lead 走；lead 放大中不画。标题 “3 subagents”，每个子终端一行：状态灯（和 V5 一套：绿 running、黄 waiting、红 error、空心 idle、短线 exited）+ “sub-2 · ui”（第几个 · open_terminals 的 label）；在等你的行 `--attention-soft` 底，选中的行加粗。底下 Show all、Collapse group。标题栏的灰字：lead 是 “lead”，子终端是 “sub-2 · ui”（没改名时）。
  - 显示方式存在 lead 的 `group.view`（contracts 0.1.7 加的可选字段，随白板保存）：`one`（只显示 shown，贴在侧边栏右边 = 停靠处，其余收起）、`all`（Show all：普通窗口，在侧边栏右边按网格排，盖住别人时挪到最近的空位，框跟着长）、`collapsed`（只剩侧边栏）。没有 view 的（N1 存下的组）按 `all`。新组默认 `one`，显示第一个子终端；已有的组再加子终端照它现在的方式。
  - 收起的子终端不渲染（终端 detach，进程在 tmux 里照常跑），仍算进顶栏和框标题的 waiting、⌘J 顺序；`jumpToWindow` 跳到收起的子终端（⌘J、通知、快速定位、focus_window）时先把它显示出来（`showGroupMember`）。收起的停在停靠处。
  - 停靠：控制器的 `set` 每次 windows 变了跑 `syncGroups`：收起的、和 lead 同框的子终端停在停靠处；显示的那个原来停靠着、这次没被别的操作挪过，就跟着 lead 到新的停靠处（拖 lead、改 lead 大小、拉回摘要卡）；用户把它拖走了就不再跟着。显示的子终端被关掉时换成它后面那个。和 lead 不在同一个框的子终端只收起 / 显示，不挪。
  - 避让：找空位时（V3）lead 连同侧边栏和停靠的子终端算一块（`withGroup`），收起的子终端不挡，别的组的侧边栏挡；框按这一块长。侧边栏 / 停靠的子终端新出现时盖住了框里别的窗口，就把那些窗口挪到最近的空位（`settleGroup`，例外于“不推别的窗口”：是新出现的东西要地方）。
  - 关 lead：先照 Show all 平铺开，再 `dissolveGroups`，子终端都是普通窗口，侧边栏消失。
- 多选和撤销（X10，代码 `src/model/selection.ts`、`src/model/history.ts`、`src/react/selection.tsx`）：
  - 框选：**Shift + 左键**拖空白处（白板底板，或框里没有窗口的地方；框标题、改大小的边、窗口上不算），碰到一点就选上（和访达、Figma 一样）；同时按着 ⌘ 时加在原来的选择上。左键拖空白处照旧平移（N6），不改老习惯，所以框选要按 Shift。按下时取消聚焦的窗口和选中的框、DOM 焦点离开终端，之后 Esc、⌘Z 都给白板。在 `.ad-board` 的捕获阶段拿事件，React Flow 收不到这次按下（不平移），松手后的 click 不当成“点空白处”。
  - ⌘ / Shift + 单击标题栏：加进或去掉（不聚焦它）；原来什么都没选、有聚焦的别的窗口时，聚焦的也算进来。不带修饰键按在没选中的窗口上、单击（不拖）选中窗口的标题栏、单击空白处（含框里的空白）、单击框标题、Esc（没有窗口聚焦时）都取消多选。关掉的窗口从选择里去掉。
  - 选中的窗口：`.ad-window-node[data-selected]`，外框外面 2px `--guide`（和对齐线一样是“正在摆白板”的颜色，不和聚焦的墨黑边框混）；框选的矩形 1px `--guide` 边、8% 的底。
  - 一起拖动：拖任何一个选中的窗口，选中的（不含收起的子终端、放大中的）都按同一个位移走。吸附看所有选中窗口的外接矩形：对象是它们所在框里别的窗口，都在一个框里时还有框的内边，附近的框照 IS-65。**不换框、不弹 W5**：每个窗口留在自己的框里，指针进了别的框也一样（简单、不会误把一批终端弹回去），框按自己那一批长。松手时每个框里的那一批算一块（连同 lead 的侧边栏、用量条），盖住别的窗口就整块挪到最近的空位，然后各个框重新长、挤开别的框（V3）。
  - 撤销 / 重做：⌘Z / ⌘⇧Z（`ShortcutId` 的 `undo` / `redo`，应用菜单 Edit › Undo / Redo 也发这两个）。能撤销的：移动窗口（含一起拖动、拖进别的框的网页）、改窗口大小（含拉小成摘要卡、单击摘要卡恢复）、放大 / 还原、关闭窗口、拖框、改框大小（连同被挤开的框和里面的窗口）、窗口组的显示方式（侧边栏点一行、Show all、Collapse group）、改窗口名、改工作区名（再调一次 `workspaces.rename`）。不撤销进程和 git：新建终端 / 网页 / 工作区、删工作区、W5 的 Open new、服务开的窗口都不记。
  - 一次拖动（按下到松手）算一步；按实体记前后（窗口按 id、框按工作区），撤销时只改这一步动过的那几个：服务后来开的窗口不动，窗口的 data（终端重启后的 terminalId 等）用现在的。最多 100 步（`HISTORY_LIMIT`），新的一步清掉重做；只在这次运行里，重开应用就没了。拖动中按 ⌘Z 不做。这一步碰到的窗口和框都不在了（工作区删掉了）就跳过、接着撤销上一步。
  - 撤销关闭：原样放回（同一个 id、位置、框、组，放在最上层，闪一下）。终端窗口自己按 `data.terminalId` 去接：tmux 里的会话还在就接回，进程已经没了（关闭时 Stop and close 结束了它）就显示 “Previous session ended”（X6 在那里加恢复）。重做关闭时，要是撤销后点过 Restart（terminalId 变了），不替用户结束正在跑的终端：提示 “Can’t redo: the terminal was restarted. Close it instead.”，这一步留在重做栈里。
  - 焦点规则（`textUndoTarget`）：在白板上、**终端里**（xterm.js 不把 ⌘ 组合键发给 shell，终端的 keys.ts 本来就把它们交给白板，和 ⌘K ⌘W 一样；拖完窗口它就是聚焦的，不然撤销移动用不了）撤销白板；在输入框、文本框、contenteditable 里（包括窗口里面的，例如网页窗口的地址栏）、网页窗口的 iframe / webview 上、对话框开着时是文字的撤销，白板不拿。Ctrl+Z 永远是终端的（挂起）。
- 保存：保存的部分（视口、框、窗口、面板）引用一变就排进防抖，半秒后 `board.save`；`pagehide` 时立刻写。启动时 `board.load` 恢复。
- 恢复上次会话（X6，TC-14，`src/model/restore.ts`、`controller.checkRestore` / `restoreAll`、`dialogs.tsx` 的 RestoreSessionDialog）：白板画出来后、以及收到 `terminal.host-lost` 时，`terminals.list()` 一次，对每个窗口问它类型的 `WindowTypeDefinition.restore.describe(data, 还在的终端)`（contracts 的可选字段，现在只有终端有；白板不按 type 写特例）。有要恢复的就弹 “Restore your last session?”：一句 “5 terminals in 3 workspaces: 3 agents and 2 shells.”，下面每个窗口一行（名字 + 恢复后会怎样，最多 8 行），Not now / Restore all。tmux 会话都在（普通 ⌘Q 再打开）不弹；读不到终端列表不弹；正开着别的对话框不打断。Restore all 并发调每个窗口的 `restore.restore(data, { workspaceId, contentSize })`，把返回的 patch 合进 data（窗口 id、位置不变，跟着存盘），完成后 Toast：“Restored 5 terminals. codex had no saved conversation and started a new one.”，失败的写 “Couldn’t restore …: 原因”，那个窗口留着自己的 Restore。Not now 之后每个窗口自己有 Restore / Restart。收起的组成员也会恢复（不靠窗口组件在不在）。

- 后台 agent（N10，画板 13，`src/model/background.ts`、`src/react/Background.tsx`、`background.css`）：agent 自带的子 agent（SubagentService，`subagents.changed`），存在 store 的 `backgroundAgents`（按 terminalId，不保存）。
  - 小提示：主终端底边右侧（左侧是 Auto-approve 书签），只数这一轮的（`current` 或还在跑）：“5 background agents · 3 running”，有出错的红点 “1 failed”，全部做完灰色 “✓ 5 done”；没有就不画。点它开 / 关面板（`backgroundPanels`，按主终端的 windowId，不保存）。右键菜单在有后台 agent 时多一项 Background agents…（提示消失以后也能打开）。
  - 面板：不是窗口组 lead 的主终端，侧边栏是单独的节点（`bg-sidebar:<windowId>`，位置同 N2 的 `sidebarRect`）；是 lead 时 BACKGROUND 一组并进 N2 的侧边栏（TERMINALS / BACKGROUND · READ-ONLY 两个小标题）。选中一行在停靠处开只读的记录窗口（`bg-transcript:<windowId>`，`watchTranscript` / `unwatchTranscript`），lead 的子终端先收起；侧边栏点子终端时记录窗口收起。
  - 框装得下（2026-10-26 用户定）：`withGroup` 算窗口占的地方时加上面板、记录窗口、底边标记和 Usage 条（`markOutset`）。面板打开时 `fitPanel` 让框长、盖住的窗口挪开，记下打开前的布局；收起时 `unfitPanel` 原样放回（期间布局被别的操作改过就不动）。标记、Usage 条出现时 `keepMarksInFrames` 让框长（只变大，拖动中不管）。

- 项目框一键排版（N12，画板 15，`src/model/arrange.ts`、controller 的 `arrangeFrame` / `setAutoArrange` / `layoutFrame`，`FrameNodeView` 的 `FrameArrangeButtons`）：框标题右上角 Tidy（紧凑网格，⌈√n⌉ 列，窗口大小不变）、Columns（一行最多 6 个，一样高取最高、一样宽取平均）、Rows（一样宽取最宽、一样高取平均），竖线后面是 Auto-arrange 开关；上次用的排法、开着的开关墨黑底。设置在 `FrameNode.arrange`（contracts 0.1.10，可选，随白板保存）。
  - 每个窗口连同贴着它的东西（`withGroup`：标记、Usage 条、侧边栏、停靠的子终端、后台 agent 面板）算一块，整块挪；带着停靠子终端的 lead 只挪不改大小；放大中的、收起的不动。顺序按原来的位置先上后下、先左后右（上下差 40 以内算一行），新开的排最后。排到框内区域的左上角起，框缩到正好装下（不小于 FRAME_MIN），挤到的框照 V3 挪。点标题右上角的图标排版时框的**右上角不动**（框连同窗口往右挪齐原来的右边），图标留在指针底下；Auto-arrange 因新开、关掉窗口自动排时左上角不动。点图标记成一步（⌘Z）。
  - Auto-arrange：`noteFrameMembers` 看每个框里窗口的增减（store 订阅），开着的框在下一个微任务里按上次的排法（没点过 Tidy）重排；拖动中先不排，松手后排。这次重排不单独记撤销。框的右键菜单（标题、空白处）也有 Auto-arrange new windows。

- Send selection to ▸（CO3，TC-147，`src/model/send.ts`、`BoardMenu.tsx` 的 `sendSelectionItem`、controller 的 `selectionOf` / `pasteClipboard` / `sendSelection` / `sendSelectionToNew`）：
  - 终端内容区右键（`CONTENT_MENU_EVENT`，菜单目标 `window-content`；没聚焦时右键盖层也出这个菜单）：Copy ⌘C（复制选中的文字）、Paste ⌘V（读剪贴板，照 ⌘V 贴）、Send selection to ▸。终端标题栏菜单在 Maximize 后面也有 Send selection to ▸。没有选中的文字时 Copy 和它灰掉。选中的文字在打开菜单时取一次。
  - 子菜单：`sendTargets` 按 `windowOrder` 把别的终端按框分组，源终端的框在前，散放的在最后（小标题 “NOT IN A WORKSPACE”）；小标题是工作区名的大写；行 = `.ad-group-lamp` 灯（Menu 的 `icon`）+ 等宽名字 + 灰字（窗口名或组身份）。不列：源终端、在等你的（计数，底下灰字 “Waiting terminals are skipped”）、已退出 / 出错退出的、没有 terminalId 的。最后 New terminal here… ▸（`terminalItems`，开在源终端旁边、同一个框）。
  - 选了：`trimForSend` 去掉末尾换行 → `jumpToWindow`（收起的组成员先显示）、拉小的摘要卡 `expandSummary` → 等目标登记句柄（3 秒，新开的 10 秒）→ `paste(text, { requireBracketed: true })`。不成功时 Toast 写原因。只粘贴，不按回车，不经过 MCP。
  - 测试：`test/send-selection.test.tsx`。
- 放大的窗口（2026-10-26）：平移、缩放白板时自动还原（`viewportChanged` 里，放大 / 还原自己的动画期间 `maximizeMotionUntil` 不算），视口不动，记成一步 Restore window。

## dev 页面

`pnpm --filter @agentdeck/ui-canvas dev` → http://localhost:5320

- `window.agentdeck` 是 `createFakeApi({ latencyMs: 40 })` 的示例数据：3 个框、5 个终端、1 个网页窗口；codex 在等批准，1.5 秒后 shop 的 claude 提一个问题。
- 终端和网页是只显示文字的假窗口（`dev/FakeWindows.tsx`）：假终端真的 attach 到 FakeTerminalHost，输出去掉转义序列后显示，用 `setStatus` 显示状态。
- N2：feat/login 的 claude 开着一个窗口组（3 个子 agent，`term-sub-1..3`：api 一直在输出、ui 等批准、tests idle），白板上没有组时自动开（`board.open-group`）。`#group` 收起面板、100% 对准这一组（截图用）。
- 右侧面板是演示按钮：请求批准、提问、全部批准、一轮结束、Reset the board；PL1 的演示：右键 feat/login 的 claude › PLUGINS › Auto-approve 打开后，“wants rm -rf (Needs you)” / “asks (Needs you)” 让书签变橙（假服务不发 `approval.needs-you`，按钮替它发），“Handle it” 变回红色。布局额外存进 localStorage，刷新能看到恢复。
- PL2 的演示：feat/login 的 claude（48%）和 codex（91%，变黄，有 5 小时 / 每周额度）预置了用量，shop 的 claude 没有（No usage data）；右键终端 › PLUGINS › Usage 打开；“claude in feat/login makes a request (Usage)” 让 claude 的数字涨一次。
- 控制台里 `__board` 是 `BoardController`。

## 测试

`pnpm --filter @agentdeck/ui-canvas test`（Vitest + jsdom），`pnpm --filter @agentdeck/ui-canvas typecheck`。

- `registry.test.ts`：注册、替换、订阅、尺寸校验、摘要判断。
- `autosave.test.ts`：半秒防抖、flush、慢的保存按顺序、出错继续。
- `attention.test.ts`：running / waiting 计数、按工作区（框标题的 running 和顶栏同一口径，IS-64）、按开始等待的时间排序、badge 也算、⌘J 循环、⌘⇧J 反向、聚焦窗口排第几。
- `navigation.test.ts`：⌘⇧] ⌘⇧[ 的顺序（框按位置、框里从上到下从左到右、散放的最后）、循环、没有聚焦时从选中的框开始。
- `shortcuts.test.ts`：快捷键表、终端聚焦时不带 ⌘ 的键一个都不拿、输入框里不处理。
- `agent-jump.test.ts`（CO4）：⌥⌘n 按物理键认、⌘1 不变；按 `agentOrder` 跳到第 n 行并聚焦；没有这一行不动；没给 `agentOrder` 时不处理。
- `drop-and-menu.test.ts`：W5 落点和弹回规则（含 IS-54 的重叠框）、各个右键菜单的项。
- `snap.test.ts`、`avoid.test.ts`：V3 的纯函数（吸附的各种对象、阈值、最小尺寸、对齐线换成屏幕坐标；空位、优先框内、框停在 20px、沿边滑、挤开和连锁、启动时分开）。
- `layout-v3.test.ts`（对着 `createFakeApi()`）：拖动和改大小吸附、⌘ 不吸、阈值随缩放、松手滑到空位、框放不下就长并挤开别的框、放大的窗口例外、拖框停在边上、拖框边挤开再回来、IS-54 回归；IS-65 拖窗口对齐旁边的框、远的框不算、改框大小吸到隔 20 不挤开、吸到别的框的下边和正好装下窗口；IS-66 窗口间距 20。
- `controller.test.ts`（对着 `createFakeApi()`）：恢复布局、保存防抖和重启后一致、status.changed 驱动提醒和程序坞角标、⌘J ⌘⇧J 和闪一下、⌘⇧] ⌘⇧[ 切窗口（视口里看得见就不动）、通知跳转、框里新建终端用工作区目录、⌘N、reuseKey、W5 弹回和 Open new、拖到框边框变大、网页换框、拖框带走窗口、框的最小尺寸、改大小松手才生效和摘要卡、放大还原、关闭确认、新建工作区和 setup、创建失败、删除工作区的 dirty 流程、Add project…。
- `mcp-board.test.ts`（N1，对着 `createFakeApi()`）：网页开在调用者旁边（散放时正好在右边 20px、在框里挨着调用者不盖住别人、调用者在别的框时不拉出框）、reuseKey 重启后仍复用；窗口组的位置（在 lead 右边、互不重叠、框跟着长）、不抢焦点、保存和重启后恢复、第二次加进同一组、子终端再开也进同一组、关 lead 子终端变普通窗口、子终端关完 lead 不再是组、没有 lead 时不成组；focus-window 跳过去 / 打字时只闪；keydown 算打字；notify 的 Toast 文字 / 打字时只闪。
- `group-sidebar.test.tsx`（N2）：新组只显示第一个且不盖住别人、单击一行切换显示的子终端并聚焦、Show all 不重叠 / Collapse group 取消聚焦、拖 lead 停靠的和收起的跟着走、⌘J 跳到收起的在等你的子终端把它显示出来（仍算 waiting）、关掉显示的换下一个、关 lead 平铺开变普通窗口、view 保存和恢复；纯函数（没有 view 按 all、名字、syncGroups 停靠 / 拖走后不跟、状态灯）；Workbench 里的行和灯、waiting 行的底色、标题栏灰字、点行 / Show all / Collapse group 改变渲染的节点、侧边栏的位置、关 lead 后侧边栏消失。
- `settings.test.tsx`：Settings 对话框的入口（顶栏、Projects ▾、⌘,）、保存只发改了的字段、改完后新建 worktree 用新的基础分支 / 复制文件 / 初始化命令、多仓库、换页保留草稿和 Cancel、General、保存失败的提示、Open settings.json、Locate…、草稿函数。
- `gestures.test.tsx`（N6）：React Flow 的手势参数、所有窗口节点和内容都是 `nowheel`（聚焦前后）、没聚焦的终端上滚轮转给终端且白板不动（单击仍只聚焦）、聚焦的终端滚动不平移（对照：空白处平移）、不自己处理滚轮的内容滚最近的 overflow 盒子、网页上盖层暂时让开、窗口上捏合和 ⌘ + 滚轮以指针为不动点缩放、空格在白板上拿、在终端和输入框里（含 Shift / Ctrl + 空格）不拿、失焦松开；纯函数 `zoomAtPoint` `wheelZoomDelta` `spaceBelongsTo`。
- `auto-approve.test.tsx`（PL0、PL1、X3）：终端和框的 PLUGINS 一组（不套子菜单、打钩跟着服务、开关调的方法和参数、写进白板）、第一次开先问、kimi / shell 灰掉写原因、网页没有这一组、登记表加一项就出现在对应菜单里（Usage 的样子）；书签只在开着时出现、在外框外面、位置和颜色的 CSS、needs-you 变橙和悬停原因、终端不在等了变回红、每次自动批准闪、小卡片和 Turn off；框标题的小标签和框里每个终端的书签；Approval history 的列和顺序；顶栏 Approve all…、破坏性的默认不勾、couldnt-approve 那一行留下、勾上破坏性的再批、全批成后的提示；启动时不重复推、换 terminalId 补推。
- `usage.test.tsx`（PL2，对着 `createFakeApi()` 的 `FakeUsageService`）：菜单里 Usage 在 Auto-approve 后面、点开默认贴上边并写进窗口数据、再点关掉；shell 灰掉、框和网页没有、五种 agent 都能开；条在外框外面、数字缩写和悬停的准确数、CSS 的位置和 tokens；usage.changed 实时更新；85% 变黄（84 不变）、codex 只写缓存读；No usage data 和原因、inferred 写明、unsupported；没有 terminalId 不 watch；拖把手的落点线、松手换边、拖到窗口外也只贴上边、保存后重启还在下边；放大时留位置；小卡片的内容、Move to bottom / top、Hide 后 unwatch；codex 额度；watch / unwatch 跟着开关、关窗口、换 terminalId；缩写和额度文字的纯函数（IS-69 的验收数字：codex 0.6% → 99% left、27,756 / 475,000 → 97% left，claude 52,476 / 1M → 5%，kimi 70,450 / 1M → 68.8k/977k、8%，pi / omp 的一位小数，Rust 的一半取偶）。
- `select-undo.test.ts`（X10，对着 `createFakeApi()`）：框选碰到的窗口、⌘ + 框选加、跨框、Esc 取消、关掉的窗口去掉、选框清掉；一起拖动同一个位移、框跟着长、外接矩形吸到框的内边、松手整块避让不盖住别人、跨框各自留在自己的框里不弹 W5、拖没选中的只动它；撤销 / 重做：移动（12 次 pointermove 一步）、W5 弹回不算一步、改大小连同框、放大和还原、关闭运行中的终端放回原样且不碰进程、已退出的终端和网页、重启后重做关闭被拒、拖框和改框大小（挤开的框回去）、窗口组的三种显示方式、改窗口名和工作区名、新的一步清重做、100 步上限、拖动中不撤销、服务后开的窗口和 data 不动、工作区删掉后跳过；纯函数 `diffLayout` `applyStep` `BoardHistory` 和选择的几个。
- `select-undo-ui.test.tsx`（X10，Workbench）：⌘Z / ⌘⇧Z 的按键表、终端里和白板上给白板、地址栏里不拿、Ctrl+Z 不管；`textUndoTarget`；⌘ / Shift + 单击标题栏加减（聚焦的算进来、不抢聚焦）、单击别的窗口取消；Shift + 拖空白处出框选矩形、松手后的 click 不清掉；框选只从空白处开始；选中的样式只用 tokens。
- `workbench.test.tsx`：整个 Workbench 在 jsdom 里渲染：顶栏数字随假事件变化、框标题“1 running”绿灯和“2 waiting”黄灯（为 0 不显示）、终端聚焦时按键不被拦、⌘B ⌘J、顶栏“1/2 waiting”、⌘⇧J ⌘⇧]（⌘] 不拦）、Delete 打开删除对话框。

React Flow 的真实拖动 jsdom 测不了（滚轮能测，见 `gestures.test.tsx`），在 dev 页面里手动试过；触控板的手感（捏合速度、惯性滚动进终端和网页）要在应用里手动试；Playwright 用例留给第 3 波 R2。

## 不许碰

只改 `packages/ui/canvas`、`packages/ui/window-shell`、`packages/ui/topbar`（插件需要的通用菜单零件在 ui-kit：`Menu` 的 heading 和 hint）。不改 contracts（意见写 CONTRACT_NOTES.md）、不改 apps/desktop。
