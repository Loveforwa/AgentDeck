# @agentdeck/git-service

contracts `GitService`（`packages/contracts/src/git.ts`）的真实实现（任务 G1）。直接调系统的 git，每条命令一个子进程（`execFile`，不经过 shell），异步、有超时，不阻塞主进程。不监听文件。

只在**主进程**里用（Node）。界面走 `window.agentdeck.git`。

## 对外接口

```ts
import { createGitService } from '@agentdeck/git-service';

const git = createGitService({
  moveToTrash: (p) => shell.trashItem(p), // 必填：未跟踪文件 discard 时用。服务包不碰 Electron，由 apps/desktop 传进来
  env: loginShellEnv,                      // 登录 shell 的环境（docs/decisions.md），默认 process.env
  gitPath: 'git',                          // 默认在 env.PATH 里找
  emit: (e) => bus.emit(e),                // 发 git.status / git.refreshing；不传就不发
  timeoutMs: 30_000,                       // 读操作
  longTimeoutMs: 300_000,                  // commit（跑钩子）、switch、worktree add、stash
});
```

另外导出 `SystemGitService`（类）、`GitCommandError`、`samePath`，以及解析函数 `parseStatusV2` `parseWorktrees` `parseBranches` `parseLog` `parseStashes`（纯函数）。

## 每个方法跑什么

| 方法 | 命令 | 说明 |
| --- | --- | --- |
| status | `status --porcelain=v2 -z --branch --untracked-files=all`、`rev-parse --absolute-git-dir`、`rev-list --count <base>..HEAD` | 带 `GIT_OPTIONAL_LOCKS=0`，不抢 index.lock。合并 / 变基 / cherry-pick / revert 看 worktree 自己 git 目录里的 MERGE_HEAD 等。冲突文件排最前。超过 1 秒先发 `git.refreshing`，结束发 `git.status` |
| stage | `add -A -- <paths>` | 删除也能暂存 |
| unstage | `restore --staged`；没有提交时 `rm --cached -r` | 重命名连旧路径一起还原 |
| discard | 见下 | 未跟踪的、新加进暂存区的文件调 `moveToTrash` |
| commit | `add -A`（all）+ `commit -q -F -` | 信息走 stdin；钩子失败时 detail 是钩子的输出 |
| branches | `for-each-ref refs/heads`，按最近提交排 | `checkedOutAt` 来自 `%(worktreepath)`，包括自己这个目录 |
| switchBranch | `switch`；stash 策略先 `stash push --include-untracked -m "AgentDeck: switched to <分支>"` | 切不过去时把刚存的 stash 放回来 |
| createBranch / addWorktree | `switch -c` / `branch` / `worktree add -b`，都带 `--no-track` | 从 origin/main 分出时不把上游设成 main |
| deleteBranch | `branch -d` / `-D` | |
| stashes / applyStash | `stash list` / `stash apply`（+ `stash drop`） | id 只认 `stash@{n}` |
| log | `log <base>..HEAD` + 合并基点往前几条（onBase） | 没有基础分支时全部 onBase=false |
| diff | `diff [--cached] --no-color --no-ext-diff`；未跟踪文件 `diff --no-index /dev/null <文件>` | |
| worktrees | `worktree list --porcelain -z` | 要 git ≥ 2.36；bare 主仓库不列出 |
| removeWorktree | `worktree remove [--force]`；目录已经没了时 `worktree prune` | |
| repoRoot | `rev-parse --show-toplevel` | 不在仓库里、目录不存在都返回 null |
| defaultBranch | origin/HEAD → main → master → 当前分支 | 本地或 origin 上有就算 |

discard 的规则（VS Code 的做法）：有没暂存的改动 → 工作区还原成暂存区的样子（`restore --worktree`）；只有暂存的改动 → 暂存区和工作区都还原成 HEAD；新加进暂存区的文件 → 拿出暂存区、文件进废纸篓；冲突文件 → 还原成 HEAD；未跟踪 → 废纸篓。

基础分支名解析：本地分支 → `origin/<名字>` → 原样（标签、哈希）。

## 错误

都是 `AgentDeckError`，`detail` 是 git 的原话（stderr，没有就 stdout）。

| code | 什么时候 |
| --- | --- |
| `git-failed` | git 非 0 退出（`GitCommandError`，带 exitCode / stderr / stdout）：pathspec did not match、nothing to commit、not fully merged、stash 冲突、钩子失败…… |
| `not-a-git-repo` | 目录不在仓库里 |
| `branch-in-use` | 切换 / 删除 / 检出的分支已经在别的 worktree 里 |
| `branch-exists` | 新建的分支已存在 |
| `dirty-worktree` | carry 切分支时改动和目标分支冲突；删除 worktree 时有改动且没 force |
| `not-found` | 分支、起点、目录不存在 |
| `invalid-argument` | 空提交信息、非法分支名、不是 `stash@{n}` 的 id |
| `command-not-found` | 找不到 git 可执行文件 |
| `timeout` | 超时，子进程被 SIGKILL |

子进程环境：调用方给的 env 加上 `GIT_TERMINAL_PROMPT=0`、`GIT_EDITOR=true`、`GIT_PAGER=cat`、`LC_ALL=C`（输出固定英文，解析和错误匹配才稳）；涉及路径的命令加 `GIT_LITERAL_PATHSPECS=1`（文件名里的 `*` `[` 不当通配符）。同一个目录的写操作按顺序排队。

## 测试

```bash
pnpm --filter @agentdeck/git-service test       # Vitest，在真实临时仓库上跑（tools/fakes 的 createTempRepo）
pnpm --filter @agentdeck/git-service typecheck
```

- `test/parse.test.ts`：各种输出的解析（重命名、冲突、子模块、带空格的路径、分离 HEAD、bare 仓库）。
- `test/git-service.test.ts`：新增、修改、删除、重命名、冲突、合并中、变基中、子模块显示为一条、stash 往返、带改动切换和冲突时拒绝、被占用的分支、worktree 增删、删分支、目录被手动删掉、钩子失败、超时、找不到 git、并发写排队。
- 测试里的 git 不读用户的全局配置（`GIT_CONFIG_GLOBAL=/dev/null`，见 `test/helpers.ts`）。

## 不许碰

- `packages/contracts`：接口不够用写进本目录的 `CONTRACT_NOTES.md`。
- 其他包。本包不依赖 ui、不依赖 Electron、不依赖其他服务包。
