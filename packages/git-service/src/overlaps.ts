// CO0：同一仓库的几个 worktree 两两算重叠（两边都改了哪些文件、git 能不能自动合）。需求见设计画布“多 agent 防覆盖”页 O1 第 3 节。
//
// 只读：不碰工作区、index、stash 列表，不写任何 ref。
//   1. 每个 worktree 拍快照：没改动就是 HEAD；有改动时把它的 index 复制到临时文件（GIT_INDEX_FILE），add -A、write-tree、
//      commit-tree -p HEAD。会往对象库里写临时对象（blob、tree、一个没有任何 ref 指着的提交），git gc 会清掉。
//      快照提交的作者、时间固定，同样的改动得到同样的提交 id，结果才能按快照缓存。
//   2. 两两比：merge-base 是其中一边（已经合进另一边）的不比；两边相对合并基点都改了的文件取交集；
//      git ≥ 2.38 用 merge-tree --write-tree --name-only 在内存里合一遍，退出码 0 = 能自动合，1 = 冲突（带冲突文件）。
//      更老的 git 没有 --write-tree，只给交集，结论写 unknown。

import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AbsPath, OverlapVerdict, WorkspaceId, WorkspaceOverlap } from '@agentdeck/contracts';
import { AgentDeckError } from '@agentdeck/contracts';
import type { RunOptions, RunResult } from './run.ts';

export type GitRun = (cwd: AbsPath, args: string[], opts?: RunOptions) => Promise<RunResult>;

/** 同一仓库最多比几个 worktree（66 对）。 */
export const MAX_OVERLAP_WORKTREES = 12;

/** 快照提交固定的作者和时间：同一个 tree + 父提交得到同一个提交 id。 */
const SNAPSHOT_ENV: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: 'AgentDeck',
  GIT_AUTHOR_EMAIL: 'agentdeck@localhost',
  GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'AgentDeck',
  GIT_COMMITTER_EMAIL: 'agentdeck@localhost',
  GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
};

/** 同时跑几条 git（快照、两两比较各自限流）。 */
const CONCURRENCY = 4;

/** 缓存多少对的结果（按两边快照的提交 id）。 */
const CACHE_LIMIT = 512;

/** `git --version` 的输出 → [主版本, 次版本]；认不出时返回 null。 */
export function parseGitVersion(out: string): [number, number] | null {
  const m = /(\d+)\.(\d+)/.exec(out);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** merge-tree --write-tree 是 2.38 加的。 */
export function hasMergeTreeWriteTree(version: [number, number] | null): boolean {
  if (!version) return false;
  const [major, minor] = version;
  return major > 2 || (major === 2 && minor >= 38);
}

/** `merge-tree --write-tree --name-only --no-messages -z` 的输出：第一段是合出来的 tree，后面是冲突文件。 */
export function parseMergeTreeNames(out: string): string[] {
  const parts = out.split('\0');
  const names: string[] = [];
  for (const p of parts.slice(1)) {
    if (p === '') break; // 有 messages 时它们在一个空段之后；--no-messages 时没有
    if (!names.includes(p)) names.push(p);
  }
  return names;
}

type PairFiles = { path: string; verdict: OverlapVerdict }[];

export class OverlapChecker {
  private readonly cache = new Map<string, PairFiles>();

  constructor(
    private readonly git: GitRun,
    private readonly mergeTree: () => Promise<boolean>,
    private readonly longTimeoutMs: number,
  ) {}

  async overlaps(repo: AbsPath, worktrees: { workspaceId: WorkspaceId; path: AbsPath }[]): Promise<WorkspaceOverlap[]> {
    if (worktrees.length > MAX_OVERLAP_WORKTREES)
      throw new AgentDeckError({
        code: 'invalid-argument',
        message: `Too many worktrees to compare (${worktrees.length}, at most ${MAX_OVERLAP_WORKTREES})`,
      });
    if (worktrees.length < 2) return [];
    const canMerge = await this.mergeTree();
    // 目录已经没了的 worktree 不比（工作区还在白板上、文件夹被手动删了）
    const live = worktrees.filter((w) => existsSync(w.path));
    const snaps = await limit(live, CONCURRENCY, (w) => this.snapshot(w.path));
    const sides = live.flatMap((w, i) => {
      const commit = snaps[i];
      return commit ? [{ id: w.workspaceId, commit }] : [];
    });

    const pairs: [(typeof sides)[number], (typeof sides)[number]][] = [];
    for (let i = 0; i < sides.length; i += 1)
      for (let j = i + 1; j < sides.length; j += 1) pairs.push([sides[i]!, sides[j]!]);

    const checkedAt = new Date().toISOString();
    const results = await limit(pairs, CONCURRENCY, ([a, b]) => this.pair(repo, a.commit, b.commit, canMerge));
    const out: WorkspaceOverlap[] = [];
    pairs.forEach(([a, b], k) => {
      const files = results[k];
      if (files && files.length > 0) out.push({ a: a.id, b: b.id, files: files.map((f) => ({ ...f })), checkedAt });
    });
    return out;
  }

  /** 一个 worktree 现在的样子（含没提交的改动、未跟踪文件）当成一个提交。还没有提交的仓库返回 null。 */
  async snapshot(wt: AbsPath): Promise<string | null> {
    const head = (await this.git(wt, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { okCodes: [1] })).stdout.trim();
    if (!head) return null;
    // GIT_OPTIONAL_LOCKS=0：status 不顺手刷新 index（不写 index）
    const status = await this.git(wt, ['status', '--porcelain', '-z', '--untracked-files=all'], { env: { GIT_OPTIONAL_LOCKS: '0' } });
    if (status.stdout === '') return head;

    const dir = await mkdtemp(join(tmpdir(), 'agentdeck-overlap-'));
    const index = join(dir, 'index');
    const env: NodeJS.ProcessEnv = { GIT_INDEX_FILE: index };
    try {
      const real = resolve(wt, (await this.git(wt, ['rev-parse', '--git-path', 'index'])).stdout.trim());
      // 复制现在的 index：里面有文件的 stat 信息，add -A 只重新读改过的文件；复制不了（还没有 index）就从 HEAD 建
      const copied = await copyFile(real, index).then(
        () => true,
        () => false,
      );
      const fromHead = async () => {
        await rm(index, { force: true });
        await this.git(wt, ['read-tree', head], { env });
      };
      if (!copied) await fromHead();
      try {
        await this.git(wt, ['add', '-A'], { env, timeoutMs: this.longTimeoutMs });
      } catch (e) {
        if (!copied) throw e;
        // 复制来的 index 用不了（例如 split index 的共享文件对不上）：从 HEAD 重建再来一次
        await fromHead();
        await this.git(wt, ['add', '-A'], { env, timeoutMs: this.longTimeoutMs });
      }
      const tree = (await this.git(wt, ['write-tree'], { env })).stdout.trim();
      const headTree = (await this.git(wt, ['rev-parse', `${head}^{tree}`])).stdout.trim();
      if (tree === headTree) return head; // 只有被忽略的文件、或者改了又改回去
      const commit = await this.git(wt, ['commit-tree', '--no-gpg-sign', '-p', head, '-m', 'AgentDeck overlap snapshot', tree], {
        env: SNAPSHOT_ENV,
      });
      return commit.stdout.trim();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** 一对快照：两边都改了的文件和结论；已经合进另一边、没有共同历史、没有重叠时返回 null。 */
  private async pair(repo: AbsPath, a: string, b: string, canMerge: boolean): Promise<PairFiles | null> {
    if (a === b) return null;
    const key = `${a}\0${b}\0${canMerge ? 'm' : 'n'}`;
    const hit = this.cache.get(key);
    if (hit) {
      // 用到的挪到最后，超出上限时先删最久没用的
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const base = (await this.git(repo, ['merge-base', a, b], { okCodes: [1] })).stdout.trim();
    if (!base || base === a || base === b) return null;
    const [ours, theirs] = await Promise.all([this.changed(repo, base, a), this.changed(repo, base, b)]);
    const both = new Set([...ours].filter((p) => theirs.has(p)));
    let conflicted = new Set<string>();
    if (canMerge) {
      const r = await this.git(repo, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', a, b], {
        okCodes: [1],
        timeoutMs: this.longTimeoutMs,
      });
      if (r.code === 1) conflicted = new Set(parseMergeTreeNames(r.stdout));
    }
    const files: PairFiles = [...new Set([...both, ...conflicted])].sort().map((path) => ({
      path,
      verdict: !canMerge ? 'unknown' : conflicted.has(path) ? 'conflict' : 'clean',
    }));
    this.cache.set(key, files);
    if (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value as string);
    return files;
  }

  /** from → to 改了的文件。不认改名：改名的两边路径都算，另一边改了旧路径时也算重叠。 */
  private async changed(repo: AbsPath, from: string, to: string): Promise<Set<string>> {
    const out = await this.git(repo, ['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', from, to]);
    return new Set(out.stdout.split('\0').filter(Boolean));
  }
}

/** 最多 n 个同时跑，结果按原来的顺序。 */
async function limit<T, R>(items: readonly T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}
