// CO0：overlaps 在真实的临时仓库上跑：几个 worktree 两两比重叠，并确认没有碰工作区、index、stash 列表和任何 ref。

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AgentDeckError, WorkspaceId } from '@agentdeck/contracts';
import { createTempRepo, type TempRepo } from '@agentdeck/fakes/temp-repo';
import { afterEach, describe, expect, it } from 'vitest';
import { hasMergeTreeWriteTree, parseGitVersion, parseMergeTreeNames } from '../src/overlaps.ts';
import { TEST_ENV, makeGit } from './helpers.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

const LINES = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
const text = (lines: string[]) => `${lines.join('\n')}\n`;
const edit = (at: number, value: string) => text(LINES.map((l, i) => (i + 1 === at ? value : l)));

async function repo(): Promise<TempRepo> {
  const r = await createTempRepo({
    commits: [{ subject: 'Base', files: { 'src/config.ts': text(LINES), 'README.md': '# Temp\n' } }],
    branches: [],
  });
  cleanups.push(() => r.cleanup());
  return r;
}

function gitIn(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, env: TEST_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
}

/** 只读地问 git（不让 status 顺手刷新 index，免得量的时候自己改了它）。 */
function peekIn(dir: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir,
    env: { ...TEST_ENV, GIT_OPTIONAL_LOCKS: '0' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
}

function commitIn(dir: string, files: Record<string, string>, subject = 'Change'): void {
  for (const [p, c] of Object.entries(files)) writeFileSync(join(dir, p), c);
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-q', '-m', subject);
}

const A = 'ws-a' as WorkspaceId;
const B = 'ws-b' as WorkspaceId;
const C = 'ws-c' as WorkspaceId;

/** 记下一个 worktree 里所有 overlaps 不该碰的东西。 */
function fingerprint(r: TempRepo, dirs: string[]) {
  return {
    refs: peekIn(r.path, 'for-each-ref', '--format=%(refname) %(objectname)'),
    stash: peekIn(r.path, 'stash', 'list'),
    trees: dirs.map((d) => {
      const index = resolve(d, peekIn(d, 'rev-parse', '--git-path', 'index'));
      const st = statSync(index);
      return {
        indexMtime: st.mtimeMs,
        index: readFileSync(index).toString('base64'),
        status: peekIn(d, 'status', '--porcelain=v2', '--untracked-files=all'),
        staged: peekIn(d, 'diff', '--cached', '--name-status'),
        head: peekIn(d, 'rev-parse', 'HEAD'),
        files: peekIn(d, 'ls-files', '-s'),
      };
    }),
  };
}

describe('overlaps', () => {
  it('says a file changed in different places on both sides merges cleanly', async () => {
    const r = await repo();
    const a = r.addWorktree('feat/a', { create: true });
    const b = r.addWorktree('feat/b', { create: true });
    commitIn(a, { 'src/config.ts': edit(3, 'changed in a') });
    commitIn(b, { 'src/config.ts': edit(25, 'changed in b') });
    const { git } = makeGit();
    const res = await git.overlaps(r.path, [
      { workspaceId: A, path: a },
      { workspaceId: B, path: b },
    ]);
    expect(res).toEqual([{ a: A, b: B, files: [{ path: 'src/config.ts', verdict: 'clean' }], checkedAt: expect.any(String) }]);
  });

  it('says the same lines changed on both sides will conflict, uncommitted changes included', async () => {
    const r = await repo();
    const a = r.addWorktree('feat/a', { create: true });
    const b = r.addWorktree('feat/b', { create: true });
    commitIn(a, { 'src/config.ts': edit(10, 'a says ten') });
    // b 没提交：一处改动暂存了，一个新文件没跟踪
    writeFileSync(join(b, 'src/config.ts'), edit(10, 'b says ten'));
    gitIn(b, 'add', 'src/config.ts');
    writeFileSync(join(b, 'notes.txt'), 'scratch\n');
    const { git } = makeGit();
    const [o] = await git.overlaps(r.path, [
      { workspaceId: A, path: a },
      { workspaceId: B, path: b },
    ]);
    expect(o?.files).toEqual([{ path: 'src/config.ts', verdict: 'conflict' }]);
  });

  it('flags a file both sides created with different contents', async () => {
    const r = await repo();
    const a = r.addWorktree('feat/a', { create: true });
    const b = r.addWorktree('feat/b', { create: true });
    writeFileSync(join(a, 'src/limiter.ts'), 'export const limit = 10;\n'); // 没跟踪
    commitIn(b, { 'src/limiter.ts': 'export const limit = 20;\n', 'src/config.ts': edit(1, 'only b') });
    const { git } = makeGit();
    const [o] = await git.overlaps(r.path, [
      { workspaceId: A, path: a },
      { workspaceId: B, path: b },
    ]);
    expect(o?.files).toEqual([{ path: 'src/limiter.ts', verdict: 'conflict' }]);
  });

  it('skips worktrees without changes, pairs without shared files and branches already merged into the other', async () => {
    const r = await repo();
    const a = r.addWorktree('feat/a', { create: true });
    const b = r.addWorktree('feat/b', { create: true });
    const c = r.addWorktree('feat/c', { create: true });
    commitIn(a, { 'src/config.ts': edit(2, 'a') });
    commitIn(c, { 'README.md': '# Only c\n' });
    const { git } = makeGit();
    // b 没有改动；a 和 c 改的文件不重叠
    expect(
      await git.overlaps(r.path, [
        { workspaceId: A, path: a },
        { workspaceId: B, path: b },
        { workspaceId: C, path: c },
      ]),
    ).toEqual([]);

    // b 把 a 合进来以后又改了同一个文件：a 已经在 b 里，不比
    gitIn(b, 'merge', '-q', '--no-edit', 'feat/a');
    commitIn(b, { 'src/config.ts': edit(2, 'b rewrote a') });
    expect(
      await git.overlaps(r.path, [
        { workspaceId: A, path: a },
        { workspaceId: B, path: b },
      ]),
    ).toEqual([]);
  });

  it('compares the main folder with a worktree', async () => {
    const r = await repo();
    const a = r.addWorktree('feat/a', { create: true });
    commitIn(a, { 'src/config.ts': edit(5, 'a') });
    writeFileSync(join(r.path, 'src/config.ts'), edit(5, 'main, not committed'));
    const { git } = makeGit();
    const res = await git.overlaps(r.path, [
      { workspaceId: A, path: r.path },
      { workspaceId: B, path: a },
    ]);
    expect(res.map((o) => [o.a, o.b, o.files])).toEqual([[A, B, [{ path: 'src/config.ts', verdict: 'conflict' }]]]);
  });

  it('only lists shared files with verdict unknown on git older than 2.38', async () => {
    const r = await repo();
    const a = r.addWorktree('feat/a', { create: true });
    const b = r.addWorktree('feat/b', { create: true });
    commitIn(a, { 'src/config.ts': edit(10, 'a'), 'README.md': '# a\n' });
    writeFileSync(join(b, 'src/config.ts'), edit(20, 'b'));
    const { git } = makeGit({ gitVersion: 'git version 2.37.3 (Apple Git-140)' });
    const [o] = await git.overlaps(r.path, [
      { workspaceId: A, path: a },
      { workspaceId: B, path: b },
    ]);
    expect(o?.files).toEqual([{ path: 'src/config.ts', verdict: 'unknown' }]);
  });

  it('leaves the working trees, the index, the stash list and every ref as they were', async () => {
    const r = await repo();
    const a = r.addWorktree('feat/a', { create: true });
    const b = r.addWorktree('feat/b', { create: true });
    commitIn(a, { 'src/config.ts': edit(10, 'a') });
    // a 还有暂存了一半的改动；b 有暂存的、没暂存的和未跟踪的
    writeFileSync(join(a, 'README.md'), '# staged in a\n');
    gitIn(a, 'add', 'README.md');
    writeFileSync(join(a, 'README.md'), '# then edited again in a\n');
    writeFileSync(join(b, 'src/config.ts'), edit(10, 'b'));
    gitIn(b, 'add', 'src/config.ts');
    writeFileSync(join(b, 'README.md'), '# b\n');
    writeFileSync(join(b, 'scratch.txt'), 'untracked\n');
    // 有一条用户自己的 stash：列表不能变
    writeFileSync(join(r.path, 'README.md'), '# stashed by the user\n');
    r.git('stash', 'push', '-q', '-m', 'mine');
    peekIn(r.path, 'status');
    const before = fingerprint(r, [r.path, a, b]);
    const objectsBefore = r.git('count-objects', '-v');

    const { git } = makeGit();
    const res = await git.overlaps(r.path, [
      { workspaceId: A, path: a },
      { workspaceId: B, path: b },
      { workspaceId: C, path: r.path },
    ]);
    expect(res).toEqual([
      {
        a: A,
        b: B,
        files: [
          { path: 'README.md', verdict: 'conflict' },
          { path: 'src/config.ts', verdict: 'conflict' },
        ],
        checkedAt: expect.any(String),
      },
    ]);
    expect(fingerprint(r, [r.path, a, b])).toEqual(before);
    // 只往对象库里加了临时对象（这就是代价），没有别的变化
    expect(r.git('count-objects', '-v')).not.toBe(objectsBefore);
  });

  it('gives the same snapshot for the same changes, so results can be cached', async () => {
    const r = await repo();
    const a = r.addWorktree('feat/a', { create: true });
    const b = r.addWorktree('feat/b', { create: true });
    writeFileSync(join(a, 'src/config.ts'), edit(4, 'a'));
    writeFileSync(join(b, 'src/config.ts'), edit(28, 'b'));
    const { git } = makeGit();
    const list = [
      { workspaceId: A, path: a },
      { workspaceId: B, path: b },
    ];
    const first = await git.overlaps(r.path, list);
    const second = await git.overlaps(r.path, list);
    expect(second.map((o) => o.files)).toEqual(first.map((o) => o.files));
    expect(first[0]?.files).toEqual([{ path: 'src/config.ts', verdict: 'clean' }]);
    // 改动变了，结论跟着变
    writeFileSync(join(b, 'src/config.ts'), edit(4, 'b too'));
    expect((await git.overlaps(r.path, list))[0]?.files).toEqual([{ path: 'src/config.ts', verdict: 'conflict' }]);
  });

  it('refuses more than 12 worktrees and ignores folders that are gone', async () => {
    const r = await repo();
    const { git } = makeGit();
    const many = Array.from({ length: 13 }, (_, i) => ({ workspaceId: `w${i}` as WorkspaceId, path: r.path }));
    const err = await git.overlaps(r.path, many).catch((e: AgentDeckError) => e);
    expect((err as AgentDeckError).code).toBe('invalid-argument');
    expect(
      await git.overlaps(r.path, [
        { workspaceId: A, path: r.path },
        { workspaceId: B, path: join(r.path, '..', 'no-such-worktree') },
      ]),
    ).toEqual([]);
  });
});

describe('overlap helpers', () => {
  it('reads the git version', () => {
    expect(parseGitVersion('git version 2.50.1 (Apple Git-155)')).toEqual([2, 50]);
    expect(parseGitVersion('nonsense')).toBeNull();
    expect(hasMergeTreeWriteTree([2, 38])).toBe(true);
    expect(hasMergeTreeWriteTree([2, 37])).toBe(false);
    expect(hasMergeTreeWriteTree([3, 0])).toBe(true);
    expect(hasMergeTreeWriteTree(null)).toBe(false);
  });

  it('reads conflicted files from merge-tree -z output', () => {
    expect(parseMergeTreeNames('b13b861c\0g\0n\0')).toEqual(['g', 'n']);
    expect(parseMergeTreeNames('b13b861c\0a b.ts\0a b.ts\0\0Auto-merging\0')).toEqual(['a b.ts']);
    expect(parseMergeTreeNames('b13b861c\0')).toEqual([]);
  });
});
