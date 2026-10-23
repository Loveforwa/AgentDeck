# @agentdeck/workspace-service

contracts `ProjectService`（`project.ts`）和 `WorkspaceService`（`workspace.ts`）的真实实现（任务 W1 W2 W4）。需求见设计画布「2 · 项目」「4 · 工作区框」「8 · 源代码管理面板」的多仓库规则。

只在**主进程**里用。git 操作全部通过注入的 `GitService`；项目和工作区存在注入的仓储里，本包不打开数据库。

## 对外接口

```ts
import { openStore } from '@agentdeck/store';
import { createGitService } from '@agentdeck/git-service';
import { createWorkspaceServices } from '@agentdeck/workspace-service';

const store = openStore(dbPath);
const git = createGitService({ moveToTrash, env, emit });
const { projects, workspaces } = createWorkspaceServices({
  git,
  projects: store.projects,       // 结构和 store 的 ProjectRepository 一样（src/types.ts）
  workspaces: store.workspaces,
  transaction: store.transaction, // 可选
  emit: (e) => bus.emit(e),       // project.* / workspace.*
  homeDir: os.homedir(),          // 可选；worktree 默认在 <home>/.agentdeck/worktrees/<项目名>/
});
```

模块边界不许 workspace-service import store，所以仓储接口在 `src/types.ts` 按结构写了一遍，组装时直接传 store 的对象。

`workspaces` 还有一个 contracts 之外的方法 `noteStatus(status: RepoStatus)`：组装时把 `git.status` 事件接过来，面板里切了分支，工作区的 `branch` 跟着改并发 `workspace.changed`（见 `packages/git-service/CONTRACT_NOTES.md`）。

## 规则（照需求实现的）

项目：
- probe：在仓库里（含子文件夹）→ git，用仓库根目录；否则下一层有 ≥ 2 个仓库 → multi-repo（只看一层，跳过隐藏文件夹和 node_modules）；否则 plain。路径一律 realpath。已经加过 → already-added。
- add：已经加过直接返回已有的；`separately` 把每个子仓库各加成一个 git 项目。基础分支每个仓库各自识别（`git.defaultBranch`）。同名项目的 worktree 位置自动加 `-2`。
- list：文件夹不在了 → `missing: true`（回来了改回 false）；plain 项目被别的程序 git init 了 → 自动变成 git 项目。有变化才写库、发事件。
- remove：只从库里删（级联删工作区），每个工作区发一次 `workspace.removed`，不碰磁盘。
- locate：git 项目用新位置的仓库根；多仓库项目要求同名子仓库都在；主目录工作区跟着搬。
- initGit：plain → git，主目录工作区带上分支。

工作区：
- worktree 目录：`<worktreeRoot>/<分支 slug>`（`feat/oauth` → `feat-oauth`），已存在就加 `-2`。多仓库时这是父目录，各仓库在 `<父目录>/<仓库名>`。
- 新分支默认从每个仓库自己的 `baseBranch` 分出；`from` 填了就每个仓库按名字解析。
- 先把所有仓库检查一遍（分支已存在 / 不存在 / 被占用），再动手；中途失败把已经建好的 worktree 和新建的分支全部撤销，多仓库时错误信息前面加仓库名。
- 复制 `copyIntoWorktrees`（默认 `.env`、`.env.local`）：从主目录复制，worktree 里已有的（被跟踪的文件）不覆盖，绝对路径和 `..` 不管。
- 返回 `setup`：项目有 setupCommand 且是新 worktree 时 `{ command, cwd: 工作区目录 }`。
- 进度事件：`worktree`（每个仓库一次）→ `copy-files`（复制了东西才发）→ `done`，带分支名，多仓库时带仓库名。
- 主目录工作区：每个项目最多一个，分支用当前检出的；不能传 branch。
- remove：`deleteFolder: false` 只从库里删；`true` 时有改动且没 `force` 抛 `dirty-worktree`（message 里是数量，detail 是文件列表），`force` 直接删；分支保留；主目录工作区不能删文件夹；目录已经被手动删掉时清掉 git 的登记。
- list：目录不在了 → missing；在终端里切了分支 → 跟着改。

## 测试

```bash
pnpm --filter @agentdeck/workspace-service test       # 真实 git（git-service）+ 临时目录 + 内存仓储（test/helpers.ts）
pnpm --filter @agentdeck/workspace-service typecheck
```

测试用内存仓储，行为和 store 一致（path 唯一、级联删除、主目录工作区唯一）；不能 import store（边界规则对测试文件同样生效）。

## 不许碰

- `packages/contracts`：意见写进 `packages/git-service/CONTRACT_NOTES.md`（线 3 共用一份）。
- 只能依赖 contracts 和 git-service；不依赖 store、ui、Electron。
