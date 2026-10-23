// Git：直接调用系统的 git 命令，不监听文件。需求见「8 · 源代码管理面板」。
// 实现：packages/git-service（线 3），运行在主进程，命令在子进程里跑，不阻塞。
// 所有方法的第一个参数都是仓库目录（一个 worktree 的路径）。多仓库工作区由调用方按仓库各调一次。

import type { AbsPath, IsoTime } from './common.ts';

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
  lastCommitAt: IsoTime | null;
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
}

export type SwitchStrategy =
  /** 带着改动切（git 允许时）。 */
  | 'carry'
  /** 先 stash，切回来时提示恢复。 */
  | 'stash';

export interface GitService {
  status(repo: AbsPath): Promise<RepoStatus>;
  stage(repo: AbsPath, paths: string[]): Promise<void>;
  unstage(repo: AbsPath, paths: string[]): Promise<void>;
  /** 已跟踪文件还原；未跟踪文件移到废纸篓。确认由界面负责。 */
  discard(repo: AbsPath, paths: string[]): Promise<void>;
  /** all=true：没有暂存时提交全部改动（Commit all n changes）。 */
  commit(repo: AbsPath, message: string, opts: { all: boolean }): Promise<CommitInfo>;
  branches(repo: AbsPath): Promise<BranchInfo[]>;
  switchBranch(repo: AbsPath, branch: string, strategy: SwitchStrategy): Promise<void>;
  createBranch(repo: AbsPath, name: string, opts: { from?: string; switchTo: boolean }): Promise<void>;
  /** 当前分支上、不在基础分支里的提交，加基础分支最近的几条。 */
  log(repo: AbsPath, limit: number): Promise<CommitInfo[]>;
  /** 统一 diff 文本。staged=true 时比较暂存区和 HEAD。 */
  diff(repo: AbsPath, path: string, opts: { staged: boolean }): Promise<string>;

  // 以下给 workspace-service 用
  worktrees(repo: AbsPath): Promise<WorktreeInfo[]>;
  addWorktree(repo: AbsPath, path: AbsPath, branch: { name: string; create: boolean; from?: string }): Promise<void>;
  removeWorktree(repo: AbsPath, path: AbsPath, opts: { force: boolean }): Promise<void>;
  /** 这个目录在不在 git 仓库里，在的话返回仓库根目录。 */
  repoRoot(dir: AbsPath): Promise<AbsPath | null>;
  defaultBranch(repo: AbsPath): Promise<string>;
  init(dir: AbsPath): Promise<void>;
}

export type GitEvent =
  /** 某个仓库的状态刷新了。触发时机：切换聚焦、agent 一轮结束、用户自己的 git 操作、手动刷新。 */
  | { type: 'git.status'; status: RepoStatus }
  /** 刷新超过 1 秒，界面显示 Refreshing…。 */
  | { type: 'git.refreshing'; repo: AbsPath };
