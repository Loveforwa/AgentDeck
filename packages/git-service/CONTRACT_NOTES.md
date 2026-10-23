# 线 3 对 contracts 0.1.2 的意见

> **已处理（2026-10-23，contracts 0.1.3，提交 a913dcf）**：第 2、3、4、5、6 条加进了 contracts（`adoptPath`、`branches({ remote })`、`StashInfo.byAgentDeck`、`StatusSnapshot.workspaceId`、`repairWorktrees`），第 1、7–11 条写进了注释。git-service 已实现 `repairWorktrees`（把每个 worktree 路径传给 `git worktree repair`）和 `byAgentDeck`；远端分支、`adoptPath`、locate 调 repair、面板改用 `byAgentDeck` 待线 3 跟进。

写 git-service、workspace-service、scm 面板时发现的。没有改 `packages/contracts`，交给集成负责人决定。线 3 三个包共用这一份。

## 需要加东西（都是只加不改）

### 1. 切了分支，谁来更新 `Workspace.branch`
- 面板里 `git.switchBranch` 之后，库里的 `Workspace.branch` / `repos[].branch` 还是旧的，框的标题（项目 · 分支）不会变。contracts 里没有说谁负责。
- 现在的做法：`LocalWorkspaceService.noteStatus(status: RepoStatus)`（contracts 之外的方法）比较分支，有变化写库并发 `workspace.changed`；`workspaces.list()` 也会顺手对一遍（用户在终端里 `git switch` 的情况）。组装时在主进程把 git-service 发的 `git.status` 事件接给 `noteStatus` 即可。
- 建议：在 `WorkspaceEvent` / `GitService.switchBranch` 的注释里写明“切分支后 workspace-service 发 workspace.changed”，或者把 `noteStatus` 的职责写进 contracts。
- 影响：线 2（框标题）、组装。

### 2. 不在白板上的 worktree 没法加回来
- 需求「8」的 Repository 区：“不在白板上的灰显并写 not on board，单击出现 Add to board”；「4」也说“以后可以在右侧面板的 Repository 区加回白板”。但 `CreateWorkspaceRequest` 只能新建 worktree 或用主目录；用 `{ kind: 'existing' }` 会因为分支已经在那个 worktree 里检出而抛 `branch-in-use`。
- 建议加：`CreateWorkspaceRequest.adoptPath?: AbsPath`（mode 为 worktree 时，直接把这个已有的 worktree 记成工作区，不跑 git worktree add），或单独的 `WorkspaceService.adopt(projectId, path)`。
- 面板现在只显示“not on board”，不能点。
- 影响：线 2、线 3。

### 3. 分支列表只有本地分支
- `GitService.branches` 返回 `BranchInfo` 没有“远端”的概念，现在只列 `refs/heads`。只在 origin 上有的分支（同事推的）切不过去，新建工作区的“Existing”也选不到。
- 建议加：`BranchInfo.remote?: string | null`（例如 'origin'），`branches(repo, opts?: { remote?: boolean })`；`switchBranch` 对远端分支建本地跟踪分支（git switch 默认就会这么做）。
- 影响：线 2（新建工作区对话框）、线 3。

### 4. stash 是不是 AgentDeck 存的
- `SwitchStrategy 'stash'` 切回来时要提示恢复，但 `StashInfo` 分不清是 Stash and switch 存的，还是用户自己在终端里 `git stash` 的。面板现在对“存的时候在这个分支上”的任何 stash 都提示（可以 Dismiss）。
- 真实现的 stash 信息是 `AgentDeck: switched to <分支>`；假实现是 `On <分支>: switching to <分支>`，两边不一致，面板不依赖它。
- 建议加：`StashInfo.byAgentDeck?: boolean`，或让 `switchBranch` 在用了 stash 时返回那条 stash 的 id。
- 影响：线 3、F6（假实现）。

### 5. 状态快照不知道终端在哪个工作区
- 切分支前要提示“claude is running in this folder”，面板需要知道这个工作区里有哪些 agent 在跑。`StatusSnapshot` 没有 workspaceId（只有 `pending.workspaceId`）。现在由白板通过 `runningAgents` prop 传进来（白板知道哪些终端在框里）。
- 建议（可选）：`StatusSnapshot.workspaceId?: WorkspaceId | null`，面板就能自己算。
- 影响：线 4。

### 6. 主仓库搬家后 worktree 要修
- `ProjectService.locate` 换了仓库位置后，已有 worktree 里的 `.git` 文件还指向旧位置，打不开。需要在新位置跑 `git worktree repair`。
- 建议加：`GitService.repairWorktrees(repo): Promise<void>`，locate 时调用。现在 locate 只改库里的路径。
- 影响：线 3。

## 需要说清楚（只改注释）

### 7. discard 的语义
- 注释只写了“已跟踪文件还原；未跟踪文件移到废纸篓”。真实现照 VS Code：有没暂存的改动 → 工作区还原成暂存区；只有暂存的改动 → 暂存区和工作区都还原成 HEAD；新加进暂存区的文件 → 拿出暂存区并进废纸篓；冲突 → 还原成 HEAD。建议写进注释。

### 8. `commit` 的 all=true
- 注释是“没有暂存时提交全部改动”。真实现 all=true 就 `git add -A`（不管有没有暂存）再提交。面板只在没有暂存时传 true。建议注释改成“all=true：先暂存全部改动（含未跟踪文件）再提交”。

### 9. `log` 里“基础分支最近的几条”
- 真实现：`<base>..HEAD` 的提交（onBase=false），加上从 HEAD 和基础分支的合并基点往前的几条（onBase=true，至少 3 条，总数不超过 limit 时补满）。基础分支名先找本地分支，再找 `origin/<名字>`。
- 假实现基本一致。建议写进注释，免得界面猜。

### 10. `repoRoot` 对不存在的目录
- 真实现返回 null（和“不在仓库里”一样），不抛错。建议注释写明。

### 11. 事件由谁发
- `git.status` / `git.refreshing`：git-service 构造参数里的 `emit` 发（status 超过 1 秒先发 refreshing，结束发 status）。写操作之后不自动发 status，由调用方（面板）再调一次 status。假实现是每个写操作后都发，组装后行为会少一些事件，面板两种都能处理。

## 假实现（F6）和真实现不一样的地方

- `FakeProjectService.initGit` 不更新主目录工作区的 `repos`（真实现会填上 `{ name: '.', path, branch }`）。面板对“git 项目的主目录工作区 repos 为空”做了兜底，用工作区目录本身。
- 假的 stash 信息格式不同（见第 4 条）。
- 假的写操作每次都发 `git.status`（见第 11 条）。
