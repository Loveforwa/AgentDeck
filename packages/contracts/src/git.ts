// Git：直接调用系统的 git 命令，不监听文件。需求见「8 · 源代码管理面板」。
// 实现：packages/git-service（线 3），运行在主进程，命令在子进程里跑，不阻塞。
// 所有方法的第一个参数都是仓库目录（一个 worktree 的路径）。多仓库工作区由调用方按仓库各调一次。

import type { AbsPath, IsoTime, WorkspaceId } from './common.ts';

/** 对应 git status --porcelain=v2 的 X / Y 字段。 */
export type ChangeKind = 'unmodified' | 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'ignored';

export interface FileChange {
  /** 相对仓库根目录。 */
  path: string;
  /** 重命名前的路径。 */
  fromPath: string | null;
  /** 暂存区相对 HEAD。 */
  staged: ChangeKind;
  /** 工作区相对暂存区。 */
  unstaged: ChangeKind;
  conflicted: boolean;
  /** 是子模块（MVP 只显示为一条 Submodule changed）。 */
  submodule: boolean;
}

export type RepoOperation = 'none' | 'merge' | 'rebase' | 'cherry-pick' | 'revert';

export interface RepoStatus {
  repo: AbsPath;
  /** 分离 HEAD 时为 null。 */
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** 相对项目基础分支。 */
  aheadOfBase: number;
  baseBranch: string | null;
  operation: RepoOperation;
  files: FileChange[];
  at: IsoTime;
}

export interface BranchInfo {
  name: string;
  current: boolean;
  /** 已经在某个 worktree 里检出时是那个目录；分支下拉里灰显。 */
  checkedOutAt: AbsPath | null;
  /** 远端分支时是远端名（例如 'origin'），name 不带远端前缀；本地分支为 null 或不填。 */
  remote?: string | null;
  lastCommitAt: IsoTime | null;
  /** 已经合并进 branches(…, { mergedInto }) 给的分支（分支顶端是它的祖先）。没传 mergedInto 时不填。提交图据此把旧分支收成一行（N5）。 */
  merged?: boolean;
}

export interface WorktreeInfo {
  path: AbsPath;
  branch: string | null;
  head: string;
  main: boolean;
}

export interface CommitInfo {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  at: IsoTime;
  /** 是否已在基础分支上（提交列表里“On main”分隔线以下）。 */
  onBase: boolean;
  /** 父提交的完整哈希，第一个是第一父提交；根提交是空数组；合并提交有两个以上。旧实现不填（N5 提交图把列表当成一条直线）。 */
  parents?: string[];
  /** 指着这个提交的引用（git log 的 %D）。旧实现不填。 */
  refs?: CommitRef[];
  /** 这个提交改了哪些文件（相对第一父提交；根提交相对空树）。只在 log 传了 opts.commit 时填。 */
  files?: CommitFile[];
}

export interface CommitRef {
  /** 本地分支不带 refs/heads/（feat/login）；远端分支带远端名（origin/main）；标签是标签名；分离 HEAD 是 'HEAD'。 */
  name: string;
  kind: 'branch' | 'remote' | 'tag' | 'head';
  /** 这个仓库目录的 HEAD 指着这个分支（git 显示成 HEAD -> main）。 */
  current?: boolean;
}

export interface CommitFile {
  /** 相对仓库根目录。 */
  path: string;
  /** 重命名、复制前的路径。 */
  fromPath: string | null;
  kind: ChangeKind;
}

/** log 的选项（N5）。graph、commit 都不传时和原来一样：`<base>..HEAD` 加基础分支上的几条。 */
export interface LogOptions extends StatusOptions {
  /**
   * 提交图：几个分支（加上 HEAD）的提交按拓扑顺序（新的在前，子提交一定在父提交前面），最多 limit 条，都带 parents 和 refs。
   * branches 不传时是所有本地分支；传了时只看这几个（不存在的跳过），例如 [当前分支, 基础分支]。onBase 仍按基础分支算。
   */
  graph?: { branches?: string[] };
  /** 只取这一个提交（哈希或引用），带上 parents、refs 和 files，忽略 graph。找不到时抛 not-found。 */
  commit?: string;
}

export interface StashInfo {
  /** git 的 stash 引用，例如 'stash@{0}'。apply 后其他条目的编号会变，用前重新取列表。 */
  id: string;
  /** 存的时候所在的分支。 */
  branch: string | null;
  message: string;
  at: IsoTime;
  /** 是 AgentDeck 切分支时用 'stash' 存的（不是用户自己在终端里 git stash 的）。切回来时只对这种提示恢复。 */
  byAgentDeck?: boolean;
}

export interface StatusOptions {
  /** 计算 aheadOfBase、onBase 用的基础分支。不传时用 defaultBranch(repo)。项目设置里改过基础分支时由调用方传入。 */
  baseBranch?: string;
}

export type SwitchStrategy =
  /** 带着改动切（git 允许时）。 */
  | 'carry'
  /** 先 stash，切回来时提示恢复。 */
  | 'stash';

/**
 * 事件：git-service 通过构造参数里的 emit 发 git.status / git.refreshing（status 超过 1 秒先发 refreshing，结束发 status）。
 * 写操作之后不自动发 status，由调用方（面板）再调一次 status。
 */
export interface GitService {
  status(repo: AbsPath, opts?: StatusOptions): Promise<RepoStatus>;
  /** 路径不存在时抛 git-failed，detail 是 git 原话（pathspec did not match）。unstage、discard 同样。 */
  stage(repo: AbsPath, paths: string[]): Promise<void>;
  unstage(repo: AbsPath, paths: string[]): Promise<void>;
  /**
   * 放弃更改，确认由界面负责。照 VS Code：有没暂存的改动 → 工作区还原成暂存区；只有暂存的改动 → 暂存区和工作区都还原成 HEAD；
   * 新加进暂存区的文件 → 拿出暂存区并移到废纸篓；未跟踪文件 → 移到废纸篓；冲突 → 还原成 HEAD。
   */
  discard(repo: AbsPath, paths: string[]): Promise<void>;
  /**
   * all=true：先暂存全部改动（含未跟踪文件）再提交，面板只在没有暂存时这样调（Commit all n changes）。
   * 没有可提交的内容时抛 git-failed，detail 是 git 原话（nothing to commit）。
   */
  commit(repo: AbsPath, message: string, opts: { all: boolean }): Promise<CommitInfo>;
  /**
   * 默认只有本地分支；remote=true 时加上远端分支（已有同名本地分支的不重复列）。
   * mergedInto（分支名，解析规则同基础分支）：给每个分支填 merged；这个分支不存在时 merged 都是 false（N5）。
   */
  branches(repo: AbsPath, opts?: { remote?: boolean; mergedInto?: string }): Promise<BranchInfo[]>;
  /** branch 是远端分支名时（没有同名本地分支）建一个跟踪它的本地分支再切过去，和 git switch 一样。 */
  switchBranch(repo: AbsPath, branch: string, strategy: SwitchStrategy): Promise<void>;
  createBranch(repo: AbsPath, name: string, opts: { from?: string; switchTo: boolean }): Promise<void>;
  /** 分支正在某个 worktree 里检出时抛 branch-in-use；没合并且 force=false 时抛 git-failed。workspace-service 回滚时也用它。 */
  deleteBranch(repo: AbsPath, name: string, opts: { force: boolean }): Promise<void>;
  /** 新的在前。切分支时用 'stash' 存下的改动，切回来时界面据此提示恢复。 */
  stashes(repo: AbsPath): Promise<StashInfo[]>;
  /** 恢复一条 stash。drop=true 时恢复成功后删掉它（相当于 pop）。有冲突时抛 git-failed，改动留在工作区。 */
  applyStash(repo: AbsPath, id: string, opts: { drop: boolean }): Promise<void>;
  /**
   * `<base>..HEAD` 的提交（onBase=false），加上从 HEAD 和基础分支的合并基点往前的几条（onBase=true，至少 3 条，总数不超过 limit）。
   * 基础分支名先找本地分支，再找 origin/<名字>。
   * opts.graph：提交图；opts.commit：只取一个提交并带上它改的文件（见 LogOptions，N5）。
   */
  log(repo: AbsPath, limit: number, opts?: LogOptions): Promise<CommitInfo[]>;
  /** 统一 diff 文本。staged=true 时比较暂存区和 HEAD。 */
  diff(repo: AbsPath, path: string, opts: { staged: boolean }): Promise<string>;

  // 以下给 workspace-service 用
  worktrees(repo: AbsPath): Promise<WorktreeInfo[]>;
  addWorktree(repo: AbsPath, path: AbsPath, branch: { name: string; create: boolean; from?: string }): Promise<void>;
  removeWorktree(repo: AbsPath, path: AbsPath, opts: { force: boolean }): Promise<void>;
  /** 这个目录在不在 git 仓库里，在的话返回仓库根目录。目录不存在时也返回 null，不抛错。 */
  repoRoot(dir: AbsPath): Promise<AbsPath | null>;
  /** 主仓库搬了位置以后修好各个 worktree 的指向（git worktree repair）。ProjectService.locate 会调用。 */
  repairWorktrees(repo: AbsPath): Promise<void>;
  defaultBranch(repo: AbsPath): Promise<string>;
  init(dir: AbsPath): Promise<void>;

  // 以下给代码锚点用（DC0 加，DC1 实现）。都只读。
  /**
   * 每行最后改它的提交（git blame --porcelain，只要每行的提交）。rev 不填是工作区（没提交的行 commit 为 40 个 0）。
   * line 从 1 起。文件不存在抛 not-found。
   */
  blameLines(repo: AbsPath, path: string, opts?: { rev?: string }): Promise<{ line: number; commit: string }[]>;
  /** 某个版本的文件全文（git show rev:path）；那个版本里没有这个文件返回 null。 */
  showFile(repo: AbsPath, rev: string, path: string): Promise<string | null>;
  /**
   * 行号映射：git diff -U0 --no-color -M from [to] -- path 的 @@ 头。to 为 'worktree' 时对工作区（含没提交的改动）。
   * 文件被改名时按改名后的路径给（hunk 里看不出新路径，调用方用 status / log 的改名找）。没有变化返回空数组。
   */
  lineMap(repo: AbsPath, path: string, from: string, to: 'worktree' | string): Promise<LineMapHunk[]>;

  /**
   * CO0：同一仓库的几个 worktree 两两算重叠（哪些文件两边都改了、git 能不能自动合）。只读：不碰工作区、index、stash 列表，不写 ref
   * （有改动的 worktree 用临时 GIT_INDEX_FILE 拍快照，会往对象库里写临时对象）。已经合进另一边的不比；没有重叠的一对不返回。
   * 最多 12 个 worktree，多了抛 invalid-argument。不监视文件，调用时机由调用方定（和 SCM 面板刷新同一套）。
   * worktrees 带上工作区 id：git-service 不认识工作区，结果按调用方给的 id 写。
   */
  overlaps(repo: AbsPath, worktrees: { workspaceId: WorkspaceId; path: AbsPath }[]): Promise<WorkspaceOverlap[]>;
}

/** CO0：重叠文件的结论。clean：两边都改了但 git 能自动合；conflict：会冲突；unknown：git 低于 2.38（没有 merge-tree --write-tree），只知道两边都改了。 */
export type OverlapVerdict = 'clean' | 'conflict' | 'unknown';

/** CO0：两个 worktree 的重叠。 */
export interface WorkspaceOverlap {
  a: WorkspaceId;
  b: WorkspaceId;
  /** 两边都改了的文件（相对仓库根目录）。 */
  files: { path: string; verdict: OverlapVerdict }[];
  checkedAt: IsoTime;
}

/** lineMap 的一段：旧文件从 oldStart 起的 oldLines 行变成新文件从 newStart 起的 newLines 行（同 @@ -a,b +c,d @@，行数 0 时 start 是前一行）。 */
export interface LineMapHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export type GitEvent =
  /** 某个仓库的状态刷新了。触发时机：切换聚焦、agent 一轮结束、用户自己的 git 操作、手动刷新。 */
  | { type: 'git.status'; status: RepoStatus }
  /** 刷新超过 1 秒，界面显示 Refreshing…。 */
  | { type: 'git.refreshing'; repo: AbsPath };
