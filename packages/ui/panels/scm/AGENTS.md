# @agentdeck/scm-panel

右侧的源代码管理面板（任务 G2 G3 G4，顺带 X7 X8 X9 的显示部分）。用法照 VS Code 的源代码管理；需求见设计画布「8 · 源代码管理面板」，零件图 `project/spec/Panel.dc.html`。

界面包：只依赖 contracts、design-tokens、ui-kit 和 React。git 操作全部走 `window.agentdeck`（contracts 的 `AgentDeckApi`），不碰服务包。

## 用法

```tsx
import { ScmPanel } from '@agentdeck/scm-panel';

<ScmPanel
  workspaceId={focusedWorkspaceId}        // 聚焦的窗口所在的工作区；散放窗口传 null
  onGoToWorkspace={(id) => board.focusFrame(id)} // 单击被占用的分支 / 提交图里带 ◧ 的分支标签
  runningAgents={['claude']}               // 这个工作区里正在跑的 agent，切分支前提示
  // api={...}                              // 默认 window.agentdeck；dev 页面和测试传假实现
  // headerActions={collapseButton}        // 标题栏 Refresh 后面的按钮：白板 renderPanel 给的收起面板按钮（MVP v2 · V4）
  // skills={target}                        // N9：SKILLS · MCP 小节跟着的终端（SkillsTarget）；null = 聚焦的不是终端；不传就没有这一节
/>
```

面板高度跟父元素（`height: 100%`），宽度由白板的面板容器定（设计是 320 左右）。应用入口要引一次 `@agentdeck/ui-kit/base.css`。

## 有什么

- 顶部：工作区名（项目 · 工作区）和目录，单击目录复制；多仓库时写“· 2 repositories”。右上 Refresh，刷新超过 1 秒显示 Refreshing…。
- 分支按钮和下拉：搜索、本地分支、New branch…（从当前提交新建并切过去）。被别的工作区检出的分支灰显并写“in <工作区>”，单击调 `onGoToWorkspace`。下面一行“3 ahead of main · ↑1 ↓2”，合并 / 变基中显示 Merging / Rebasing。
- 切分支：有改动或有 agent 在跑时先问：Switch with changes / Stash and switch / Cancel。git 拒绝带着改动切（`dirty-worktree`）时显示 git 原话，只留 Stash and switch。切回存 stash 的分支时提示 Restore / Dismiss（`applyStash(drop: true)`）。
- 提交框：⌘↩（或 Ctrl↩）提交；空消息时按钮不可用；有暂存时“Commit n files”，没暂存时“Commit all n changes”，第一次 Commit all 确认一次（记在 localStorage 的 `agentdeck.scm.commitAllConfirmed`）；合并中是“Complete merge”，还有冲突时不可用。提交失败在下面显示，可以展开 git 的输出（钩子失败）。
- Merge Changes（冲突，置顶）/ Staged Changes / Changes，按文件夹树形列出（单链文件夹合并成 `src/auth`），可折叠。悬停出现 + 暂存（冲突里是“标记已解决”）、− 取消暂存、放弃；文件夹和组标题上同样的操作作用于下面所有文件。状态字母 M A D R C U，冲突 !（橙色），子模块 S 并写“Submodule changed”。
- 单击文件：面板里看只读 diff，顶部 Back 和 Open in editor；双击直接在编辑器打开（`app.openInEditor`）。
- 放弃要确认：“Discard changes to x? This can’t be undone.”；未跟踪文件是“Move x to Trash?”。
- Graph（N5，IS-58，替换原来的 Repository 和 Commits 两块；只在单仓库时有）：`git.log(…, 60, { graph })` 的提交图，`CommitGraph.tsx` 画，排布是 `graph.ts` 的纯函数。
  - 泳道、分叉和合并画成弧线；合并提交是空心双圈，HEAD 是实心点。颜色只有墨黑（HEAD 和基础分支那条线）和三种暖灰（scm.css 的 `--graph-tone-*`，都由 token 混出来）。
  - 标签：本地分支（HEAD 指着的写 `HEAD → main`，墨黑实底）、本地没有同名分支的远端分支（虚线框）、标签。白板上有框在用的分支（经 `git.worktrees` 的目录对上工作区）墨黑描边、后面带 ◧ 和框名（框名和分支名一样时只写 ◧），单击跳到那个框；在 worktree 里检出但不在白板上的灰显。
  - 已经合并进基础分支（`git.branches({ mergedInto })` 的 `merged`）、没有框在用的分支收成最后一行“n merged branches not on the board”，点 Show 才在图上显示它们的标签并列出名字。
  - 右上 “All branches ▾ / This workspace ▾”：所有本地分支，或者只看 HEAD 加基础分支（`graph: { branches: [] }`）。记在 localStorage 的 `agentdeck.scm.graphView`，默认 All branches；换了只重取提交图，不算一次刷新。
  - 单击一行在下面展开它改了哪些文件（`git.log(…, 1, { commit })`，左边照着泳道画竖线）。悬停出现 Checkout（这一行上有能切过去的本地分支时，走原来的切分支流程）和 Copy（复制完整哈希）。
  - 服务没给 parents / refs 时（假实现）当成一条直线，HEAD 那条补上当前分支的标签。
- SKILLS · MCP（N9，`SkillsSection.tsx`，纯函数在 `skills-model.ts`）：在最后，和 Changes、Graph 一样一节，标题 “SKILLS · MCP for claude · Fix the login bug”，单击折起来（记在 localStorage 的 `agentdeck.scm.skillsOpen`）。
  - 跟着 `skills` 给的终端（`SkillsTarget`：terminalId、agent、label、白板上存的 selection、onChange、onRestart），数据是 `skills.forTerminal(terminalId)`，换终端（重启后 id 也会换）和收到 `skills.library-changed` 时重取。
  - 每行：勾选框、名字（等宽）、MCP 的加 “MCP” 小框、知道状态的加状态点（绿 / 红，只有 built in 的 agentdeck）、右边是来源（built in / repo / library）；
    repo 的总是勾着、不能点（悬停 “Follows the repo”）；agent 不支持的不能点，右边写 “Not supported for codex”。
  - 勾选 → `onChange(新的选择)`（只存能开关的 id，白板写进 `TerminalWindowData.skills`）；和正在跑的不一样时显示 “Changes apply after restart”，Restart and resume 变成实底按钮，点了调 `onRestart`（白板给窗口发 restart-resume）。
  - Add skill…：`app.pickFolder` → `skills.addSkill`；Add MCP…：对话框填名字和 “Command or URL”（http(s):// 开头算地址）→ `skills.addMcp`。加好之后这个 agent 能用就顺手给当前终端勾上。出错显示在小节里（对话框不关）。
  - api 里没有 `skills`（老的假实现）时写 “Not available here.”；终端没起来写 “Start the terminal…”；shell 写 “Skills and MCP servers are for agents, not for shell.”。
- 多仓库工作区：提交框在最上面，“Commit 5 changes in 2 repos”（每个仓库有暂存就提交暂存的，否则提交全部）；下面每个仓库一组，组标题有仓库名、它自己的分支按钮、“Commit this repo”。
- 没有 git 的文件夹：“notes isn’t a Git repository.” 和 Initialize Repository（`projects.initGit`）。
- 散放窗口：“This window isn’t in a workspace.”；文件夹丢了：“Folder not found”。

## 刷新（不监听文件）

只在这几种时候调 `git.status / log / stashes / worktrees`：

1. `workspaceId` 变了（或者工作区的仓库列表变了，比如 Initialize Repository 之后）；
2. 收到 `agent.turn-end` 且 `workspaceId` 是当前工作区；
3. 面板自己做完一次 git 操作（成功失败都刷新一次）；
4. 单击 Refresh。

服务推来的 `git.status`（别处触发的刷新）直接换上，不额外查；`git.refreshing` 也会显示 Refreshing…。旧的刷新结果晚到时丢掉。工作区和项目列表启动时取一次，之后跟着 `workspace.*` / `project.*` 事件改。每个工作区的提交信息草稿各自保留。

## dev 页面

`pnpm --filter @agentdeck/scm-panel dev` → http://localhost:5347 。数据来自 `createFakeApi()`：左边选聚焦的工作区（单仓库 worktree、主目录、多仓库、散放窗口），“Focused terminal (Skills · MCP)” 选小节跟着的终端（claude、codex、shell、不是终端），Restart and resume 在 dev 页面里把 running 换成当前选择；模拟 agent 一轮结束、外部改文件、合并冲突、把主目录弄脏（演示 Stash and switch 和恢复）、加一个没有 git 的文件夹；可以打开“慢 git”（每次调用 1.5 秒）看 Refreshing…、模拟有 agent 在跑、切暗色；“Demo commit graph”（默认开）把 agentdeck 仓库的提交图换成 `dev/demo-graph.ts` 里编的图（分叉、合并、已合并的旧分支），因为假实现的 log 不认 graph。页头显示面板调了几次 `git.status`。`dev:build` 打包到 `dist-dev/`（不提交）。

## 测试

```bash
pnpm --filter @agentdeck/scm-panel test       # Vitest + jsdom + Testing Library，对着 createFakeApi()
pnpm --filter @agentdeck/scm-panel typecheck
```

- `test/model.test.ts`：分组、文件夹树、按钮文字、分支摘要、时间、diff 行分类。
- `test/graph.test.ts`：提交图的泳道排布（直线、没有 parents、分叉、合并、合并进已有泳道、空位复用、窗外的父提交、墨黑和灰）、弧线路径、标签、收起已合并的分支。
- `test/panel.test.tsx` 的 “commit graph (N5)”：用手写的图替换假实现的 log / branches，测画面（HEAD 点、合并双圈、弧线、◧ 框名和跳转）、收起和 Show、展开文件列表、Checkout 和 Copy、切换视图并记住。
- `test/skills.test.tsx`（N9）：不传 skills 时没有这一节、不是终端时的提示、claude 的五行（来源、勾选、状态点）、勾选存选择 + Changes apply after restart + Restart and resume、重启后提示消失、折起来并记住、codex 的 Not supported、shell 和没起来的终端、Add MCP…（成功勾上、重名报错不关）、Add skill…（选了 / 取消），以及 skills-model 的纯函数。
- `test/panel.test.tsx`：散放窗口、树形列表、暂存和 ⌘↩ 提交、只在三种时机刷新（数 `git.status` 调用次数）、Refreshing…、被占用的分支灰显并跳转、Stash and switch 和恢复、第一次 Commit all 确认、放弃进废纸篓、diff、合并中、Initialize Repository。

## 不许碰

只改本目录。颜色、尺寸只用 design-tokens 的变量（`pnpm colors` 会查）；零件用 ui-kit。不 import 服务包、Electron、node 内置模块；`tools/fakes` 只能在 `test/` 和 `dev/` 里用。
