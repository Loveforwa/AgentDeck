# @agentdeck/scm-panel

右侧的源代码管理面板（任务 G2 G3 G4，顺带 X7 X8 X9 的显示部分）。用法照 VS Code 的源代码管理；需求见设计画布「8 · 源代码管理面板」，零件图 `project/spec/Panel.dc.html`。

界面包：只依赖 contracts、design-tokens、ui-kit 和 React。git 操作全部走 `window.agentdeck`（contracts 的 `AgentDeckApi`），不碰服务包。

## 用法

```tsx
import { ScmPanel } from '@agentdeck/scm-panel';

<ScmPanel
  workspaceId={focusedWorkspaceId}        // 聚焦的窗口所在的工作区；散放窗口传 null
  onGoToWorkspace={(id) => board.focusFrame(id)} // 单击被占用的分支 / Repository 区的一行
  runningAgents={['claude']}               // 这个工作区里正在跑的 agent，切分支前提示
  // api={...}                              // 默认 window.agentdeck；dev 页面和测试传假实现
  // headerActions={collapseButton}        // 标题栏 Refresh 后面的按钮：白板 renderPanel 给的收起面板按钮（MVP v2 · V4）
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
- Repository：这个项目所有的工作目录（`git.worktrees`），单击跳到对应的框；不在白板上的灰显写“not on board”（加回白板缺接口，见 git-service 的 CONTRACT_NOTES）。只有一个工作目录时不显示。
- Commits：最近 20 条，分隔线“On main”以下是基础分支上的；单击复制哈希。
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

`pnpm --filter @agentdeck/scm-panel dev` → http://localhost:5347 。数据来自 `createFakeApi()`：左边选聚焦的工作区（单仓库 worktree、主目录、多仓库、散放窗口），模拟 agent 一轮结束、外部改文件、合并冲突、把主目录弄脏（演示 Stash and switch 和恢复）、加一个没有 git 的文件夹；可以打开“慢 git”（每次调用 1.5 秒）看 Refreshing…、模拟有 agent 在跑、切暗色。页头显示面板调了几次 `git.status`。`dev:build` 打包到 `dist-dev/`（不提交）。

## 测试

```bash
pnpm --filter @agentdeck/scm-panel test       # Vitest + jsdom + Testing Library，对着 createFakeApi()
pnpm --filter @agentdeck/scm-panel typecheck
```

- `test/model.test.ts`：分组、文件夹树、按钮文字、分支摘要、时间、diff 行分类。
- `test/panel.test.tsx`：散放窗口、树形列表、暂存和 ⌘↩ 提交、只在三种时机刷新（数 `git.status` 调用次数）、Refreshing…、被占用的分支灰显并跳转、Stash and switch 和恢复、第一次 Commit all 确认、放弃进废纸篓、diff、合并中、Initialize Repository。

## 不许碰

只改本目录。颜色、尺寸只用 design-tokens 的变量（`pnpm colors` 会查）；零件用 ui-kit。不 import 服务包、Electron、node 内置模块；`tools/fakes` 只能在 `test/` 和 `dev/` 里用。
