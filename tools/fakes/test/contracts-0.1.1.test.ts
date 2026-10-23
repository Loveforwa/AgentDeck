// contracts 0.1.1 新增的行为（来自 CONTRACT_NOTES.md）。
import { describe, expect, it } from 'vitest';
import { createFakeServices } from '../src/api.ts';
import { FakeEventBus } from '../src/bus.ts';
import { FakeGitService } from '../src/git-service.ts';

const HOME = '/Users/you';
const ROOT = `${HOME}/code/app`;
const WT = `${HOME}/.agentdeck/worktrees/app/feat-login`;

function gitSetup() {
  const git = new FakeGitService({ bus: new FakeEventBus() });
  git.addRepo({
    path: ROOT,
    commits: ['Initial commit'],
    branches: [{ name: 'feat/login', commits: ['Add login form'] }, { name: 'old' }, { name: 'release' }],
    worktrees: [{ path: WT, branch: 'feat/login', changes: [{ path: 'src/Login.tsx', unstaged: 'modified' }] }],
  });
  return git;
}

describe('GitService stash', () => {
  it('lists and applies a stash, with drop', async () => {
    const git = gitSetup();
    await git.switchBranch(WT, 'old', 'stash');
    const list = await git.stashes(WT);
    expect(list).toMatchObject([{ id: 'stash@{0}', branch: 'feat/login' }]);
    expect(list[0]?.message).toContain('feat/login');
    await git.switchBranch(WT, 'feat/login', 'carry');
    await git.applyStash(WT, 'stash@{0}', { drop: true });
    expect((await git.status(WT)).files.map((f) => f.path)).toEqual(['src/Login.tsx']);
    expect(await git.stashes(WT)).toEqual([]);
  });

  it('refuses to apply over local changes and keeps the stash', async () => {
    const git = gitSetup();
    await git.switchBranch(WT, 'old', 'stash');
    git.addChanges(WT, { path: 'src/Login.tsx', unstaged: 'modified' });
    await expect(git.applyStash(WT, 'stash@{0}', { drop: true })).rejects.toMatchObject({ code: 'git-failed' });
    await expect(git.applyStash(WT, 'stash@{9}', { drop: false })).rejects.toMatchObject({ code: 'not-found' });
    expect(await git.stashes(WT)).toHaveLength(1);
  });
});

describe('GitService deleteBranch', () => {
  it('blocks checked-out and unmerged branches unless forced', async () => {
    const git = gitSetup();
    await expect(git.deleteBranch(ROOT, 'feat/login', { force: true })).rejects.toMatchObject({ code: 'branch-in-use' });
    await git.createBranch(WT, 'spike', { switchTo: false });
    // spike 和 feat/login 指向同一个提交，比 main 多一个，没合并
    await expect(git.deleteBranch(ROOT, 'spike', { force: false })).rejects.toMatchObject({ code: 'git-failed' });
    await git.deleteBranch(ROOT, 'spike', { force: true });
    await git.deleteBranch(ROOT, 'old', { force: false }); // 和 main 一样，算已合并
    expect((await git.branches(ROOT)).map((b) => b.name)).not.toContain('old');
    await expect(git.deleteBranch(ROOT, 'nope', { force: true })).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('GitService baseBranch option', () => {
  it('status and log use the passed base branch', async () => {
    const git = gitSetup();
    expect((await git.status(WT)).aheadOfBase).toBe(1);
    const s = await git.status(WT, { baseBranch: 'feat/login' });
    expect(s).toMatchObject({ baseBranch: 'feat/login', aheadOfBase: 0 });
    expect((await git.log(WT, 10, { baseBranch: 'feat/login' })).every((c) => c.onBase)).toBe(true);
  });
});

describe('WorkspaceService 0.1.1', () => {
  function setup() {
    const { bus, fakes } = createFakeServices({ home: HOME });
    fakes.git.addRepo({ path: `${HOME}/code/multi/web` });
    fakes.git.addRepo({ path: `${HOME}/code/multi/api`, defaultBranch: 'master' });
    return { bus, ...fakes };
  }

  it('branch.from is optional: each repo uses its own base branch', async () => {
    const { projects, workspaces, bus } = setup();
    const [multi] = await projects.add({ folder: `${HOME}/code/multi`, as: 'multi-repo' });
    const { workspace } = await workspaces.create({ projectId: multi!.id, mode: 'worktree', branch: { kind: 'new', name: 'feat/x' } });
    expect(workspace.repos.map((r) => [r.name, r.branch])).toEqual([
      ['api', 'feat/x'],
      ['web', 'feat/x'],
    ]);
    // progress 带上分支名
    expect(bus.eventsOf('workspace.progress').every((e) => e.branch === 'feat/x')).toBe(true);
  });

  it('remove with deleteFolder refuses dirty worktrees unless forced', async () => {
    const { projects, workspaces, git } = setup();
    const [multi] = await projects.add({ folder: `${HOME}/code/multi`, as: 'multi-repo' });
    const { workspace } = await workspaces.create({ projectId: multi!.id, mode: 'worktree', branch: { kind: 'new', name: 'feat/y' } });
    const web = workspace.repos.find((r) => r.name === 'web')!;
    git.addChanges(web.path, { path: 'index.html', unstaged: 'modified' });
    await expect(workspaces.remove({ id: workspace.id, deleteFolder: true })).rejects.toMatchObject({ code: 'dirty-worktree' });
    // 一个都没删
    expect((await git.worktrees(`${HOME}/code/multi/api`)).length).toBe(2);
    await workspaces.remove({ id: workspace.id, deleteFolder: true, force: true });
    expect((await git.worktrees(`${HOME}/code/multi/web`)).length).toBe(1);
  });
});

describe('AgentService size', () => {
  it('passes the window size to the terminal', async () => {
    const { fakes } = createFakeServices({ home: HOME });
    const { terminalId } = await fakes.agents.start({
      agent: 'claude',
      cwd: HOME,
      workspaceId: null,
      mode: { kind: 'new' },
      size: { cols: 132, rows: 41 },
    });
    expect(fakes.terminals.get(terminalId).size).toEqual({ cols: 132, rows: 41 });
  });
});
