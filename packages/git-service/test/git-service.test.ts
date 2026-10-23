// 在真实的临时仓库上跑 GitService（createTempRepo 来自 tools/fakes）。

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentDeckError } from '@agentdeck/contracts';
import { createTempRepo, type TempRepo } from '@agentdeck/fakes/temp-repo';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitService } from '../src/index.ts';
import { TEST_ENV, makeGit, tempDir } from './helpers.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

async function repo(opts: Parameters<typeof createTempRepo>[0] = {}): Promise<TempRepo> {
  const r = await createTempRepo(opts);
  cleanups.push(() => r.cleanup());
  return r;
}

function dir(): string {
  const d = tempDir();
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

async function rejection(p: Promise<unknown>): Promise<AgentDeckError> {
  try {
    await p;
  } catch (e) {
    return e as AgentDeckError;
  }
  throw new Error('expected the promise to reject');
}

describe('status', () => {
  it('lists added, modified and untracked files on a clean branch', async () => {
    const r = await repo({ dirty: true });
    const { git } = makeGit();
    const s = await git.status(r.path);
    expect(s).toMatchObject({ repo: r.path, branch: 'main', upstream: null, aheadOfBase: 0, baseBranch: 'main', operation: 'none' });
    expect(s.head).toBe(r.git('rev-parse', 'HEAD'));
    expect(s.files).toEqual([
      { path: 'README.md', fromPath: null, staged: 'unmodified', unstaged: 'modified', conflicted: false, submodule: false },
      { path: 'src/new-file.ts', fromPath: null, staged: 'added', unstaged: 'unmodified', conflicted: false, submodule: false },
      { path: 'notes.txt', fromPath: null, staged: 'unmodified', unstaged: 'untracked', conflicted: false, submodule: false },
    ]);
  });

  it('shows deletions, renames and files in untracked folders one by one', async () => {
    const r = await repo();
    r.git('mv', 'src/index.ts', 'src/main.ts');
    rmSync(join(r.path, 'package.json'));
    r.writeFile('docs/a b.md', 'a\n');
    r.writeFile('docs/c.md', 'c\n');
    const { git } = makeGit();
    const files = (await git.status(r.path)).files;
    expect(files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'package.json', unstaged: 'deleted' }),
        expect.objectContaining({ path: 'src/main.ts', fromPath: 'src/index.ts', staged: 'renamed' }),
        expect.objectContaining({ path: 'docs/a b.md', unstaged: 'untracked' }),
        expect.objectContaining({ path: 'docs/c.md', unstaged: 'untracked' }),
      ]),
    );
    expect(files).toHaveLength(4);
  });

  it('counts commits ahead of the base branch and ahead / behind the upstream', async () => {
    const r = await repo({ withRemote: true });
    r.commit('Local only');
    const { git } = makeGit();
    let s = await git.status(r.path);
    expect(s).toMatchObject({ upstream: 'origin/main', ahead: 1, behind: 0, aheadOfBase: 0 });

    r.git('switch', '-q', 'feature/login');
    r.commit('Second login commit');
    s = await git.status(r.path);
    expect(s).toMatchObject({ branch: 'feature/login', aheadOfBase: 2, baseBranch: 'main' });
    // 项目设置里改过基础分支
    s = await git.status(r.path, { baseBranch: 'feature/login' });
    expect(s).toMatchObject({ aheadOfBase: 0, baseBranch: 'feature/login' });
  });

  it('reports a merge in progress with conflicted files first', async () => {
    const r = await repo({ branches: [{ name: 'theirs', commits: [{ subject: 'Theirs', files: { 'src/index.ts': 'theirs\n' } }] }] });
    r.commit('Ours', { 'src/index.ts': 'ours\n', 'a.txt': 'a\n' });
    r.writeFile('z-untracked.txt', 'z\n');
    expect(() => r.git('merge', 'theirs')).toThrow();
    const { git } = makeGit();
    const s = await git.status(r.path);
    expect(s.operation).toBe('merge');
    expect(s.files[0]).toMatchObject({ path: 'src/index.ts', conflicted: true, staged: 'modified', unstaged: 'modified' });

    // 解决冲突、暂存、提交（面板上的 Complete merge）
    r.writeFile('src/index.ts', 'merged\n');
    await git.stage(r.path, ['src/index.ts']);
    await git.commit(r.path, 'Merge theirs', { all: false });
    const after = await git.status(r.path);
    expect(after.operation).toBe('none');
    expect(after.files.map((f) => f.path)).toEqual(['z-untracked.txt']);
  });

  it('reports a rebase in progress', async () => {
    const r = await repo({ branches: [{ name: 'theirs', commits: [{ subject: 'Theirs', files: { 'src/index.ts': 'theirs\n' } }] }] });
    r.commit('Ours', { 'src/index.ts': 'ours\n' });
    expect(() => r.git('rebase', 'theirs')).toThrow();
    const { git } = makeGit();
    expect((await git.status(r.path)).operation).toBe('rebase');
  });

  it('shows a changed submodule as a single entry', async () => {
    const lib = await repo({ branches: [] });
    const r = await repo();
    r.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib.path, 'vendor/lib');
    r.git('commit', '-q', '-m', 'Add submodule');
    writeFileSync(join(r.path, 'vendor/lib/README.md'), 'changed inside\n');
    writeFileSync(join(r.path, 'vendor/lib/extra.txt'), 'new inside\n');
    const { git } = makeGit();
    const files = (await git.status(r.path)).files;
    expect(files).toEqual([
      { path: 'vendor/lib', fromPath: null, staged: 'unmodified', unstaged: 'modified', conflicted: false, submodule: true },
    ]);
  });

  it('emits git.status, and git.refreshing when it runs long', async () => {
    const r = await repo();
    const { git, events } = makeGit({ refreshingAfterMs: 0 });
    await git.status(r.path);
    expect(events.map((e) => e.type)).toEqual(['git.refreshing', 'git.status']);
    const { git: quick, events: quickEvents } = makeGit();
    await quick.status(r.path);
    expect(quickEvents.map((e) => e.type)).toEqual(['git.status']);
  });

  it('works on a repository with no commits yet', async () => {
    const d = dir();
    const { git } = makeGit();
    await git.init(d);
    writeFileSync(join(d, 'a.txt'), 'a\n');
    const s = await git.status(d);
    expect(s).toMatchObject({ head: null, aheadOfBase: 0, files: [expect.objectContaining({ path: 'a.txt', unstaged: 'untracked' })] });
    expect(await git.log(d, 20)).toEqual([]);
    await git.stage(d, ['a.txt']);
    await git.unstage(d, ['a.txt']);
    expect((await git.status(d)).files[0]).toMatchObject({ unstaged: 'untracked' });
  });

  it('throws not-a-git-repo outside a repository', async () => {
    const { git } = makeGit();
    expect((await rejection(git.status(dir()))).code).toBe('not-a-git-repo');
  });
});

describe('stage, unstage, discard', () => {
  it('round-trips stage and unstage, including both sides of a rename', async () => {
    const r = await repo({ dirty: true });
    const { git } = makeGit();
    await git.stage(r.path, ['README.md', 'notes.txt']);
    let files = (await git.status(r.path)).files;
    expect(files.every((f) => f.unstaged === 'unmodified')).toBe(true);
    await git.unstage(r.path, ['README.md', 'notes.txt', 'src/new-file.ts']);
    files = (await git.status(r.path)).files;
    expect(files.map((f) => [f.path, f.staged, f.unstaged])).toEqual([
      ['README.md', 'unmodified', 'modified'],
      ['notes.txt', 'unmodified', 'untracked'],
      ['src/new-file.ts', 'unmodified', 'untracked'],
    ]);

    r.git('mv', 'package.json', 'pkg.json');
    await git.unstage(r.path, ['pkg.json']);
    files = (await git.status(r.path)).files;
    expect(files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'package.json', staged: 'unmodified', unstaged: 'deleted' }),
        expect.objectContaining({ path: 'pkg.json', unstaged: 'untracked' }),
      ]),
    );
  });

  it('stages a deletion and treats glob characters literally', async () => {
    const r = await repo();
    r.writeFile('a[1].txt', 'x\n');
    r.writeFile('a1.txt', 'y\n');
    rmSync(join(r.path, 'package.json'));
    const { git } = makeGit();
    await git.stage(r.path, ['a[1].txt', 'package.json']);
    const files = (await git.status(r.path)).files;
    expect(files.find((f) => f.path === 'a[1].txt')?.staged).toBe('added');
    expect(files.find((f) => f.path === 'a1.txt')?.unstaged).toBe('untracked');
    expect(files.find((f) => f.path === 'package.json')?.staged).toBe('deleted');
  });

  it('throws git-failed with git’s words for a path that does not exist', async () => {
    const r = await repo();
    const { git } = makeGit();
    for (const op of [git.stage, git.unstage, git.discard]) {
      const e = await rejection(op.call(git, r.path, ['no/such/file.ts']));
      expect(e.code).toBe('git-failed');
      expect(e.detail).toMatch(/pathspec .* did not match/);
    }
  });

  it('restores tracked files and moves untracked and newly added ones to the trash', async () => {
    const r = await repo({ dirty: true });
    rmSync(join(r.path, 'package.json'));
    r.writeFile('src/index.ts', 'staged edit\n');
    r.git('add', 'src/index.ts');
    const { git, trashed } = makeGit();
    await git.discard(r.path, ['README.md', 'notes.txt', 'package.json', 'src/new-file.ts', 'src/index.ts']);
    expect((await git.status(r.path)).files).toEqual([]);
    expect(readFileSync(join(r.path, 'README.md'), 'utf8')).toBe('# Temp repo\n');
    expect(readFileSync(join(r.path, 'src/index.ts'), 'utf8')).toBe('export const answer = 42;\n');
    expect(existsSync(join(r.path, 'package.json'))).toBe(true);
    expect(trashed.sort()).toEqual([join(r.path, 'notes.txt'), join(r.path, 'src/new-file.ts')]);
  });

  it('discards only the unstaged part when a file has both', async () => {
    const r = await repo();
    r.writeFile('README.md', 'staged\n');
    r.git('add', 'README.md');
    r.writeFile('README.md', 'staged then edited\n');
    const { git } = makeGit();
    await git.discard(r.path, ['README.md']);
    expect(readFileSync(join(r.path, 'README.md'), 'utf8')).toBe('staged\n');
    expect((await git.status(r.path)).files).toEqual([expect.objectContaining({ path: 'README.md', staged: 'modified', unstaged: 'unmodified' })]);
  });
});

describe('commit and log', () => {
  it('commits what is staged and returns the commit', async () => {
    const r = await repo({ dirty: true });
    const { git } = makeGit();
    const c = await git.commit(r.path, 'feat: add new file\n\nWith a body.', { all: false });
    expect(c).toMatchObject({ subject: 'feat: add new file', author: 'AgentDeck Test', onBase: true });
    expect(c.hash).toBe(r.git('rev-parse', 'HEAD'));
    expect(c.shortHash).toBe(r.git('rev-parse', '--short', 'HEAD'));
    expect(r.git('log', '-1', '--format=%B').trim()).toBe('feat: add new file\n\nWith a body.');
    // 没暂存的还在
    expect((await git.status(r.path)).files.map((f) => f.path)).toEqual(['README.md', 'notes.txt']);
  });

  it('commits everything, untracked files included, with all=true', async () => {
    const r = await repo({ dirty: true });
    const { git } = makeGit();
    await git.commit(r.path, '-leading dash is fine', { all: true });
    expect((await git.status(r.path)).files).toEqual([]);
    expect(r.git('log', '-1', '--format=%s')).toBe('-leading dash is fine');
    expect(r.git('show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual(['README.md', 'notes.txt', 'src/new-file.ts']);
  });

  it('rejects an empty message and says when there is nothing to commit', async () => {
    const r = await repo();
    const { git } = makeGit();
    expect((await rejection(git.commit(r.path, '  ', { all: true }))).code).toBe('invalid-argument');
    const e = await rejection(git.commit(r.path, 'Nothing', { all: true }));
    expect(e.code).toBe('git-failed');
    expect(e.detail).toMatch(/nothing to commit/);
  });

  it('shows the output of a failing pre-commit hook', async () => {
    const r = await repo({ dirty: true });
    const hook = join(r.path, '.git/hooks/pre-commit');
    writeFileSync(hook, '#!/bin/sh\necho "lint failed: src/new-file.ts" >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    const { git } = makeGit();
    const e = await rejection(git.commit(r.path, 'Blocked', { all: false }));
    expect(e).toMatchObject({ code: 'git-failed', detail: 'lint failed: src/new-file.ts' });
  });

  it('lists branch commits, then a few from the base branch', async () => {
    const r = await repo();
    r.git('switch', '-q', 'feature/login');
    r.commit('Login two');
    const { git } = makeGit();
    const log = await git.log(r.path, 20);
    expect(log.map((c) => [c.subject, c.onBase])).toEqual([
      ['Login two', false],
      ['Add login form', false],
      ['Add package.json', true],
      ['Add entry point', true],
      ['Initial commit', true],
    ]);
    expect((await git.log(r.path, 1)).map((c) => c.subject)).toEqual(['Login two', 'Add package.json']);
    // 在基础分支上：全部是 On main
    r.git('switch', '-q', 'main');
    expect((await git.log(r.path, 2)).map((c) => [c.subject, c.onBase])).toEqual([
      ['Add package.json', true],
      ['Add entry point', true],
    ]);
  });
});

describe('diff', () => {
  it('returns unified diffs for unstaged, staged and untracked files', async () => {
    const r = await repo({ dirty: true });
    const { git } = makeGit();
    const unstaged = await git.diff(r.path, 'README.md', { staged: false });
    expect(unstaged).toContain('diff --git a/README.md b/README.md');
    expect(unstaged).toContain('+Edited but not staged.');
    expect(unstaged).toBe(r.git('diff', '--no-color', '--', 'README.md') + '\n');
    expect(await git.diff(r.path, 'src/new-file.ts', { staged: true })).toContain('+export const added = true;');
    expect(await git.diff(r.path, 'src/new-file.ts', { staged: false })).toBe('');
    const untracked = await git.diff(r.path, 'notes.txt', { staged: false });
    expect(untracked).toContain('+untracked');
    expect(untracked).toContain('new file mode');
  });
});

describe('branches and switching', () => {
  it('lists local branches with where they are checked out', async () => {
    const r = await repo();
    const wt = r.addWorktree('feat/wt', { create: true });
    const { git } = makeGit();
    const list = await git.branches(r.path);
    expect(list.map((b) => b.name).sort()).toEqual(['feat/wt', 'feature/login', 'main']);
    expect(list.find((b) => b.name === 'main')).toMatchObject({ current: true, checkedOutAt: r.path });
    expect(list.find((b) => b.name === 'feat/wt')).toMatchObject({ current: false, checkedOutAt: wt });
    expect(list.find((b) => b.name === 'feature/login')).toMatchObject({ current: false, checkedOutAt: null });
    expect(list[0]?.lastCommitAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it('switches carrying changes, and refuses when they conflict', async () => {
    const r = await repo({ dirty: true });
    const { git } = makeGit();
    await git.switchBranch(r.path, 'feature/login', 'carry');
    const s = await git.status(r.path);
    expect(s.branch).toBe('feature/login');
    expect(s.files).toHaveLength(3);

    r.git('switch', '-q', '-f', 'main');
    r.git('clean', '-qfd');
    r.git('switch', '-q', '-c', 'other');
    r.commit('Other', { 'README.md': 'other\n' });
    r.git('switch', '-q', 'main');
    r.writeFile('README.md', 'local edit\n');
    const e = await rejection(git.switchBranch(r.path, 'other', 'carry'));
    expect(e.code).toBe('dirty-worktree');
    expect(e.detail).toMatch(/would be overwritten/);
    expect((await git.status(r.path)).branch).toBe('main');
  });

  it('stash and switch, then restore on the way back', async () => {
    const r = await repo({ dirty: true });
    const { git } = makeGit();
    await git.switchBranch(r.path, 'feature/login', 'stash');
    let s = await git.status(r.path);
    expect(s).toMatchObject({ branch: 'feature/login', files: [] });
    const stashes = await git.stashes(r.path);
    expect(stashes).toEqual([
      { id: 'stash@{0}', branch: 'main', message: 'AgentDeck: switched to feature/login', at: expect.stringMatching(/Z$/), byAgentDeck: true },
    ]);

    await git.switchBranch(r.path, 'main', 'carry');
    await git.applyStash(r.path, 'stash@{0}', { drop: true });
    s = await git.status(r.path);
    expect(s.files.map((f) => f.path).sort()).toEqual(['README.md', 'notes.txt', 'src/new-file.ts']);
    expect(await git.stashes(r.path)).toEqual([]);
  });

  it('stash and switch with nothing to stash just switches', async () => {
    const r = await repo();
    const { git } = makeGit();
    await git.switchBranch(r.path, 'feature/login', 'stash');
    expect((await git.status(r.path)).branch).toBe('feature/login');
    expect(await git.stashes(r.path)).toEqual([]);
  });

  it('puts the stash back when the switch fails', async () => {
    const r = await repo({ dirty: true });
    const { git } = makeGit();
    const e = await rejection(git.switchBranch(r.path, 'no-such-branch', 'stash'));
    expect(e.code).toBe('not-found');
    expect((await git.status(r.path)).files).toHaveLength(3);
    expect(await git.stashes(r.path)).toEqual([]);
  });

  it('keeps a conflicting stash in place and throws git-failed', async () => {
    const r = await repo();
    r.writeFile('README.md', 'stashed\n');
    r.git('stash', 'push', '-q', '-m', 'mine');
    r.commit('Change README', { 'README.md': 'committed\n' });
    const { git } = makeGit();
    const e = await rejection(git.applyStash(r.path, 'stash@{0}', { drop: true }));
    expect(e.code).toBe('git-failed');
    expect(e.detail).toMatch(/conflict/i);
    expect(await git.stashes(r.path)).toHaveLength(1);
    expect((await rejection(git.applyStash(r.path, '--evil', { drop: false }))).code).toBe('invalid-argument');
  });

  it('refuses to switch to a branch checked out in another worktree', async () => {
    const r = await repo();
    const wt = r.addWorktree('feature/login');
    const { git } = makeGit();
    const e = await rejection(git.switchBranch(r.path, 'feature/login', 'carry'));
    expect(e).toMatchObject({ code: 'branch-in-use', message: `Branch feature/login is checked out in ${wt}` });
  });

  it('creates branches from a ref, optionally switching to them', async () => {
    const r = await repo();
    const { git } = makeGit();
    await git.createBranch(r.path, 'feat/new', { switchTo: true });
    expect((await git.status(r.path)).branch).toBe('feat/new');
    await git.createBranch(r.path, 'feat/from-login', { from: 'feature/login', switchTo: false });
    expect(r.git('rev-parse', 'feat/from-login')).toBe(r.git('rev-parse', 'feature/login'));
    expect((await git.status(r.path)).branch).toBe('feat/new');
    expect((await rejection(git.createBranch(r.path, 'feat/new', { switchTo: false }))).code).toBe('branch-exists');
    expect((await rejection(git.createBranch(r.path, 'bad..name', { switchTo: false }))).code).toBe('invalid-argument');
    expect((await rejection(git.createBranch(r.path, 'x', { from: 'nope', switchTo: false }))).code).toBe('not-found');
  });

  it('deletes branches, refusing unmerged ones without force and checked-out ones always', async () => {
    const r = await repo();
    const { git } = makeGit();
    const e = await rejection(git.deleteBranch(r.path, 'feature/login', { force: false }));
    expect(e.code).toBe('git-failed');
    expect(e.detail).toMatch(/not fully merged/);
    await git.deleteBranch(r.path, 'feature/login', { force: true });
    expect(r.git('branch', '--list', 'feature/login')).toBe('');
    expect((await rejection(git.deleteBranch(r.path, 'main', { force: true }))).code).toBe('branch-in-use');
    expect((await rejection(git.deleteBranch(r.path, 'gone', { force: true }))).code).toBe('not-found');
  });
});

describe('worktrees', () => {
  it('adds and removes worktrees', async () => {
    const r = await repo();
    const { git } = makeGit();
    const root = dir();
    const a = join(root, 'proj', 'feat-a');
    await git.addWorktree(r.path, a, { name: 'feat/a', create: true });
    const b = join(root, 'proj', 'feature-login');
    await git.addWorktree(r.path, b, { name: 'feature/login', create: false });
    const list = await git.worktrees(r.path);
    expect(list).toEqual([
      { path: r.path, branch: 'main', head: r.git('rev-parse', 'HEAD'), main: true },
      { path: a, branch: 'feat/a', head: r.git('rev-parse', 'HEAD'), main: false },
      { path: b, branch: 'feature/login', head: r.git('rev-parse', 'feature/login'), main: false },
    ]);
    // 新分支不跟踪任何上游
    expect(() => r.git('config', '--get', 'branch.feat/a.merge')).toThrow();
    expect((await git.status(a)).branch).toBe('feat/a');

    writeFileSync(join(a, 'dirty.txt'), 'x\n');
    expect((await rejection(git.removeWorktree(r.path, a, { force: false }))).code).toBe('dirty-worktree');
    await git.removeWorktree(r.path, a, { force: true });
    await git.removeWorktree(r.path, b, { force: false });
    expect(existsSync(a)).toBe(false);
    expect((await git.worktrees(r.path)).map((w) => w.path)).toEqual([r.path]);
    expect((await rejection(git.removeWorktree(r.path, r.path, { force: false }))).code).not.toBe('dirty-worktree');
  });

  it('starts a new worktree branch from a given ref', async () => {
    const r = await repo();
    const { git } = makeGit();
    const p = join(dir(), 'x');
    await git.addWorktree(r.path, p, { name: 'feat/x', create: true, from: 'feature/login' });
    expect(r.git('rev-parse', 'feat/x')).toBe(r.git('rev-parse', 'feature/login'));
  });

  it('explains why a worktree could not be added', async () => {
    const r = await repo();
    const { git } = makeGit();
    const root = dir();
    expect((await rejection(git.addWorktree(r.path, join(root, '1'), { name: 'main', create: false }))).code).toBe('branch-in-use');
    expect((await rejection(git.addWorktree(r.path, join(root, '2'), { name: 'feature/login', create: true }))).code).toBe(
      'branch-exists',
    );
    expect((await rejection(git.addWorktree(r.path, join(root, '3'), { name: 'nope', create: false }))).code).toBe('not-found');
    expect(
      (await rejection(git.addWorktree(r.path, join(root, '4'), { name: 'feat/y', create: true, from: 'nope' }))).code,
    ).toBe('not-found');
    mkdirSync(join(root, '5'));
    writeFileSync(join(root, '5', 'taken.txt'), 'x');
    const e = await rejection(git.addWorktree(r.path, join(root, '5'), { name: 'feat/z', create: true }));
    expect(e.code).toBe('git-failed');
    expect(e.detail).toMatch(/already exists/);
  });

  it('cleans up a worktree whose folder was deleted from the command line', async () => {
    const r = await repo();
    const wt = r.addWorktree('feat/gone', { create: true });
    rmSync(wt, { recursive: true, force: true });
    const { git } = makeGit();
    await git.removeWorktree(r.path, wt, { force: false });
    expect((await git.worktrees(r.path)).map((w) => w.path)).toEqual([r.path]);
    await git.deleteBranch(r.path, 'feat/gone', { force: false });
  });
});

describe('repairWorktrees', () => {
  it('fixes worktrees after the main repo moved', async () => {
    const root = dir();
    const { git } = makeGit();
    const r = await repo();
    const wt = join(root, 'wt');
    await git.addWorktree(r.path, wt, { name: 'feat/moved', create: true });
    const moved = join(root, 'moved-main');
    renameSync(r.path, moved);
    // 搬家后 worktree 的 .git 文件还指向旧位置，打不开
    await expect(git.status(wt)).rejects.toBeTruthy();
    await git.repairWorktrees(moved);
    expect((await git.status(wt)).branch).toBe('feat/moved');
  });
});

describe('repoRoot, defaultBranch, init', () => {
  it('finds the repository root from a subfolder', async () => {
    const r = await repo();
    const { git } = makeGit();
    expect(await git.repoRoot(join(r.path, 'src'))).toBe(r.path);
    expect(await git.repoRoot(r.path)).toBe(r.path);
    expect(await git.repoRoot(dir())).toBeNull();
    expect(await git.repoRoot(join(dir(), 'missing'))).toBeNull();
    expect(await git.repoRoot(join(r.path, '.git'))).toBeNull();
  });

  it('prefers the remote default branch, then main, then master', async () => {
    const { git } = makeGit();
    expect(await git.defaultBranch((await repo({ defaultBranch: 'trunk', withRemote: true })).path)).toBe('trunk');
    expect(await git.defaultBranch((await repo()).path)).toBe('main');
    expect(await git.defaultBranch((await repo({ defaultBranch: 'master' })).path)).toBe('master');
    const odd = await repo({ defaultBranch: 'develop', branches: [] });
    expect(await git.defaultBranch(odd.path)).toBe('develop');
    odd.git('branch', 'master');
    expect(await git.defaultBranch(odd.path)).toBe('master');
  });

  it('initializes a plain folder', async () => {
    const d = dir();
    const { git } = makeGit();
    await git.init(d);
    expect(await git.repoRoot(d)).toBe(d);
  });
});

describe('process handling', () => {
  it('reports a missing git executable', async () => {
    const r = await repo();
    const { git } = makeGit({ gitPath: '/no/such/git' });
    expect((await rejection(git.status(r.path))).code).toBe('command-not-found');
  });

  it('reports a missing folder', async () => {
    const { git } = makeGit();
    expect((await rejection(git.branches(join(dir(), 'gone')))).code).toBe('not-found');
  });

  it('kills a git command that runs past the timeout', async () => {
    const d = dir();
    const slow = join(d, 'slow-git');
    writeFileSync(slow, '#!/bin/sh\nsleep 5\n');
    chmodSync(slow, 0o755);
    const git = createGitService({ gitPath: slow, env: TEST_ENV, timeoutMs: 200, moveToTrash: async () => {} });
    const started = Date.now();
    expect((await rejection(git.branches(d))).code).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('runs writes to one repository one after another', async () => {
    const r = await repo();
    const { git } = makeGit();
    for (let i = 0; i < 8; i++) r.writeFile(`f${i}.txt`, `${i}\n`);
    // 同时发 8 个 stage，不排队的话会撞 index.lock
    await Promise.all(Array.from({ length: 8 }, (_, i) => git.stage(r.path, [`f${i}.txt`])));
    expect((await git.status(r.path)).files.every((f) => f.staged === 'added')).toBe(true);
  });
});
