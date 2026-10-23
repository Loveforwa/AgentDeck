// GitService 的内存假实现：仓库、分支、worktree、文件改动都在内存里，不碰磁盘。
// 要真实 git 行为（给线 3 的真实实现做集成测试）用 ./temp-repo.ts 的 createTempRepo()。

import type {
  AbsPath,
  AgentDeckErrorData,
  BranchInfo,
  ChangeKind,
  CommitInfo,
  ErrorCode,
  FileChange,
  GitService,
  IsoTime,
  RepoOperation,
  RepoStatus,
  SwitchStrategy,
  WorktreeInfo,
} from '@agentdeck/contracts';
import { AgentDeckError } from '@agentdeck/contracts';
import { FakeEventBus } from './bus.ts';
import { clone, fail, isSameOrInside, nowIso, sleep } from './util.ts';

export interface FakeChangeInit {
  path: string;
  fromPath?: string | null;
  /** 默认 'unmodified'。 */
  staged?: ChangeKind;
  /** 默认 'modified'（staged 也没给时）或 'unmodified'。 */
  unstaged?: ChangeKind;
  conflicted?: boolean;
  submodule?: boolean;
  /** 自定义 diff 文本；不给就生成一段假的。 */
  diff?: string;
  stagedDiff?: string;
}

export interface FakeCommitInit {
  subject: string;
  author?: string;
  at?: IsoTime;
}

export interface FakeRepoInit {
  /** 主 worktree 的路径。 */
  path: AbsPath;
  /** 默认 'main'。 */
  defaultBranch?: string;
  /** 默认分支上的提交，旧的在前。默认 ['Initial commit']；给空数组表示刚 init、还没有提交。 */
  commits?: (string | FakeCommitInit)[];
  branches?: { name: string; from?: string; commits?: (string | FakeCommitInit)[] }[];
  /** 主 worktree 检出的分支，默认 defaultBranch。 */
  branch?: string;
  changes?: FakeChangeInit[];
  worktrees?: { path: AbsPath; branch: string; changes?: FakeChangeInit[] }[];
  /** 按分支设置上游和 ahead / behind。 */
  tracking?: Record<string, { upstream: string; ahead?: number; behind?: number }>;
}

export interface FakeStash {
  branch: string | null;
  files: FileChange[];
  at: IsoTime;
}

export interface FakeGitServiceOptions {
  bus?: FakeEventBus;
  /** 每个方法先等这么久，演示 Refreshing… 用。status() 超过 1000 时先发 git.refreshing。 */
  latencyMs?: number;
}

interface Commit {
  hash: string;
  subject: string;
  author: string;
  at: IsoTime;
  parent: string | null;
}

interface Change extends FileChange {
  diff?: string;
  stagedDiff?: string;
}

interface Tree {
  path: AbsPath;
  main: boolean;
  branch: string | null;
  /** 分离 HEAD 时的提交。 */
  detachedHead: string | null;
  changes: Map<string, Change>;
  operation: RepoOperation;
}

interface Repo {
  defaultBranch: string;
  /** 默认等于 defaultBranch，setBaseBranch 可改，见 CONTRACT_NOTES.md。 */
  baseBranch: string;
  commits: Map<string, Commit>;
  /** 分支名 → 提交；还没有提交时为 null。 */
  branches: Map<string, string | null>;
  trees: Map<AbsPath, Tree>;
  tracking: Map<string, { upstream: string; ahead: number; behind: number }>;
  stashes: FakeStash[];
}

type Method = keyof GitService;

const BASE_LOG_COUNT = 5;
const AUTHOR = 'You';
const SEED_EPOCH = Date.parse('2026-10-20T09:00:00Z');

export class FakeGitService implements GitService {
  readonly bus: FakeEventBus;
  private readonly latencyMs: number;
  private readonly repos: Repo[] = [];
  private readonly faults = new Map<Method, AgentDeckErrorData[]>();
  private hashCounter = 0;
  private seedClock = 0;
  /** discard 移到废纸篓的未跟踪文件，绝对路径。 */
  readonly trashed: AbsPath[] = [];

  constructor(opts: FakeGitServiceOptions = {}) {
    this.bus = opts.bus ?? new FakeEventBus();
    this.latencyMs = opts.latencyMs ?? 0;
  }

  // ---- 预置数据 ----

  addRepo(init: FakeRepoInit): this {
    if (this.findTree(init.path, true)) fail('invalid-argument', `A repo already exists at ${init.path}`);
    const defaultBranch = init.defaultBranch ?? 'main';
    const repo: Repo = {
      defaultBranch,
      baseBranch: defaultBranch,
      commits: new Map(),
      branches: new Map(),
      trees: new Map(),
      tracking: new Map(),
      stashes: [],
    };
    let head: string | null = null;
    for (const c of init.commits ?? ['Initial commit']) head = this.addCommit(repo, head, c, true).hash;
    repo.branches.set(defaultBranch, head);
    for (const b of init.branches ?? []) {
      let bHead = b.from ? this.resolve(repo, b.from) : head;
      for (const c of b.commits ?? []) bHead = this.addCommit(repo, bHead, c, true).hash;
      repo.branches.set(b.name, bHead);
    }
    for (const [branch, t] of Object.entries(init.tracking ?? {})) {
      repo.tracking.set(branch, { upstream: t.upstream, ahead: t.ahead ?? 0, behind: t.behind ?? 0 });
    }
    const mainBranch = init.branch ?? defaultBranch;
    if (!repo.branches.has(mainBranch)) fail('not-found', `Branch ${mainBranch} not found`);
    repo.trees.set(init.path, this.newTree(init.path, true, mainBranch, init.changes));
    for (const w of init.worktrees ?? []) {
      if (!repo.branches.has(w.branch)) repo.branches.set(w.branch, head);
      repo.trees.set(w.path, this.newTree(w.path, false, w.branch, w.changes));
    }
    this.repos.push(repo);
    return this;
  }

  /** 整份替换一个 worktree 的改动，发 git.status（像用户在外面改了文件后刷新）。 */
  setChanges(path: AbsPath, changes: FakeChangeInit[]): void {
    const { tree } = this.locate(path);
    tree.changes = new Map(changes.map((c) => [c.path, toChange(c)]));
    this.emitStatus(path);
  }

  /** 加或覆盖几条改动，发 git.status。 */
  addChanges(path: AbsPath, ...changes: FakeChangeInit[]): void {
    const { tree } = this.locate(path);
    for (const c of changes) tree.changes.set(c.path, toChange(c));
    this.emitStatus(path);
  }

  setOperation(path: AbsPath, operation: RepoOperation): void {
    this.locate(path).tree.operation = operation;
    this.emitStatus(path);
  }

  setTracking(path: AbsPath, branch: string, t: { upstream: string; ahead?: number; behind?: number } | null): void {
    const { repo } = this.locate(path);
    if (t) repo.tracking.set(branch, { upstream: t.upstream, ahead: t.ahead ?? 0, behind: t.behind ?? 0 });
    else repo.tracking.delete(branch);
    this.emitStatus(path);
  }

  /** aheadOfBase 和 log 的 onBase 按这个分支算。 */
  setBaseBranch(path: AbsPath, branch: string): void {
    this.locate(path).repo.baseBranch = branch;
  }

  /** 下一次调用 method 时抛这个错误，演示错误提示用。可以排多个。 */
  failNext(method: Method, error: AgentDeckErrorData | ErrorCode): void {
    const data = typeof error === 'string' ? { code: error, message: `Fake ${method} failed` } : error;
    const queue = this.faults.get(method) ?? [];
    queue.push(data);
    this.faults.set(method, queue);
  }

  /** switchBranch(..., 'stash') 存下的改动，新的在前。 */
  stashes(path: AbsPath): FakeStash[] {
    return clone(this.locate(path).repo.stashes);
  }

  /** 所有仓库的主 worktree 路径。FakeProjectService 探测多仓库文件夹时用。 */
  repoPaths(): AbsPath[] {
    return this.repos.flatMap((r) => [...r.trees.values()].filter((t) => t.main).map((t) => t.path));
  }

  /** GitService 没有删分支的方法；假的 workspace 回滚时用它删掉刚建的分支，见 CONTRACT_NOTES.md。 */
  deleteBranch(path: AbsPath, branch: string): void {
    const { repo } = this.locate(path);
    if ([...repo.trees.values()].some((t) => t.branch === branch)) fail('branch-in-use', `Branch ${branch} is checked out`);
    repo.branches.delete(branch);
    repo.tracking.delete(branch);
  }

  /** 手动刷新：发一次 git.status。 */
  async refresh(path: AbsPath): Promise<RepoStatus> {
    return this.emitStatus(path);
  }

  // ---- GitService ----

  async status(repo: AbsPath): Promise<RepoStatus> {
    if (this.latencyMs >= 1000) this.bus.emit({ type: 'git.refreshing', repo });
    await this.enter('status');
    return this.buildStatus(repo);
  }

  async stage(repo: AbsPath, paths: string[]): Promise<void> {
    await this.enter('stage');
    const { tree } = this.locate(repo);
    for (const c of this.match(tree, paths)) {
      if (c.unstaged === 'unmodified') continue;
      const diff = c.diff;
      if (c.unstaged === 'untracked') c.staged = 'added';
      else if (c.unstaged === 'deleted') {
        if (c.staged === 'added') {
          tree.changes.delete(c.path);
          continue;
        }
        c.staged = 'deleted';
      } else if (c.unstaged === 'modified') {
        if (c.staged === 'unmodified') c.staged = 'modified';
      } else c.staged = c.unstaged;
      c.unstaged = 'unmodified';
      c.conflicted = false;
      if (diff !== undefined && c.stagedDiff === undefined) c.stagedDiff = diff;
      delete c.diff;
    }
    this.emitStatus(repo);
  }

  async unstage(repo: AbsPath, paths: string[]): Promise<void> {
    await this.enter('unstage');
    const { tree } = this.locate(repo);
    for (const c of this.match(tree, paths)) {
      if (c.staged === 'unmodified') continue;
      if (c.staged === 'added') {
        if (c.unstaged === 'deleted') {
          tree.changes.delete(c.path);
          continue;
        }
        c.unstaged = 'untracked';
      } else if (c.staged === 'renamed' || c.staged === 'copied') {
        tree.changes.delete(c.path);
        if (c.staged === 'renamed' && c.fromPath) {
          tree.changes.set(c.fromPath, toChange({ path: c.fromPath, unstaged: 'deleted' }));
        }
        tree.changes.set(c.path, toChange({ path: c.path, unstaged: 'untracked' }));
        continue;
      } else if (c.staged === 'deleted') {
        c.unstaged = 'deleted';
      } else if (c.unstaged === 'unmodified') {
        c.unstaged = 'modified';
      }
      c.staged = 'unmodified';
      if (c.stagedDiff !== undefined && c.diff === undefined) c.diff = c.stagedDiff;
      delete c.stagedDiff;
    }
    this.emitStatus(repo);
  }

  async discard(repo: AbsPath, paths: string[]): Promise<void> {
    await this.enter('discard');
    const { tree } = this.locate(repo);
    for (const c of this.match(tree, paths)) {
      if (c.unstaged === 'unmodified') continue;
      if (c.unstaged === 'untracked') {
        tree.changes.delete(c.path);
        this.trashed.push(`${tree.path}/${c.path}`);
        continue;
      }
      c.unstaged = 'unmodified';
      delete c.diff;
      if (c.staged === 'unmodified') tree.changes.delete(c.path);
    }
    this.emitStatus(repo);
  }

  async commit(repoPath: AbsPath, message: string, opts: { all: boolean }): Promise<CommitInfo> {
    await this.enter('commit');
    const { repo, tree } = this.locate(repoPath);
    if (!message.trim()) fail('invalid-argument', 'Commit message is empty');
    if ([...tree.changes.values()].some((c) => c.conflicted)) {
      fail('git-failed', 'Resolve conflicts before committing', 'error: Committing is not possible because you have unmerged files.');
    }
    let staged = [...tree.changes.values()].filter((c) => c.staged !== 'unmodified');
    if (staged.length === 0 && opts.all) {
      for (const c of tree.changes.values()) {
        if (c.unstaged === 'unmodified') continue;
        c.staged = c.unstaged === 'untracked' ? 'added' : c.unstaged;
        c.unstaged = 'unmodified';
      }
      staged = [...tree.changes.values()].filter((c) => c.staged !== 'unmodified');
    }
    if (staged.length === 0) fail('git-failed', 'Nothing to commit', 'nothing to commit, working tree clean');

    const commit = this.addCommit(repo, this.headOf(repo, tree), message.split('\n')[0] ?? message, false);
    if (tree.branch) repo.branches.set(tree.branch, commit.hash);
    else tree.detachedHead = commit.hash;
    for (const c of staged) {
      c.staged = 'unmodified';
      delete c.stagedDiff;
      if (c.unstaged === 'unmodified') tree.changes.delete(c.path);
    }
    const tracking = tree.branch ? repo.tracking.get(tree.branch) : undefined;
    if (tracking) tracking.ahead += 1;
    this.emitStatus(repoPath);
    return this.commitInfo(commit, tree.branch === repo.baseBranch);
  }

  async branches(repoPath: AbsPath): Promise<BranchInfo[]> {
    await this.enter('branches');
    const { repo, tree } = this.locate(repoPath);
    return [...repo.branches.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, hash]) => ({
        name,
        current: tree.branch === name,
        checkedOutAt: [...repo.trees.values()].find((t) => t.branch === name)?.path ?? null,
        lastCommitAt: hash ? (repo.commits.get(hash)?.at ?? null) : null,
      }));
  }

  async switchBranch(repoPath: AbsPath, branch: string, strategy: SwitchStrategy): Promise<void> {
    await this.enter('switchBranch');
    const { repo, tree } = this.locate(repoPath);
    this.doSwitch(repo, tree, branch, strategy);
    this.emitStatus(repoPath);
  }

  async createBranch(repoPath: AbsPath, name: string, opts: { from?: string; switchTo: boolean }): Promise<void> {
    await this.enter('createBranch');
    const { repo, tree } = this.locate(repoPath);
    checkBranchName(name);
    if (repo.branches.has(name)) fail('branch-exists', `Branch ${name} already exists`);
    repo.branches.set(name, opts.from ? this.resolve(repo, opts.from) : this.headOf(repo, tree));
    if (opts.switchTo) {
      this.doSwitch(repo, tree, name, 'carry');
      this.emitStatus(repoPath);
    }
  }

  async log(repoPath: AbsPath, limit: number): Promise<CommitInfo[]> {
    await this.enter('log');
    const { repo, tree } = this.locate(repoPath);
    const baseSet = this.ancestors(repo, repo.branches.get(repo.baseBranch) ?? null);
    const out: CommitInfo[] = [];
    let baseCount = 0;
    let hash = this.headOf(repo, tree);
    while (hash && out.length < limit) {
      const c = repo.commits.get(hash);
      if (!c) break;
      const onBase = baseSet.has(hash);
      if (onBase && tree.branch !== repo.baseBranch && baseCount++ >= BASE_LOG_COUNT) break;
      out.push(this.commitInfo(c, onBase));
      hash = c.parent;
    }
    return out;
  }

  async diff(repoPath: AbsPath, path: string, opts: { staged: boolean }): Promise<string> {
    await this.enter('diff');
    const { tree } = this.locate(repoPath);
    const c = tree.changes.get(path);
    if (!c) return '';
    const kind = opts.staged ? c.staged : c.unstaged;
    if (kind === 'unmodified' || kind === 'ignored') return '';
    return (opts.staged ? c.stagedDiff : c.diff) ?? fakeDiff(path, kind, c.fromPath);
  }

  async worktrees(repoPath: AbsPath): Promise<WorktreeInfo[]> {
    await this.enter('worktrees');
    const { repo } = this.locate(repoPath);
    return [...repo.trees.values()].map((t) => ({
      path: t.path,
      branch: t.branch,
      head: this.headOf(repo, t) ?? '0'.repeat(40),
      main: t.main,
    }));
  }

  async addWorktree(
    repoPath: AbsPath,
    path: AbsPath,
    branch: { name: string; create: boolean; from?: string },
  ): Promise<void> {
    await this.enter('addWorktree');
    const { repo, tree } = this.locate(repoPath);
    // 先查分支再查目录，分支的错误对用户更有用
    let start: string | null = null;
    if (branch.create) {
      checkBranchName(branch.name);
      if (repo.branches.has(branch.name)) fail('branch-exists', `Branch ${branch.name} already exists`);
      start = branch.from ? this.resolve(repo, branch.from) : this.headOf(repo, tree);
    } else {
      if (!repo.branches.has(branch.name)) fail('not-found', `Branch ${branch.name} not found`);
      this.checkNotCheckedOut(repo, branch.name, null);
    }
    if (this.repos.some((r) => r.trees.has(path))) fail('invalid-argument', `${path} is already a worktree`);
    if (branch.create) repo.branches.set(branch.name, start);
    repo.trees.set(path, this.newTree(path, false, branch.name));
  }

  async removeWorktree(repoPath: AbsPath, path: AbsPath, opts: { force: boolean }): Promise<void> {
    await this.enter('removeWorktree');
    const { repo } = this.locate(repoPath);
    const tree = repo.trees.get(path);
    if (!tree) fail('not-found', `No worktree at ${path}`);
    if (tree.main) fail('invalid-argument', 'The main worktree cannot be removed');
    if (tree.changes.size > 0 && !opts.force) {
      fail(
        'dirty-worktree',
        'This worktree has uncommitted changes',
        `fatal: '${path}' contains modified or untracked files, use --force to delete it`,
      );
    }
    repo.trees.delete(path);
  }

  async repoRoot(dir: AbsPath): Promise<AbsPath | null> {
    await this.enter('repoRoot');
    return this.findTree(dir, false)?.tree.path ?? null;
  }

  async defaultBranch(repoPath: AbsPath): Promise<string> {
    await this.enter('defaultBranch');
    return this.locate(repoPath).repo.defaultBranch;
  }

  async init(dir: AbsPath): Promise<void> {
    await this.enter('init');
    if (this.findTree(dir, true)) return; // git init 对已有仓库是无害的
    this.addRepo({ path: dir, commits: [] });
  }

  // ---- 内部 ----

  private async enter(method: Method): Promise<void> {
    if (this.latencyMs > 0) await sleep(this.latencyMs);
    const fault = this.faults.get(method)?.shift();
    if (fault) throw new AgentDeckError(fault);
  }

  private findTree(dir: AbsPath, exact: boolean): { repo: Repo; tree: Tree } | null {
    let best: { repo: Repo; tree: Tree } | null = null;
    for (const repo of this.repos) {
      for (const tree of repo.trees.values()) {
        const hit = exact ? tree.path === dir : isSameOrInside(dir, tree.path);
        if (hit && (!best || tree.path.length > best.tree.path.length)) best = { repo, tree };
      }
    }
    return best;
  }

  private locate(path: AbsPath): { repo: Repo; tree: Tree } {
    const found = this.findTree(path, false);
    if (!found) fail('not-a-git-repo', `${path} is not a git repository`);
    return found;
  }

  private newTree(path: AbsPath, main: boolean, branch: string, changes: FakeChangeInit[] = []): Tree {
    return {
      path,
      main,
      branch,
      detachedHead: null,
      changes: new Map(changes.map((c) => [c.path, toChange(c)])),
      operation: 'none',
    };
  }

  private addCommit(repo: Repo, parent: string | null, init: string | FakeCommitInit, seeded: boolean): Commit {
    const c = typeof init === 'string' ? { subject: init } : init;
    this.hashCounter += 1;
    const commit: Commit = {
      hash: fakeHash(this.hashCounter),
      subject: c.subject,
      author: c.author ?? AUTHOR,
      at: c.at ?? (seeded ? new Date(SEED_EPOCH + this.seedClock++ * 17 * 60_000).toISOString() : nowIso()),
      parent,
    };
    repo.commits.set(commit.hash, commit);
    return commit;
  }

  private headOf(repo: Repo, tree: Tree): string | null {
    return tree.branch ? (repo.branches.get(tree.branch) ?? null) : tree.detachedHead;
  }

  /** 分支名或提交（完整或前缀）。 */
  private resolve(repo: Repo, ref: string): string | null {
    if (repo.branches.has(ref)) return repo.branches.get(ref) ?? null;
    if (ref.length >= 4) {
      for (const hash of repo.commits.keys()) if (hash.startsWith(ref)) return hash;
    }
    fail('not-found', `Unknown branch or commit ${ref}`);
  }

  private ancestors(repo: Repo, hash: string | null): Set<string> {
    const set = new Set<string>();
    while (hash && !set.has(hash)) {
      set.add(hash);
      hash = repo.commits.get(hash)?.parent ?? null;
    }
    return set;
  }

  private checkNotCheckedOut(repo: Repo, branch: string, except: Tree | null): void {
    const other = [...repo.trees.values()].find((t) => t !== except && t.branch === branch);
    if (other) fail('branch-in-use', `Branch ${branch} is already checked out at ${other.path}`);
  }

  private doSwitch(repo: Repo, tree: Tree, branch: string, strategy: SwitchStrategy): void {
    if (!repo.branches.has(branch)) fail('not-found', `Branch ${branch} not found`);
    if (tree.branch === branch) return;
    this.checkNotCheckedOut(repo, branch, tree);
    if (strategy === 'carry' && [...tree.changes.values()].some((c) => c.conflicted)) {
      fail('dirty-worktree', 'Resolve conflicts before switching branches');
    }
    if (strategy === 'stash' && tree.changes.size > 0) {
      repo.stashes.unshift({ branch: tree.branch, files: [...tree.changes.values()].map(toFileChange), at: nowIso() });
      tree.changes.clear();
    }
    tree.branch = branch;
    tree.detachedHead = null;
    tree.operation = 'none';
  }

  private match(tree: Tree, paths: string[]): Change[] {
    const out = new Set<Change>();
    for (const p of paths) {
      const hits = [...tree.changes.values()].filter((c) => p === '.' || isSameOrInside(c.path, p.replace(/\/$/, '')));
      if (hits.length === 0) {
        fail('git-failed', `Path not found: ${p}`, `error: pathspec '${p}' did not match any file(s) known to git`);
      }
      for (const h of hits) out.add(h);
    }
    return [...out];
  }

  private buildStatus(path: AbsPath): RepoStatus {
    const { repo, tree } = this.locate(path);
    const head = this.headOf(repo, tree);
    const tracking = tree.branch ? repo.tracking.get(tree.branch) : undefined;
    const baseSet = this.ancestors(repo, repo.branches.get(repo.baseBranch) ?? null);
    let aheadOfBase = 0;
    for (const h of this.ancestors(repo, head)) if (!baseSet.has(h)) aheadOfBase += 1;
    return {
      repo: tree.path,
      branch: tree.branch,
      head,
      upstream: tracking?.upstream ?? null,
      ahead: tracking?.ahead ?? 0,
      behind: tracking?.behind ?? 0,
      aheadOfBase,
      baseBranch: repo.baseBranch,
      operation: tree.operation,
      files: [...tree.changes.values()].sort((a, b) => a.path.localeCompare(b.path)).map(toFileChange),
      at: nowIso(),
    };
  }

  private emitStatus(path: AbsPath): RepoStatus {
    const status = this.buildStatus(path);
    this.bus.emit({ type: 'git.status', status: clone(status) });
    return status;
  }

  private commitInfo(c: Commit, onBase: boolean): CommitInfo {
    return { hash: c.hash, shortHash: c.hash.slice(0, 7), subject: c.subject, author: c.author, at: c.at, onBase };
  }
}

function toChange(c: FakeChangeInit): Change {
  const staged = c.staged ?? 'unmodified';
  const change: Change = {
    path: c.path,
    fromPath: c.fromPath ?? null,
    staged,
    unstaged: c.unstaged ?? (staged === 'unmodified' ? 'modified' : 'unmodified'),
    conflicted: c.conflicted ?? false,
    submodule: c.submodule ?? false,
  };
  if (c.diff !== undefined) change.diff = c.diff;
  if (c.stagedDiff !== undefined) change.stagedDiff = c.stagedDiff;
  return change;
}

function toFileChange(c: Change): FileChange {
  return {
    path: c.path,
    fromPath: c.fromPath,
    staged: c.staged,
    unstaged: c.unstaged,
    conflicted: c.conflicted,
    submodule: c.submodule,
  };
}

function checkBranchName(name: string): void {
  if (!name || /\s|\.\.|^[-/]|\/$|[~^:?*[\\]/.test(name)) fail('invalid-argument', `Invalid branch name: ${name}`);
}

/** 确定性的 40 位十六进制假哈希。 */
function fakeHash(n: number): string {
  let x = (n * 2654435761) >>> 0;
  let out = '';
  while (out.length < 40) {
    x = (Math.imul(x ^ (x >>> 15), 2246822519) + 0x9e3779b9) >>> 0;
    out += x.toString(16).padStart(8, '0');
  }
  return out.slice(0, 40);
}

function fakeDiff(path: string, kind: ChangeKind, fromPath: string | null): string {
  const header = `diff --git a/${fromPath ?? path} b/${path}\n`;
  if (kind === 'added' || kind === 'untracked') {
    return `${header}new file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,3 @@\n+// ${path}\n+export const value = 1;\n+export default value;\n`;
  }
  if (kind === 'deleted') {
    return `${header}deleted file mode 100644\n--- a/${path}\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-// ${path}\n-export const value = 1;\n-export default value;\n`;
  }
  const rename = fromPath ? `rename from ${fromPath}\nrename to ${path}\n` : '';
  return `${header}${rename}--- a/${fromPath ?? path}\n+++ b/${path}\n@@ -1,3 +1,3 @@\n // ${path}\n-export const value = 1;\n+export const value = 2;\n export default value;\n`;
}
