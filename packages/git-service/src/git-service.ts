// GitService 的真实实现：每个方法拼一条（或几条）git 命令，在子进程里跑。
// 不监听文件；只在调用方要的时候跑 status。写操作按仓库排队，避免两条命令抢 index.lock。

import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  AbsPath,
  BranchInfo,
  CommitInfo,
  FileChange,
  GitEvent,
  GitService,
  RepoOperation,
  RepoStatus,
  StashInfo,
  StatusOptions,
  SwitchStrategy,
  WorktreeInfo,
} from '@agentdeck/contracts';
import { AgentDeckError } from '@agentdeck/contracts';
import {
  AGENTDECK_STASH_PREFIX,
  BRANCH_FORMAT,
  LOG_FORMAT,
  STASH_FORMAT,
  parseBranches,
  parseLog,
  parseStashes,
  parseStatusV2,
  parseWorktrees,
  type ParsedCommit,
} from './parse.ts';
import { GitCommandError, createRunner, type RunOptions, type RunResult, type Runner } from './run.ts';

export interface GitServiceOptions {
  /** 未跟踪文件 discard 时移到废纸篓。应用里是 Electron 的 shell.trashItem，由 apps/desktop 传进来。 */
  moveToTrash: (path: AbsPath) => Promise<void>;
  /** git 可执行文件，默认 'git'（在 env.PATH 里找）。 */
  gitPath?: string;
  /** 子进程环境，默认 process.env。应用里传登录 shell 的环境（docs/decisions.md）。 */
  env?: NodeJS.ProcessEnv;
  /** 读操作的超时，默认 30 秒。 */
  timeoutMs?: number;
  /** 会跑钩子或检出大量文件的操作（commit、switch、worktree add、stash）的超时，默认 5 分钟。 */
  longTimeoutMs?: number;
  /** 发 git.status / git.refreshing。不传就不发。 */
  emit?: (event: GitEvent) => void;
  /** status 超过这么久先发 git.refreshing，默认 1000。 */
  refreshingAfterMs?: number;
  /** log 里基础分支上至少带几条，默认 3。 */
  baseCommits?: number;
}

const STASH_ID = /^stash@\{\d+\}$/;

export function createGitService(opts: GitServiceOptions): GitService {
  return new SystemGitService(opts);
}

export class SystemGitService implements GitService {
  private readonly run: Runner;
  private readonly longTimeoutMs: number;
  private readonly refreshingAfterMs: number;
  private readonly baseCommits: number;
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly opts: GitServiceOptions) {
    this.run = createRunner({
      gitPath: opts.gitPath ?? 'git',
      env: opts.env ?? process.env,
      timeoutMs: opts.timeoutMs ?? 30_000,
    });
    this.longTimeoutMs = opts.longTimeoutMs ?? 300_000;
    this.refreshingAfterMs = opts.refreshingAfterMs ?? 1000;
    this.baseCommits = opts.baseCommits ?? 3;
  }

  // ---- 状态 ----

  async status(repo: AbsPath, opts?: StatusOptions): Promise<RepoStatus> {
    const timer = setTimeout(() => this.opts.emit?.({ type: 'git.refreshing', repo }), this.refreshingAfterMs);
    try {
      const [raw, operation, baseBranch] = await Promise.all([
        // 只读：不抢 index.lock，agent 同时在跑 git 也不冲突
        this.git(repo, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'], {
          env: { GIT_OPTIONAL_LOCKS: '0' },
        }),
        this.operation(repo),
        opts?.baseBranch ?? this.defaultBranch(repo),
      ]);
      const parsed = parseStatusV2(raw.stdout);
      let aheadOfBase = 0;
      if (parsed.head) {
        const baseRef = await this.resolveRef(repo, baseBranch);
        if (baseRef) aheadOfBase = Number((await this.git(repo, ['rev-list', '--count', `${baseRef}..HEAD`])).stdout.trim()) || 0;
      }
      const status: RepoStatus = {
        repo,
        branch: parsed.branch,
        head: parsed.head,
        upstream: parsed.upstream,
        ahead: parsed.ahead,
        behind: parsed.behind,
        aheadOfBase,
        baseBranch,
        operation,
        files: sortConflictsFirst(parsed.files.filter((f) => f.unstaged !== 'ignored')),
        at: new Date().toISOString(),
      };
      this.opts.emit?.({ type: 'git.status', status });
      return status;
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- 暂存、放弃、提交 ----

  async stage(repo: AbsPath, paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.queue(repo, () => this.git(repo, ['add', '-A', '--', ...paths], LITERAL));
  }

  async unstage(repo: AbsPath, paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.queue(repo, async () => {
      if (!(await this.hasHead(repo))) {
        // 还没有提交：没有 HEAD 可还原，直接从 index 拿掉
        await this.git(repo, ['rm', '--cached', '-r', '-q', '--', ...paths], LITERAL);
        return;
      }
      // 重命名要连旧路径一起还原，否则旧文件的删除还留在暂存区
      // 看整个仓库：只看这几个路径的话 git 认不出重命名
      const files = await this.filesFor(repo, [], false);
      const all = new Set(paths);
      for (const f of files) if (all.has(f.path) && f.fromPath) all.add(f.fromPath);
      await this.git(repo, ['restore', '--staged', '--', ...all], LITERAL);
    });
  }

  async discard(repo: AbsPath, paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.queue(repo, async () => {
      const byPath = new Map((await this.filesFor(repo, paths, true)).map((f) => [f.path, f]));
      const fromIndex: string[] = []; // 工作区还原成暂存区的样子
      const fromHead: string[] = []; // 暂存区和工作区都还原成 HEAD
      const unindex: string[] = []; // 新加进暂存区的文件：拿出 index，文件进废纸篓
      const trash: string[] = [];
      for (const p of paths) {
        const f = byPath.get(p);
        if (!f) fromIndex.push(p); // 没改动或路径不存在：交给 git，不存在时它报 pathspec did not match
        else if (f.unstaged === 'untracked') trash.push(p);
        else if (f.conflicted) fromHead.push(p);
        else if (f.unstaged !== 'unmodified') fromIndex.push(p);
        else if (f.staged === 'added' || f.staged === 'copied') {
          unindex.push(p);
          trash.push(p);
        } else if (f.staged === 'renamed') {
          unindex.push(p);
          trash.push(p);
          if (f.fromPath) fromHead.push(f.fromPath);
        } else fromHead.push(p);
      }
      if (fromIndex.length) await this.git(repo, ['restore', '--worktree', '--', ...fromIndex], LITERAL);
      if (fromHead.length)
        await this.git(repo, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...fromHead], LITERAL);
      if (unindex.length) await this.git(repo, ['rm', '--cached', '-q', '--', ...unindex], LITERAL);
      for (const p of trash) {
        const full = join(repo, p);
        if (existsSync(full)) await this.opts.moveToTrash(full);
      }
    });
  }

  async commit(repo: AbsPath, message: string, opts: { all: boolean }): Promise<CommitInfo> {
    if (message.trim() === '') throw new AgentDeckError({ code: 'invalid-argument', message: 'Commit message is empty' });
    return this.queue(repo, async () => {
      if (opts.all) await this.git(repo, ['add', '-A']);
      // 信息从 stdin 给：多行、以 - 开头都没问题
      await this.git(repo, ['commit', '-q', '-F', '-'], { input: message, timeoutMs: this.longTimeoutMs });
      const [c] = parseLog((await this.git(repo, ['log', '-1', `--format=${LOG_FORMAT}`, 'HEAD'])).stdout);
      if (!c) throw new AgentDeckError({ code: 'internal', message: 'Committed, but could not read the commit' });
      const baseRef = await this.resolveRef(repo, await this.defaultBranch(repo));
      const onBase = baseRef ? await this.isAncestor(repo, c.hash, baseRef) : false;
      return toCommit(c, onBase);
    });
  }

  // ---- 分支 ----

  async branches(repo: AbsPath): Promise<BranchInfo[]> {
    const out = await this.git(repo, ['for-each-ref', '--sort=-committerdate', `--format=${BRANCH_FORMAT}`, 'refs/heads']);
    return parseBranches(out.stdout);
  }

  async switchBranch(repo: AbsPath, branch: string, strategy: SwitchStrategy): Promise<void> {
    checkName(branch);
    await this.queue(repo, async () => {
      await this.assertNotCheckedOutElsewhere(repo, branch);
      const current = await this.currentBranch(repo);
      if (current === branch) return;
      if (strategy === 'carry') {
        await this.switchTo(repo, branch);
        return;
      }
      const before = await this.stashTop(repo);
      await this.git(repo, ['stash', 'push', '--include-untracked', '-m', `${AGENTDECK_STASH_PREFIX}switched to ${branch}`], {
        timeoutMs: this.longTimeoutMs,
      });
      const stashed = (await this.stashTop(repo)) !== before;
      try {
        await this.switchTo(repo, branch);
      } catch (e) {
        // 没切过去：把刚存的改动放回来，当作什么都没发生
        if (stashed) await this.git(repo, ['stash', 'pop', '-q'], { timeoutMs: this.longTimeoutMs }).catch(() => undefined);
        throw e;
      }
    });
  }

  async createBranch(repo: AbsPath, name: string, opts: { from?: string; switchTo: boolean }): Promise<void> {
    await this.queue(repo, async () => {
      await this.assertNewBranchName(repo, name);
      const from = opts.from === undefined ? [] : [await this.resolveRefOrThrow(repo, opts.from)];
      // --no-track：从 origin/main 分出时不要把上游设成 main，免得 push 推到 main 上
      if (opts.switchTo)
        await this.git(repo, ['switch', '--no-track', '-c', name, ...from], { timeoutMs: this.longTimeoutMs });
      else await this.git(repo, ['branch', '--no-track', name, ...from]);
    });
  }

  async deleteBranch(repo: AbsPath, name: string, opts: { force: boolean }): Promise<void> {
    checkName(name);
    await this.queue(repo, async () => {
      const wt = (await this.worktrees(repo)).find((w) => w.branch === name);
      if (wt) throw branchInUse(name, wt.path);
      if (!(await this.refExists(repo, `refs/heads/${name}`)))
        throw new AgentDeckError({ code: 'not-found', message: `Branch ${name} not found` });
      await this.git(repo, ['branch', opts.force ? '-D' : '-d', name]);
    });
  }

  // ---- stash ----

  async stashes(repo: AbsPath): Promise<StashInfo[]> {
    return parseStashes((await this.git(repo, ['stash', 'list', `--format=${STASH_FORMAT}`])).stdout);
  }

  async applyStash(repo: AbsPath, id: string, opts: { drop: boolean }): Promise<void> {
    if (!STASH_ID.test(id)) throw new AgentDeckError({ code: 'invalid-argument', message: `Not a stash: ${id}` });
    await this.queue(repo, async () => {
      await this.git(repo, ['stash', 'apply', id], { timeoutMs: this.longTimeoutMs });
      if (opts.drop) await this.git(repo, ['stash', 'drop', '-q', id]);
    });
  }

  // ---- 提交记录、差异 ----

  async log(repo: AbsPath, limit: number, opts?: StatusOptions): Promise<CommitInfo[]> {
    if (limit <= 0 || !(await this.hasHead(repo))) return [];
    const baseRef = await this.resolveRef(repo, opts?.baseBranch ?? (await this.defaultBranch(repo)));
    const logOf = async (range: string[], n: number): Promise<ParsedCommit[]> =>
      n <= 0 ? [] : parseLog((await this.git(repo, ['log', `-n${n}`, `--format=${LOG_FORMAT}`, ...range, '--'])).stdout);
    if (!baseRef) return (await logOf(['HEAD'], limit)).map((c) => toCommit(c, false));

    const own = await logOf([`${baseRef}..HEAD`], limit);
    const mergeBase = await this.git(repo, ['merge-base', 'HEAD', baseRef], { okCodes: [1] });
    const baseTip = mergeBase.stdout.trim();
    const onBase = baseTip ? await logOf([baseTip], Math.max(limit - own.length, Math.min(this.baseCommits, limit))) : [];
    return [...own.map((c) => toCommit(c, false)), ...onBase.map((c) => toCommit(c, true))];
  }

  async diff(repo: AbsPath, path: string, opts: { staged: boolean }): Promise<string> {
    const common = ['--no-color', '--no-ext-diff'];
    if (opts.staged) return (await this.git(repo, ['diff', '--cached', ...common, '--', path], LITERAL)).stdout;
    const out = (await this.git(repo, ['diff', ...common, '--', path], LITERAL)).stdout;
    if (out !== '') return out;
    // 未跟踪的文件 git diff 不管，和 /dev/null 比
    const untracked = await this.git(repo, ['ls-files', '--others', '--exclude-standard', '--', path], LITERAL);
    if (untracked.stdout.trim() === '') return '';
    return (await this.git(repo, ['diff', '--no-index', ...common, '--', '/dev/null', path], { okCodes: [1] })).stdout;
  }

  // ---- worktree，给 workspace-service 用 ----

  async worktrees(repo: AbsPath): Promise<WorktreeInfo[]> {
    return parseWorktrees((await this.git(repo, ['worktree', 'list', '--porcelain', '-z'])).stdout);
  }

  async addWorktree(repo: AbsPath, path: AbsPath, branch: { name: string; create: boolean; from?: string }): Promise<void> {
    await this.queue(repo, async () => {
      if (branch.create) {
        await this.assertNewBranchName(repo, branch.name);
        const from = branch.from === undefined ? [] : [await this.resolveRefOrThrow(repo, branch.from)];
        await this.git(repo, ['worktree', 'add', '-q', '--no-track', '-b', branch.name, path, ...from], {
          timeoutMs: this.longTimeoutMs,
        });
        return;
      }
      checkName(branch.name);
      if (!(await this.refExists(repo, `refs/heads/${branch.name}`)))
        throw new AgentDeckError({ code: 'not-found', message: `Branch ${branch.name} not found` });
      await this.assertNotCheckedOutElsewhere(repo, branch.name, null);
      await this.git(repo, ['worktree', 'add', '-q', path, branch.name], { timeoutMs: this.longTimeoutMs });
    });
  }

  async removeWorktree(repo: AbsPath, path: AbsPath, opts: { force: boolean }): Promise<void> {
    await this.queue(repo, async () => {
      if (!existsSync(path)) {
        // 目录已经被删掉：清掉 git 里的登记，分支就不再算“已检出”
        await this.git(repo, ['worktree', 'prune']);
        return;
      }
      try {
        await this.git(repo, ['worktree', 'remove', ...(opts.force ? ['--force'] : []), path], {
          timeoutMs: this.longTimeoutMs,
        });
      } catch (e) {
        if (e instanceof GitCommandError && /contains modified or untracked files/.test(e.stderr))
          throw new AgentDeckError({ code: 'dirty-worktree', message: 'The worktree has uncommitted changes', detail: e.stderr.trim() });
        if (e instanceof GitCommandError && /is not a working tree/.test(e.stderr))
          throw new AgentDeckError({ code: 'not-found', message: `Not a worktree: ${path}`, detail: e.stderr.trim() });
        throw e;
      }
    });
  }

  async repoRoot(dir: AbsPath): Promise<AbsPath | null> {
    if (!existsSync(dir)) return null;
    try {
      const out = await this.run(dir, ['rev-parse', '--show-toplevel']);
      const root = out.stdout.trim();
      return root === '' ? null : root;
    } catch (e) {
      if (e instanceof GitCommandError && /not a git repository|must be run in a work tree/.test(e.stderr)) return null;
      throw e;
    }
  }

  async defaultBranch(repo: AbsPath): Promise<string> {
    const out = await this.git(repo, [
      'for-each-ref',
      '--format=%(refname)%00%(symref)',
      'refs/remotes/origin/HEAD',
      'refs/heads/main',
      'refs/heads/master',
      'refs/remotes/origin/main',
      'refs/remotes/origin/master',
    ]);
    const refs = new Map(
      out.stdout
        .split('\n')
        .filter(Boolean)
        .map((l) => l.split('\0') as [string, string]),
    );
    const remoteHead = refs.get('refs/remotes/origin/HEAD');
    if (remoteHead?.startsWith('refs/remotes/origin/')) return remoteHead.slice('refs/remotes/origin/'.length);
    if (refs.has('refs/heads/main') || refs.has('refs/remotes/origin/main')) return 'main';
    if (refs.has('refs/heads/master') || refs.has('refs/remotes/origin/master')) return 'master';
    // 都没有（刚 init、或者用别的名字）：用当前分支
    return (await this.currentBranch(repo)) ?? 'main';
  }

  async repairWorktrees(repo: AbsPath): Promise<void> {
    // 主仓库搬家后，worktree 里的 .git 文件还指向旧位置；不带参数的 repair 修不到它们，要把每个 worktree 的路径传进去
    const others = (await this.worktrees(repo)).filter((w) => !w.main && existsSync(w.path)).map((w) => w.path);
    await this.queue(repo, () => this.git(repo, ['worktree', 'repair', ...others]));
  }

  async init(dir: AbsPath): Promise<void> {
    await this.git(dir, ['init', '-q']);
  }

  // ---- 内部 ----

  /** 跑一条 git；“不是仓库”统一成 not-a-git-repo。 */
  private async git(repo: AbsPath, args: string[], opts?: RunOptions): Promise<RunResult> {
    try {
      return await this.run(repo, args, opts);
    } catch (e) {
      if (e instanceof GitCommandError && /not a git repository/.test(e.stderr))
        throw new AgentDeckError({ code: 'not-a-git-repo', message: `Not a Git repository: ${repo}`, detail: e.stderr.trim() });
      throw e;
    }
  }

  /** 同一个仓库目录的写操作一条一条来。 */
  private queue<T>(repo: AbsPath, fn: () => Promise<T>): Promise<T> {
    const key = resolve(repo);
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(key, settled);
    void settled.then(() => {
      if (this.queues.get(key) === settled) this.queues.delete(key);
    });
    return next;
  }

  private async operation(repo: AbsPath): Promise<RepoOperation> {
    // 每个 worktree 有自己的 git 目录（.git/worktrees/<名字>），合并状态记在那里
    const gitDir = (await this.git(repo, ['rev-parse', '--absolute-git-dir'])).stdout.trim();
    if (existsSync(join(gitDir, 'MERGE_HEAD'))) return 'merge';
    if (existsSync(join(gitDir, 'rebase-merge')) || existsSync(join(gitDir, 'rebase-apply'))) return 'rebase';
    if (existsSync(join(gitDir, 'CHERRY_PICK_HEAD'))) return 'cherry-pick';
    if (existsSync(join(gitDir, 'REVERT_HEAD'))) return 'revert';
    return 'none';
  }

  private async filesFor(repo: AbsPath, paths: string[], untracked: boolean): Promise<FileChange[]> {
    const out = await this.git(
      repo,
      ['status', '--porcelain=v2', '-z', untracked ? '--untracked-files=all' : '--untracked-files=no', ...(paths.length ? ['--', ...paths] : [])],
      { env: { GIT_OPTIONAL_LOCKS: '0', ...LITERAL.env } },
    );
    return parseStatusV2(out.stdout).files;
  }

  private async hasHead(repo: AbsPath): Promise<boolean> {
    return (await this.git(repo, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { okCodes: [1] })).code === 0;
  }

  private async currentBranch(repo: AbsPath): Promise<string | null> {
    const out = await this.git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { okCodes: [1] });
    return out.code === 0 ? out.stdout.trim() : null;
  }

  private async refExists(repo: AbsPath, ref: string): Promise<boolean> {
    return (await this.git(repo, ['show-ref', '--verify', '--quiet', ref], { okCodes: [1] })).code === 0;
  }

  private async stashTop(repo: AbsPath): Promise<string> {
    return (await this.git(repo, ['rev-parse', '-q', '--verify', 'refs/stash'], { okCodes: [1] })).stdout.trim();
  }

  private async isAncestor(repo: AbsPath, commit: string, of: string): Promise<boolean> {
    return (await this.git(repo, ['merge-base', '--is-ancestor', commit, of], { okCodes: [1] })).code === 0;
  }

  /** 基础分支名 → 能用的引用：本地分支，其次 origin/ 上的同名分支，再次原样（标签、哈希、origin/main）。 */
  private async resolveRef(repo: AbsPath, name: string | null): Promise<string | null> {
    if (!name || name.startsWith('-')) return null;
    for (const ref of [`refs/heads/${name}`, `refs/remotes/origin/${name}`]) if (await this.refExists(repo, ref)) return ref;
    const out = await this.git(repo, ['rev-parse', '--verify', '-q', `${name}^{commit}`], { okCodes: [1] });
    return out.code === 0 ? out.stdout.trim() : null;
  }

  private async resolveRefOrThrow(repo: AbsPath, name: string): Promise<string> {
    const ref = await this.resolveRef(repo, name);
    if (!ref) throw new AgentDeckError({ code: 'not-found', message: `Branch ${name} not found` });
    return ref;
  }

  private async assertNewBranchName(repo: AbsPath, name: string): Promise<void> {
    checkName(name);
    const ok = await this.git(repo, ['check-ref-format', '--branch', name], { okCodes: [1, 128] });
    if (ok.code !== 0) throw new AgentDeckError({ code: 'invalid-argument', message: `Invalid branch name: ${name}` });
    if (await this.refExists(repo, `refs/heads/${name}`))
      throw new AgentDeckError({ code: 'branch-exists', message: `Branch ${name} already exists` });
  }

  /** repo 自己检出它不算占用；except 传 null 时任何 worktree 检出都算。 */
  private async assertNotCheckedOutElsewhere(repo: AbsPath, branch: string, except: AbsPath | null = repo): Promise<void> {
    const wt = (await this.worktrees(repo)).find((w) => w.branch === branch && (except === null || !samePath(w.path, except)));
    if (wt) throw branchInUse(branch, wt.path);
  }

  private async switchTo(repo: AbsPath, branch: string): Promise<void> {
    try {
      await this.git(repo, ['switch', '-q', branch], { timeoutMs: this.longTimeoutMs });
    } catch (e) {
      if (!(e instanceof GitCommandError)) throw e;
      if (/would be overwritten by checkout|Please commit your changes or stash them/.test(e.stderr))
        throw new AgentDeckError({
          code: 'dirty-worktree',
          message: `Your changes conflict with ${branch}`,
          detail: e.stderr.trim(),
        });
      if (/invalid reference|did not match any file/.test(e.stderr))
        throw new AgentDeckError({ code: 'not-found', message: `Branch ${branch} not found`, detail: e.stderr.trim() });
      if (/already (used by worktree|checked out) at/.test(e.stderr))
        throw new AgentDeckError({ code: 'branch-in-use', message: `Branch ${branch} is checked out in another folder`, detail: e.stderr.trim() });
      throw e;
    }
  }
}

/** 涉及路径的命令按字面匹配：文件名里的 * [ ] 不当通配符。 */
const LITERAL: RunOptions & { env: NodeJS.ProcessEnv } = { env: { GIT_LITERAL_PATHSPECS: '1' } };

function checkName(name: string): void {
  if (name.trim() === '' || name.startsWith('-'))
    throw new AgentDeckError({ code: 'invalid-argument', message: `Invalid branch name: ${name}` });
}

function branchInUse(branch: string, path: AbsPath): AgentDeckError {
  return new AgentDeckError({ code: 'branch-in-use', message: `Branch ${branch} is checked out in ${path}` });
}

function toCommit(c: ParsedCommit, onBase: boolean): CommitInfo {
  return { hash: c.hash, shortHash: c.shortHash, subject: c.subject, author: c.author, at: c.at, onBase };
}

/** 冲突文件排最前，其余保持 git 的顺序（按路径）。 */
function sortConflictsFirst(files: FileChange[]): FileChange[] {
  return [...files.filter((f) => f.conflicted), ...files.filter((f) => !f.conflicted)];
}

export function samePath(a: AbsPath, b: AbsPath): boolean {
  return canonical(a) === canonical(b);
}

function canonical(p: AbsPath): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}
