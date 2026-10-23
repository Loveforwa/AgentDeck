import { describe, expect, it } from 'vitest';
import { FakeEventBus } from '../src/bus.ts';
import { FakeGitService } from '../src/git-service.ts';

const ROOT = '/Users/you/code/app';
const WT = '/Users/you/.agentdeck/worktrees/app/feat-login';

function setup() {
  const bus = new FakeEventBus();
  const git = new FakeGitService({ bus });
  git.addRepo({
    path: ROOT,
    commits: ['Initial commit', 'Add README', 'Add src/index.ts'],
    branches: [{ name: 'feat/login', commits: ['Add login form', 'Validate email'] }, { name: 'old' }],
    worktrees: [
      {
        path: WT,
        branch: 'feat/login',
        changes: [
          { path: 'src/Login.tsx', unstaged: 'modified' },
          { path: 'src/new.ts', unstaged: 'untracked' },
          { path: 'src/api.ts', staged: 'added' },
        ],
      },
    ],
    tracking: { main: { upstream: 'origin/main', behind: 2 } },
  });
  return { bus, git };
}

describe('FakeGitService status', () => {
  it('reports branch, base and files', async () => {
    const { git } = setup();
    const s = await git.status(WT);
    expect(s).toMatchObject({ repo: WT, branch: 'feat/login', aheadOfBase: 2, baseBranch: 'main', operation: 'none' });
    expect(s.head).toMatch(/^[0-9a-f]{40}$/);
    expect(s.files.map((f) => [f.path, f.staged, f.unstaged])).toEqual([
      ['src/api.ts', 'added', 'unmodified'],
      ['src/Login.tsx', 'unmodified', 'modified'],
      ['src/new.ts', 'unmodified', 'untracked'],
    ]);
    const main = await git.status(ROOT);
    expect(main).toMatchObject({ branch: 'main', upstream: 'origin/main', ahead: 0, behind: 2, aheadOfBase: 0, files: [] });
  });

  it('works from a subdirectory and rejects non-repos', async () => {
    const { git } = setup();
    expect(await git.repoRoot(`${WT}/src`)).toBe(WT);
    expect(await git.repoRoot('/tmp/nothing')).toBeNull();
    await expect(git.status('/tmp/nothing')).rejects.toMatchObject({ code: 'not-a-git-repo' });
  });
});

describe('FakeGitService stage / unstage / discard / commit', () => {
  it('stage and unstage move changes between columns and emit git.status', async () => {
    const { git, bus } = setup();
    await git.stage(WT, ['src/Login.tsx', 'src/new.ts']);
    let files = (await git.status(WT)).files;
    expect(files.find((f) => f.path === 'src/new.ts')).toMatchObject({ staged: 'added', unstaged: 'unmodified' });
    expect(files.find((f) => f.path === 'src/Login.tsx')).toMatchObject({ staged: 'modified', unstaged: 'unmodified' });
    await git.unstage(WT, ['src']);
    files = (await git.status(WT)).files;
    expect(files.map((f) => [f.path, f.staged, f.unstaged])).toEqual([
      ['src/api.ts', 'unmodified', 'untracked'],
      ['src/Login.tsx', 'unmodified', 'modified'],
      ['src/new.ts', 'unmodified', 'untracked'],
    ]);
    expect(bus.eventsOf('git.status')).toHaveLength(2);
    await expect(git.stage(WT, ['nope.ts'])).rejects.toMatchObject({ code: 'git-failed' });
  });

  it('discard restores tracked files and trashes untracked ones', async () => {
    const { git } = setup();
    await git.discard(WT, ['src/Login.tsx', 'src/new.ts']);
    expect((await git.status(WT)).files.map((f) => f.path)).toEqual(['src/api.ts']);
    expect(git.trashed).toEqual([`${WT}/src/new.ts`]);
  });

  it('commit takes staged changes only, or everything with all', async () => {
    const { git } = setup();
    const before = await git.log(WT, 50);
    const c = await git.commit(WT, 'Add API client\n\nbody', { all: true });
    expect(c).toMatchObject({ subject: 'Add API client', onBase: false, author: 'You' });
    expect(c.shortHash).toBe(c.hash.slice(0, 7));
    let s = await git.status(WT);
    expect(s.files.map((f) => f.path)).toEqual(['src/Login.tsx', 'src/new.ts']);
    expect(s.head).toBe(c.hash);
    expect(s.aheadOfBase).toBe(3);

    await git.commit(WT, 'Everything else', { all: true });
    s = await git.status(WT);
    expect(s.files).toEqual([]);
    await expect(git.commit(WT, 'again', { all: true })).rejects.toMatchObject({ code: 'git-failed' });
    await expect(git.commit(WT, '  ', { all: true })).rejects.toMatchObject({ code: 'invalid-argument' });
    expect((await git.log(WT, 50)).length).toBe(before.length + 2);
  });

  it('commit on a tracked branch bumps ahead', async () => {
    const { git } = setup();
    git.addChanges(ROOT, { path: 'README.md' });
    await git.commit(ROOT, 'Edit readme', { all: true });
    expect(await git.status(ROOT)).toMatchObject({ ahead: 1, behind: 2 });
  });

  it('refuses to commit with conflicts', async () => {
    const { git } = setup();
    git.setOperation(WT, 'merge');
    git.addChanges(WT, { path: 'src/conflict.ts', staged: 'modified', unstaged: 'modified', conflicted: true });
    expect((await git.status(WT)).operation).toBe('merge');
    await expect(git.commit(WT, 'merge', { all: false })).rejects.toMatchObject({ code: 'git-failed' });
  });
});

describe('FakeGitService branches and log', () => {
  it('lists branches with checkout locations', async () => {
    const { git } = setup();
    const branches = await git.branches(ROOT);
    expect(branches.map((b) => [b.name, b.current, b.checkedOutAt])).toEqual([
      ['feat/login', false, WT],
      ['main', true, ROOT],
      ['old', false, null],
    ]);
    expect(branches.every((b) => typeof b.lastCommitAt === 'string')).toBe(true);
  });

  it('switchBranch checks branch-in-use and supports stash', async () => {
    const { git } = setup();
    await expect(git.switchBranch(ROOT, 'feat/login', 'carry')).rejects.toMatchObject({ code: 'branch-in-use' });
    await expect(git.switchBranch(ROOT, 'missing', 'carry')).rejects.toMatchObject({ code: 'not-found' });
    await git.switchBranch(WT, 'old', 'stash');
    const s = await git.status(WT);
    expect(s).toMatchObject({ branch: 'old', files: [] });
    expect(git.stashes(WT)).toMatchObject([{ branch: 'feat/login' }]);
    expect(git.stashes(WT)[0]?.files).toHaveLength(3);
    // carry 带着改动走
    git.addChanges(WT, { path: 'x.ts' });
    await git.switchBranch(WT, 'feat/login', 'carry');
    expect((await git.status(WT)).files.map((f) => f.path)).toEqual(['x.ts']);
  });

  it('createBranch validates and can switch', async () => {
    const { git } = setup();
    await expect(git.createBranch(ROOT, 'main', { switchTo: false })).rejects.toMatchObject({ code: 'branch-exists' });
    await expect(git.createBranch(ROOT, 'bad name', { switchTo: false })).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    await git.createBranch(ROOT, 'fix/cart', { from: 'feat/login', switchTo: true });
    expect(await git.status(ROOT)).toMatchObject({ branch: 'fix/cart', aheadOfBase: 2 });
  });

  it('log lists branch commits then a few base commits', async () => {
    const { git } = setup();
    const log = await git.log(WT, 10);
    expect(log.map((c) => [c.subject, c.onBase])).toEqual([
      ['Validate email', false],
      ['Add login form', false],
      ['Add src/index.ts', true],
      ['Add README', true],
      ['Initial commit', true],
    ]);
    expect(await git.log(WT, 1)).toHaveLength(1);
  });
});

describe('FakeGitService worktrees', () => {
  it('adds and removes worktrees', async () => {
    const { git } = setup();
    const p = '/Users/you/.agentdeck/worktrees/app/fix';
    await git.addWorktree(ROOT, p, { name: 'fix/x', create: true, from: 'main' });
    await expect(git.addWorktree(ROOT, '/elsewhere', { name: 'fix/x', create: false })).rejects.toMatchObject({
      code: 'branch-in-use',
    });
    await expect(git.addWorktree(ROOT, '/elsewhere', { name: 'main', create: true })).rejects.toMatchObject({
      code: 'branch-exists',
    });
    expect((await git.worktrees(p)).map((w) => [w.path, w.branch, w.main])).toEqual([
      [ROOT, 'main', true],
      [WT, 'feat/login', false],
      [p, 'fix/x', false],
    ]);
    expect(await git.repoRoot(p)).toBe(p);

    await expect(git.removeWorktree(ROOT, WT, { force: false })).rejects.toMatchObject({ code: 'dirty-worktree' });
    await git.removeWorktree(ROOT, WT, { force: true });
    await expect(git.removeWorktree(ROOT, ROOT, { force: true })).rejects.toMatchObject({ code: 'invalid-argument' });
    expect((await git.worktrees(ROOT)).map((w) => w.path)).toEqual([ROOT, p]);
    // 分支保留
    expect((await git.branches(ROOT)).map((b) => b.name)).toContain('feat/login');
  });

  it('init creates an empty repo', async () => {
    const { git } = setup();
    await git.init('/Users/you/code/notes');
    expect(await git.status('/Users/you/code/notes')).toMatchObject({ branch: 'main', head: null, files: [] });
    expect(await git.defaultBranch('/Users/you/code/notes')).toBe('main');
    await git.init('/Users/you/code/notes');
  });
});

describe('FakeGitService diff and faults', () => {
  it('returns custom or generated diffs', async () => {
    const { git } = setup();
    git.addChanges(WT, { path: 'a.ts', diff: 'custom diff' });
    expect(await git.diff(WT, 'a.ts', { staged: false })).toBe('custom diff');
    expect(await git.diff(WT, 'a.ts', { staged: true })).toBe('');
    expect(await git.diff(WT, 'src/api.ts', { staged: true })).toContain('new file mode');
    expect(await git.diff(WT, 'missing.ts', { staged: false })).toBe('');
    await git.stage(WT, ['a.ts']);
    expect(await git.diff(WT, 'a.ts', { staged: true })).toBe('custom diff');
  });

  it('failNext throws once', async () => {
    const { git } = setup();
    git.failNext('commit', { code: 'git-failed', message: 'Hook failed', detail: 'pre-commit: lint errors' });
    await expect(git.commit(WT, 'x', { all: true })).rejects.toMatchObject({ code: 'git-failed', detail: 'pre-commit: lint errors' });
    await expect(git.commit(WT, 'x', { all: true })).resolves.toMatchObject({ subject: 'x' });
  });
});
