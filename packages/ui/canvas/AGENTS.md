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

- `registerWindow(def)` 返回撤销函数；同一个 type 再注册会替换（热更新）。`getWindowType`、`listWindowTypes`、`isSummarySize`、`createWindowRegistry`（测试用的独立注册表）。
- 白板给组件的 props 照 contracts 0.1.2 的 `WindowComponentProps`：
  - `contentSize` 是内容区（不含 28px 标题栏和边框）的像素，**改大小松手后才变**；拖动中外框在变，组件拿到的不变。
  - `visible`：窗口和视口有交集。终端据此 attach / detach。
  - `focused` 为 false 时内容上盖了一层：滚轮平移白板，第一下单击只聚焦，所以组件不用自己处理“没聚焦时的滚轮”。
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
- `BoardController`：白板的全部行为，不依赖 React，测试里直接用。`Workbench` 可以传自己建的 `controller`。`runShortcut(id)` 可以接到应用菜单的快捷键上（焦点在网页窗口的 iframe 里时按键到不了白板）。
- `addProject` 选项可以换掉默认的 Add project… 流程（线 3 的 W1 做好后接上）。
- Settings 对话框（X12，TC-15）在白板里：`controller.openSettings({ section?: 'projects' | 'general', projectId? })`。入口：顶栏 Settings、Projects ▾ › 项目 › Project settings…、⌘,（`ShortcutId` 的 `open-settings`，输入框里也生效；应用菜单的 Settings… 发这个快捷键）。组装方把终端窗口的 `agentdeck:open-settings` 事件接到 `openSettings`。
  - 左边项目列表 + General。项目页：Name、Path（只读，找不到时 Locate… → `projects.locate`）、每个仓库的 Base branch（选项来自 `git.branches`）、Worktree location（Browse… 用 `app.pickFolder`）、Files to copy（一行一个）、Setup command。General：closeWindow、notifications、defaultAgent、editorCommand、terminalApp。
  - 各页改的是草稿（`src/model/settings.ts`），换页不丢；Save 把所有改过的页一起保存，只发改了的字段（`projects.update` / `app.updateSettings`），都成功才关；失败用 Toast 提示、对话框不关。Agents、Approvals 页以后再加。

## 目录

| 路径 | 内容 |
| --- | --- |
| `src/registry.ts` | 窗口注册表（唯一对别的界面包开放的文件） |
| `src/controller.ts` | `BoardController`：启动和事件、拖动、改大小、放大、新建、关闭、工作区、视口、快捷键 |
| `src/store.ts` | zustand vanilla store：保存的部分（BoardState）+ 临时状态 |
| `src/model/` | 纯函数：`geometry`（框跟着长、框的最小尺寸、视口）、`attention`（S3 计数和 ⌘J 顺序）、`autosave`（B5 防抖）、`shortcuts`（R1 按键表）、`drop`（W5 落点）、`windows`（终端相关的判断）、`branch`（分支名检查）、`settings`（Settings 的草稿和补丁） |
| `src/react/` | `Workbench`、`Board`（React Flow）、`WindowNodeView`、`FrameNodeView`、`BoardMenu`（右键菜单）、`dialogs`（新建 / 删除工作区、W5、停止终端、改名）、`SettingsDialog`、`useShortcuts` |
| `src/canvas.css` | 白板、框、面板、对话框字段的样式，只用 tokens |
| `dev/` | dev 页面（Vite） |

## 行为要点

- 平移：两指滚动、拖空白处（左键或中键）；缩放：⌘ + 滚轮（25%–200%），⌘0 100%，⌘1 Show all（最大 100%），⌘= ⌘−，左下角比例菜单。不响应双指捏合。点阵 20px，缩到 50% 以下隐藏。
- 框和窗口是不可拖的 React Flow 节点，移动和改大小走 window-shell 的手势（只能拖标题栏），所以节点要显式 `pointer-events: all`。屏幕坐标换算用 store 里的视口（`controller.clientToFlow`），不用 React Flow 的 `screenToFlowPosition`（受控视口动画后它会落后）。
- 框里的窗口拖向框外：框跟着长（W3）；指针进了别的框：那个框虚线，松手时终端弹回原处并问“Open new”（W5），网页直接换框。
- 新建的东西放在右键的位置；⌘N / ⌘T 放在聚焦窗口右边、同一个工作区；没有聚焦时在视口中心。新工作区没给位置时放在空的地方。
- 关闭运行中的终端要确认（Stop and close，调 `terminals.kill`）；已退出的终端和网页直接关。
- 删除工作区：Remove from board / Also delete the worktree folder；服务抛 `dirty-worktree` 后要勾“I understand these changes will be lost”再带 `force: true`。成功后结束框里的终端。
- 保存：保存的部分（视口、框、窗口、面板）引用一变就排进防抖，半秒后 `board.save`；`pagehide` 时立刻写。启动时 `board.load` 恢复。

## dev 页面

`pnpm --filter @agentdeck/ui-canvas dev` → http://localhost:5320

- `window.agentdeck` 是 `createFakeApi({ latencyMs: 40 })` 的示例数据：3 个框、5 个终端、1 个网页窗口；codex 在等批准，1.5 秒后 shop 的 claude 提一个问题。
- 终端和网页是只显示文字的假窗口（`dev/FakeWindows.tsx`）：假终端真的 attach 到 FakeTerminalHost，输出去掉转义序列后显示，用 `setStatus` 显示状态。
- 右侧面板是演示按钮：请求批准、提问、全部批准、一轮结束、Reset the board。布局额外存进 localStorage，刷新能看到恢复。
- 控制台里 `__board` 是 `BoardController`。

## 测试

`pnpm --filter @agentdeck/ui-canvas test`（Vitest + jsdom），`pnpm --filter @agentdeck/ui-canvas typecheck`。

- `registry.test.ts`：注册、替换、订阅、尺寸校验、摘要判断。
- `autosave.test.ts`：半秒防抖、flush、慢的保存按顺序、出错继续。
- `attention.test.ts`：running / waiting 计数、按工作区、按开始等待的时间排序、badge 也算、⌘J 循环。
- `shortcuts.test.ts`：快捷键表、终端聚焦时不带 ⌘ 的键一个都不拿、输入框里不处理。
- `drop-and-menu.test.ts`：W5 落点和弹回规则、各个右键菜单的项。
- `controller.test.ts`（对着 `createFakeApi()`）：恢复布局、保存防抖和重启后一致、status.changed 驱动提醒和程序坞角标、⌘J、通知跳转、框里新建终端用工作区目录、⌘N、reuseKey、W5 弹回和 Open new、拖到框边框变大、网页换框、拖框带走窗口、框的最小尺寸、改大小松手才生效和摘要卡、放大还原、关闭确认、新建工作区和 setup、创建失败、删除工作区的 dirty 流程、Add project…。
- `settings.test.tsx`：Settings 对话框的入口（顶栏、Projects ▾、⌘,）、保存只发改了的字段、改完后新建 worktree 用新的基础分支 / 复制文件 / 初始化命令、多仓库、换页保留草稿和 Cancel、General、保存失败的提示、Open settings.json、Locate…、草稿函数。
- `workbench.test.tsx`：整个 Workbench 在 jsdom 里渲染：顶栏数字随假事件变化、框标题“2 waiting”、终端聚焦时按键不被拦、⌘B ⌘J、Delete 打开删除对话框。

React Flow 的真实手势（拖动、滚轮）jsdom 测不了，在 dev 页面里手动试过；Playwright 用例留给第 3 波 R2。

## 不许碰

只改 `packages/ui/canvas`、`packages/ui/window-shell`、`packages/ui/topbar`。不改 contracts（意见写 CONTRACT_NOTES.md）、不改 apps/desktop。
