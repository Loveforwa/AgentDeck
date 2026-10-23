# 对 contracts 0.1.0 的意见（F6 写假实现时发现）

没有改 `packages/contracts`。下面是写假实现时遇到的接口不够用或说得不清的地方，交给集成负责人决定。
假实现里对每一条的临时做法都写在“假实现现在怎么做”里。

## 需要加东西（都是只加不改）

### 1. GitService 没法恢复 stash
- `SwitchStrategy` 的 `'stash'` 注释说“切回来时提示恢复”，但 GitService 没有列出或恢复 stash 的方法，界面提示了也做不到。
- 建议加：`stashes(repo): Promise<{ id: string; branch: string | null; at: IsoTime; message: string }[]>`、`applyStash(repo, id, opts: { drop: boolean }): Promise<void>`。
- 影响：线 3（git-service、scm 面板）。
- 假实现现在怎么做：`FakeGitService.stashes(path)` 只能看，不能恢复。

### 2. GitService 没有删分支
- WorkspaceService.create 要求“多仓库时任何一个仓库失败，已经建好的全部回滚”。`addWorktree(..., { create: true })` 建出来的分支没有接口能删，回滚只能删 worktree、留下分支。
- 建议加：`deleteBranch(repo, name, opts: { force: boolean }): Promise<void>`。
- 影响：线 3。
- 假实现现在怎么做：`FakeGitService.deleteBranch()` 是假实现自己的方法，FakeWorkspaceService 回滚时调用它。

### 3. status / log 不知道“项目基础分支”
- `RepoStatus.aheadOfBase`、`CommitInfo.onBase` 都说“相对项目基础分支”，但基础分支可以在项目设置里改（`ProjectPatch.baseBranch`），`status(repo)`、`log(repo, limit)` 拿不到它。
- 建议加可选参数：`status(repo, opts?: { baseBranch?: string })`、`log(repo, limit, opts?: { baseBranch?: string })`；不传时用 `defaultBranch(repo)`。
- 影响：线 3。
- 假实现现在怎么做：默认用仓库默认分支；`FakeGitService.setBaseBranch()` 可以改，`FakeProjectService.update` 改基础分支时会同步调用它。

### 4. agents.start 不带终端大小
- `StartAgentRequest` 没有 size。终端在 attach 之前就建好了，claude、codex 这类 TUI 会先按默认大小（80×24）画，attach 后再 resize 一次，首屏会跳。`CreateTerminalRequest` 本身有可选的 size。
- 建议加：`StartAgentRequest.size?: TermSize`，原样传给 `terminals.create`。
- 影响：线 2（New terminal ▸ 知道窗口大小）、线 4。

### 5. 删除工作区遇到未提交的改动
- `RemoveWorkspaceRequest.deleteFolder: true` 时，如果 worktree 里有改动，是直接 `--force` 删，还是报 `dirty-worktree` 让界面再确认一次？现在没有 force 字段，表达不了“确认后强删”。
- 建议加：`RemoveWorkspaceRequest.force?: boolean`，默认 false → 有改动时抛 `dirty-worktree`；界面确认后带 `force: true` 再调一次。
- 影响：线 2（确认框）、线 3。
- 假实现现在怎么做：总是 force 删除。

## 需要说清楚（只改注释）

### 6. kill 之后发不发 terminal.exit
- `TerminalHost.kill` 后，状态服务怎么知道这个终端没了？现在没有“终端已移除”的事件，`terminal.exit` 是否会发、退出码是什么也没写。
- 建议在注释里定下来：kill 后发一次 `terminal.exit`（退出码按信号算，SIGHUP 是 129），或者另加 `{ type: 'terminal.removed'; id }`。
- 影响：线 1、线 4。
- 假实现现在怎么做：进程还活着时发 `terminal.exit`，code 129；从 list() 里去掉。

### 7. attach 之后先给不给当前屏幕
- 真 tmux attach 会重画整个屏幕。界面要知道 attach 后第一条 `TerminalDataMessage` 是不是“当前屏幕”，才能决定要不要先清屏。
- 建议在 `attach` 注释里写明：接上后先推一次当前屏幕内容，之后是增量输出。
- 假实现现在怎么做：attach 后下一轮（setTimeout 0）把已有的全部输出推给这个 view，之后推增量，不会重复。

### 8. 多仓库项目新建分支时的 `from`
- `BranchChoice` 的 `{ kind: 'new', from: string }` 只有一个 from，但多仓库项目里每个仓库可以有不同的基础分支（`RepoRef.baseBranch`，例如一个 main、一个 master）。
- 建议注释写明：多仓库时 `from` 对每个仓库都按名字解析，某个仓库没有这个分支就失败（或者改为可选、不填用各仓库自己的 baseBranch——这算改形状，需要集成负责人定）。
- 假实现现在怎么做：按名字解析，没有就抛 `not-found`，已建好的回滚。

### 9. 几个错误码没写
- 提交时没有可提交的内容：假实现抛 `git-failed`（detail 是 git 原话 "nothing to commit"）。
- `stage` / `unstage` / `discard` 传了不存在的路径：假实现抛 `git-failed`（pathspec did not match）。
- `projects.add` 加一个已经加过的文件夹：假实现直接返回已有项目，不报错。
- 建议在对应方法的注释里写上，免得真实现和界面各猜各的。

### 10. workspace.progress 只带 projectId
- 同一个项目同时建两个工作区时，界面分不清进度属于哪一个。建议加可选字段 `branch?: string` 或请求 id。优先级低。
