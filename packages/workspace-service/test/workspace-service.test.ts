// 项目和工作区服务，跑在真实的 git（git-service）和临时目录上。

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentDeckError, Project, ProjectId, Workspace } from '@agentdeck/contracts';
import { createTempRepo, type TempRepo } from '@agentdeck/fakes/temp-repo';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { branchSlug } from '../src/index.ts';
import { TEST_ENV, setup, tempDir } from './helpers.ts';

let home: { path: string; cleanup: () => void };
let ctx: ReturnType<typeof setup>;
const cleanups: (() => void)[] = [];

beforeEach(() => {
  home = tempDir('agentdeck-home-');
  ctx = setup(home.path);
});
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
  home.cleanup();
});

async function repo(opts: Parameters<typeof createTempRepo>[0] = {}): Promise<TempRepo> {
  const r = await createTempRepo(opts);
  cleanups.push(() => r.cleanup());
  return r;
}

function dir(): string {
  const d = tempDir();
  cleanups.push(d.cleanup);
  return d.path;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: TEST_ENV, encoding: 'utf8' }).trim();
}

/** 在 path 建一个仓库，带一条提交。 */
function initRepo(path: string, branch = 'main', files: Record<string, string> = { 'README.md': 'hi\n' }): string {
  mkdirSync(path, { recursive: true });
  git(path, 'init', '-q', '-b', branch);
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(join(path, f, '..'), { recursive: true });
    writeFileSync(join(path, f), c);
  }
  git(path, 'add', '-A');
  git(path, 'commit', '-q', '-m', 'Initial commit');
  return path;
}

/** shop/ 下有 web（main）和 api（master）两个仓库，外加一个普通文件夹和一个隐藏仓库。 */
function multiRepoFolder(): string {
  const shop = join(dir(), 'shop');
  initRepo(join(shop, 'web'), 'main', { 'README.md': 'web\n', '.gitignore': '.env\n' });
  initRepo(join(shop, 'api'), 'master');
  initRepo(join(shop, '.hidden'));
  mkdirSync(join(shop, 'docs'));
  return shop;
}

async function rejection(p: Promise<unknown>): Promise<AgentDeckError> {
  try {
    await p;
  } catch (e) {
    return e as AgentDeckError;
  }
  throw new Error('expected the promise to reject');
}

async function addGit(r: { path: string }): Promise<Project> {
  const [p] = await ctx.projects.add({ folder: r.path, as: 'git' });
  if (!p) throw new Error('no project');
  return p;
}

describe('projects.probe', () => {
  it('tells git, subfolder, multi-repo, plain and already-added folders apart', async () => {
    const r = await repo();
    expect(await ctx.projects.probe(r.path)).toEqual({ kind: 'git', folder: r.path, repoRoot: r.path, usedRepoRoot: false });
    expect(await ctx.projects.probe(join(r.path, 'src'))).toEqual({
      kind: 'git',
      folder: join(r.path, 'src'),
      repoRoot: r.path,
      usedRepoRoot: true,
    });

    const shop = multiRepoFolder();
    expect(await ctx.projects.probe(shop)).toEqual({
      kind: 'multi-repo',
      folder: shop,
      repos: [
        { name: 'api', path: join(shop, 'api') },
        { name: 'web', path: join(shop, 'web') },
      ],
    });

    const notes = dir();
    initRepo(join(notes, 'only-one'));
    expect(await ctx.projects.probe(notes)).toEqual({ kind: 'plain', folder: notes });

    const p = await addGit(r);
    expect(await ctx.projects.probe(join(r.path, 'src'))).toMatchObject({ kind: 'already-added', project: { id: p.id } });
    expect((await rejection(ctx.projects.probe(join(notes, 'missing')))).code).toBe('not-found');
  });
});

describe('projects.add', () => {
  it('adds a git repository with defaults, and returns the same project the second time', async () => {
    const r = await repo({ defaultBranch: 'trunk', withRemote: true });
    const [p, ...rest] = await ctx.projects.add({ folder: join(r.path, 'src'), as: 'git' });
    expect(rest).toEqual([]);
    expect(p).toMatchObject({
      name: 'repo',
      kind: 'git',
      path: r.path,
      repos: [{ name: '.', path: r.path, baseBranch: 'trunk' }],
      worktreeRoot: join(home.path, '.agentdeck', 'worktrees', 'repo'),
      copyIntoWorktrees: ['.env', '.env.local'],
      setupCommand: null,
      missing: false,
    });
    expect(ctx.events).toEqual([{ type: 'project.changed', project: p }]);
    expect(await ctx.projects.add({ folder: r.path, as: 'git' })).toEqual([p]);
    expect(await ctx.projects.list()).toHaveLength(1);
  });

  it('gives two projects with the same folder name different worktree locations', async () => {
    const a = await addGit(await repo());
    const b = await addGit(await repo());
    expect(a.worktreeRoot).toBe(join(home.path, '.agentdeck', 'worktrees', 'repo'));
    expect(b.worktreeRoot).toBe(join(home.path, '.agentdeck', 'worktrees', 'repo-2'));
  });

  it('adds a multi-repo folder as one project, or each repository separately', async () => {
    const shop = multiRepoFolder();
    const [p] = await ctx.projects.add({ folder: shop, as: 'multi-repo' });
    expect(p).toMatchObject({
      kind: 'multi-repo',
      path: shop,
      repos: [
        { name: 'api', path: join(shop, 'api'), baseBranch: 'master' },
        { name: 'web', path: join(shop, 'web'), baseBranch: 'main' },
      ],
    });

    const other = multiRepoFolder();
    const separate = await ctx.projects.add({ folder: other, as: 'separately' });
    expect(separate.map((s) => [s.name, s.kind, s.path])).toEqual([
      ['api', 'git', join(other, 'api')],
      ['web', 'git', join(other, 'web')],
    ]);
  });

  it('adds a plain folder and refuses kinds that don’t match the folder', async () => {
    const notes = dir();
    const [p] = await ctx.projects.add({ folder: notes, as: 'plain' });
    expect(p).toMatchObject({ kind: 'plain', repos: [], path: notes });
    const r = await repo();
    expect((await rejection(ctx.projects.add({ folder: r.path, as: 'plain' }))).code).toBe('invalid-argument');
    expect((await rejection(ctx.projects.add({ folder: dir(), as: 'git' }))).code).toBe('invalid-argument');
  });
});

describe('projects.update / remove / list / locate / initGit', () => {
  it('updates settings and per-repository base branches', async () => {
    const p = await addGit(await repo());
    const next = await ctx.projects.update(p.id, {
      name: ' API ',
      setupCommand: '  ',
      copyIntoWorktrees: ['.env', '', 'config/local.json'],
      baseBranch: { '.': 'feature/login' },
    });
    expect(next).toMatchObject({ name: 'API', setupCommand: null, copyIntoWorktrees: ['.env', 'config/local.json'] });
    expect(next.repos[0]?.baseBranch).toBe('feature/login');
    expect((await rejection(ctx.projects.update(p.id, { baseBranch: { web: 'main' } }))).code).toBe('invalid-argument');
    expect((await rejection(ctx.projects.update(p.id, { worktreeRoot: 'relative/path' }))).code).toBe('invalid-argument');
    expect((await rejection(ctx.projects.update('nope' as ProjectId, { name: 'x' }))).code).toBe('not-found');
  });

  it('removes a project and its workspaces from the app, but no files', async () => {
    const r = await repo();
    const p = await addGit(r);
    const { workspace } = await ctx.workspaces.create({ projectId: p.id, mode: 'worktree', branch: { kind: 'new', name: 'feat/a' } });
    ctx.events.length = 0;
    await ctx.projects.remove(p.id);
    expect(ctx.events).toEqual([
      { type: 'workspace.removed', id: workspace.id },
      { type: 'project.removed', id: p.id },
    ]);
    expect(await ctx.projects.list()).toEqual([]);
    expect(await ctx.workspaces.list()).toEqual([]);
    expect(existsSync(workspace.path)).toBe(true);
    expect(existsSync(r.path)).toBe(true);
  });

  it('marks a project missing when its folder goes away, and locates it again', async () => {
    const parent = dir();
    const path = initRepo(join(parent, 'app'));
    const p = await addGit({ path });
    const { workspace: main } = await ctx.workspaces.create({ projectId: p.id, mode: 'main-folder' });

    const moved = join(parent, 'app-moved');
    renameSync(path, moved);
    ctx.events.length = 0;
    expect((await ctx.projects.list())[0]?.missing).toBe(true);
    expect(ctx.events).toEqual([{ type: 'project.changed', project: expect.objectContaining({ missing: true }) }]);
    expect((await ctx.workspaces.list())[0]?.missing).toBe(true);

    expect((await rejection(ctx.projects.locate(p.id, dir()))).code).toBe('not-a-git-repo');
    const located = await ctx.projects.locate(p.id, moved);
    expect(located).toMatchObject({ path: moved, missing: false, repos: [{ name: '.', path: moved }] });
    const ws = (await ctx.workspaces.list()).find((w) => w.id === main.id);
    expect(ws).toMatchObject({ path: moved, missing: false, repos: [{ name: '.', path: moved, branch: 'main' }] });
  });

  it('turns a plain project into a git one with initGit, or when git init happened elsewhere', async () => {
    const notes = dir();
    writeFileSync(join(notes, 'todo.md'), 'x\n');
    const [p] = await ctx.projects.add({ folder: notes, as: 'plain' });
    if (!p) throw new Error('no project');
    const { workspace } = await ctx.workspaces.create({ projectId: p.id, mode: 'main-folder' });
    expect(workspace).toMatchObject({ branch: null, repos: [], name: p.name });
    expect((await rejection(ctx.workspaces.create({ projectId: p.id, mode: 'worktree', branch: { kind: 'new', name: 'x' } }))).code).toBe(
      'invalid-argument',
    );

    const next = await ctx.projects.initGit(p.id);
    expect(next.kind).toBe('git');
    expect(next.repos).toEqual([{ name: '.', path: notes, baseBranch: expect.any(String) }]);
    const ws = (await ctx.workspaces.list())[0];
    expect(ws?.repos).toEqual([{ name: '.', path: notes, branch: expect.any(String) }]);
    expect((await rejection(ctx.projects.initGit(p.id))).code).toBe('invalid-argument');

    const other = dir();
    const [q] = await ctx.projects.add({ folder: other, as: 'plain' });
    git(other, 'init', '-q', '-b', 'main');
    expect((await ctx.projects.list()).find((x) => x.id === q?.id)).toMatchObject({
      kind: 'git',
      repos: [{ name: '.', path: other, baseBranch: 'main' }],
    });
  });
});

describe('workspaces.create', () => {
  it('creates a worktree on a new branch, copies .env files and returns the setup command', async () => {
    const r = await repo({ withRemote: true });
    writeFileSync(join(r.path, '.env'), 'SECRET=1\n');
    writeFileSync(join(r.path, '.env.local'), 'LOCAL=1\n');
    const p = await addGit(r);
    await ctx.projects.update(p.id, { setupCommand: 'pnpm install', copyIntoWorktrees: ['.env', '.env.local', 'README.md', '../escape'] });
    r.writeFile('README.md', 'edited in main, not copied over the tracked file\n');
    ctx.events.length = 0;

    const { workspace, setup } = await ctx.workspaces.create({ projectId: p.id, mode: 'worktree', branch: { kind: 'new', name: 'feat/oauth' } });
    const path = join(home.path, '.agentdeck', 'worktrees', 'repo', 'feat-oauth');
    expect(workspace).toMatchObject({
      projectId: p.id,
      name: 'feat/oauth',
      mode: 'worktree',
      path,
      branch: 'feat/oauth',
      repos: [{ name: '.', path, branch: 'feat/oauth' }],
      missing: false,
    });
    expect(setup).toEqual({ command: 'pnpm install', cwd: path });
    expect(git(path, 'rev-parse', 'HEAD')).toBe(r.git('rev-parse', 'main'));
    expect(git(path, 'branch', '--show-current')).toBe('feat/oauth');
    expect(readFileSync(join(path, '.env'), 'utf8')).toBe('SECRET=1\n');
    expect(readFileSync(join(path, '.env.local'), 'utf8')).toBe('LOCAL=1\n');
    expect(readFileSync(join(path, 'README.md'), 'utf8')).toBe('# Temp repo\n');
    expect(existsSync(join(path, '..', 'escape'))).toBe(false);
    expect(ctx.events.map((e) => (e.type === 'workspace.progress' ? `${e.step}: ${e.message}` : e.type))).toEqual([
      'worktree: Creating worktree…',
      'copy-files: Copied .env, .env.local',
      'done: Worktree ready',
      'workspace.changed',
    ]);
    expect(ctx.events[0]).toMatchObject({ projectId: p.id, branch: 'feat/oauth' });
    expect(await ctx.workspaces.list()).toEqual([workspace]);
  });

  it('branches from a given branch, or checks out an existing one', async () => {
    const r = await repo();
    const p = await addGit(r);
    const a = await ctx.workspaces.create({
      projectId: p.id,
      mode: 'worktree',
      branch: { kind: 'new', name: 'feat/next', from: 'feature/login' },
      name: 'Next',
    });
    expect(a.workspace.name).toBe('Next');
    expect(git(a.workspace.path, 'rev-parse', 'HEAD')).toBe(r.git('rev-parse', 'feature/login'));
    const b = await ctx.workspaces.create({ projectId: p.id, mode: 'worktree', branch: { kind: 'existing', name: 'feature/login' } });
    expect(b.workspace.path).toBe(join(p.worktreeRoot, 'feature-login'));
    expect(git(b.workspace.path, 'branch', '--show-current')).toBe('feature/login');
    expect(b.setup).toBeNull();
  });

  it('explains taken and missing branches without creating anything', async () => {
    const r = await repo();
    const p = await addGit(r);
    const exists = await rejection(ctx.workspaces.create({ projectId: p.id, mode: 'worktree', branch: { kind: 'new', name: 'feature/login' } }));
    expect(exists).toMatchObject({ code: 'branch-exists', message: 'Branch feature/login already exists' });
    const inUse = await rejection(ctx.workspaces.create({ projectId: p.id, mode: 'worktree', branch: { kind: 'existing', name: 'main' } }));
    expect(inUse).toMatchObject({ code: 'branch-in-use', message: `Branch main is checked out in ${r.path}` });
    const missing = await rejection(ctx.workspaces.create({ projectId: p.id, mode: 'worktree', branch: { kind: 'existing', name: 'nope' } }));
    expect(missing.code).toBe('not-found');
    expect((await rejection(ctx.workspaces.create({ projectId: p.id, mode: 'worktree' }))).code).toBe('invalid-argument');
    expect(existsSync(p.worktreeRoot)).toBe(false);
    expect(await ctx.workspaces.list()).toEqual([]);
  });

  it('rolls back the worktree and new branch when git fails', async () => {
    const r = await repo();
    const p = await addGit(r);
    const e = await rejection(
      ctx.workspaces.create({ projectId: p.id, mode: 'worktree', branch: { kind: 'new', name: 'feat/x', from: 'no-such-base' } }),
    );
    expect(e.code).toBe('not-found');
    expect(r.git('branch', '--list', 'feat/x')).toBe('');
    expect(r.git('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
  });

  it('picks a free folder when the branch folder already exists', async () => {
    const r = await repo();
    const p = await addGit(r);
    mkdirSync(join(p.worktreeRoot, 'feat-a'), { recursive: true });
    writeFileSync(join(p.worktreeRoot, 'feat-a', 'leftover.txt'), 'x');
    const { workspace } = await ctx.workspaces.create({ projectId: p.id, mode: 'worktree', branch: { kind: 'new', name: 'feat/a' } });
    expect(workspace.path).toBe(join(p.worktreeRoot, 'feat-a-2'));
  });

  it('creates the main-folder workspace once per project', async () => {
    const r = await repo();
    r.git('switch', '-q', 'feature/login');
    const p = await addGit(r);
    const { workspace, setup } = await ctx.workspaces.create({ projectId: p.id, mode: 'main-folder' });
    expect(workspace).toMatchObject({ mode: 'main-folder', path: r.path, branch: 'feature/login', name: 'repo' });
    expect(setup).toBeNull();
    expect((await rejection(ctx.workspaces.create({ projectId: p.id, mode: 'main-folder' }))).code).toBe('invalid-argument');
    expect(
      (await rejection(ctx.workspaces.create({ projectId: p.id, mode: 'main-folder', branch: { kind: 'existing', name: 'main' } }))).code,
    ).toBe('invalid-argument');
  });

  it('creates one worktree per picked repository under one parent folder', async () => {
    const shop = multiRepoFolder();
    writeFileSync(join(shop, 'web', '.env'), 'WEB=1\n');
    const [p] = await ctx.projects.add({ folder: shop, as: 'multi-repo' });
    if (!p) throw new Error('no project');
    ctx.events.length = 0;
    const { workspace } = await ctx.workspaces.create({ projectId: p.id, mode: 'worktree', branch: { kind: 'new', name: 'feat/checkout' } });
    const parent = join(home.path, '.agentdeck', 'worktrees', 'shop', 'feat-checkout');
    expect(workspace).toMatchObject({
      path: parent,
      branch: 'feat/checkout',
      repos: [
        { name: 'api', path: join(parent, 'api'), branch: 'feat/checkout' },
        { name: 'web', path: join(parent, 'web'), branch: 'feat/checkout' },
      ],
    });
    // 每个仓库从自己的基础分支分出
    expect(git(join(parent, 'api'), 'rev-parse', 'HEAD')).toBe(git(join(shop, 'api'), 'rev-parse', 'master'));
    expect(readFileSync(join(parent, 'web', '.env'), 'utf8')).toBe('WEB=1\n');
    expect(ctx.events.filter((e) => e.type === 'workspace.progress').map((e) => e.type === 'workspace.progress' && [e.step, e.repo])).toEqual([
      ['worktree', 'api'],
      ['worktree', 'web'],
      ['copy-files', 'web'],
      ['done', undefined],
    ]);

    const onlyWeb = await ctx.workspaces.create({ projectId: p.id, mode: 'worktree', branch: { kind: 'new', name: 'feat/ui' }, repos: ['web'] });
    expect(onlyWeb.workspace.repos.map((x) => x.name)).toEqual(['web']);
    expect(existsSync(join(onlyWeb.workspace.path, 'api'))).toBe(false);
    expect((await rejection(ctx.workspaces.create({ projectId: p.id, mode: 'worktree', branch: { kind: 'new', name: 'z' }, repos: ['ios'] }))).code).toBe(
      'invalid-argument',
    );
  });

  it('undoes the repositories already done when a later one fails', async () => {
    const shop = multiRepoFolder();
    // api 排在 web 前面：只有 api 有 release，api 建好后 web 失败
    git(join(shop, 'api'), 'branch', 'release');
    const [p] = await ctx.projects.add({ folder: shop, as: 'multi-repo' });
    if (!p) throw new Error('no project');
    const e = await rejection(
      ctx.workspaces.create({ projectId: p.id, mode: 'worktree', branch: { kind: 'new', name: 'feat/r', from: 'release' } }),
    );
    expect(e).toMatchObject({ code: 'not-found', message: 'web: Branch release not found' });
    expect(git(join(shop, 'api'), 'branch', '--list', 'feat/r')).toBe('');
    expect(git(join(shop, 'api'), 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
    expect(existsSync(join(p.worktreeRoot, 'feat-r'))).toBe(false);
    expect(await ctx.workspaces.list()).toEqual([]);
  });
});

describe('workspaces.remove / rename / list', () => {
  async function worktreeWorkspace(): Promise<{ r: TempRepo; p: Project; w: Workspace }> {
    const r = await repo();
    const p = await addGit(r);
    const { workspace } = await ctx.workspaces.create({ projectId: p.id, mode: 'worktree', branch: { kind: 'new', name: 'feat/del' } });
    return { r, p, w: workspace };
  }

  it('removes from the board only, keeping the folder and branch', async () => {
    const { r, w } = await worktreeWorkspace();
    await ctx.workspaces.remove({ id: w.id, deleteFolder: false });
    expect(existsSync(w.path)).toBe(true);
    expect(r.git('branch', '--list', 'feat/del')).not.toBe('');
    expect(await ctx.workspaces.list()).toEqual([]);
  });

  it('refuses to delete a folder with uncommitted changes unless forced, and keeps the branch', async () => {
    const { r, w } = await worktreeWorkspace();
    writeFileSync(join(w.path, 'wip.txt'), 'x\n');
    writeFileSync(join(w.path, 'README.md'), 'changed\n');
    const e = await rejection(ctx.workspaces.remove({ id: w.id, deleteFolder: true }));
    expect(e).toMatchObject({ code: 'dirty-worktree', message: '2 uncommitted changes will be lost', detail: 'README.md\nwip.txt' });
    expect(existsSync(w.path)).toBe(true);
    expect(await ctx.workspaces.list()).toHaveLength(1);

    ctx.events.length = 0;
    await ctx.workspaces.remove({ id: w.id, deleteFolder: true, force: true });
    expect(existsSync(w.path)).toBe(false);
    expect(r.git('branch', '--list', 'feat/del')).not.toBe('');
    expect(r.git('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
    expect(ctx.events).toEqual([{ type: 'workspace.removed', id: w.id }]);
  });

  it('deletes a clean worktree folder, and only removes the main folder from the board', async () => {
    const { r, p, w } = await worktreeWorkspace();
    await ctx.workspaces.remove({ id: w.id, deleteFolder: true });
    expect(existsSync(w.path)).toBe(false);
    const { workspace: main } = await ctx.workspaces.create({ projectId: p.id, mode: 'main-folder' });
    expect((await rejection(ctx.workspaces.remove({ id: main.id, deleteFolder: true }))).code).toBe('invalid-argument');
    expect(existsSync(r.path)).toBe(true);
  });

  it('deletes every repository’s worktree and the parent folder of a multi-repo workspace', async () => {
    const shop = multiRepoFolder();
    const [p] = await ctx.projects.add({ folder: shop, as: 'multi-repo' });
    if (!p) throw new Error('no project');
    const { workspace } = await ctx.workspaces.create({ projectId: p.id, mode: 'worktree', branch: { kind: 'new', name: 'feat/m' } });
    writeFileSync(join(workspace.path, 'api', 'x.txt'), 'x');
    expect((await rejection(ctx.workspaces.remove({ id: workspace.id, deleteFolder: true }))).detail).toBe('api/x.txt');
    await ctx.workspaces.remove({ id: workspace.id, deleteFolder: true, force: true });
    expect(existsSync(workspace.path)).toBe(false);
    expect(git(join(shop, 'api'), 'branch', '--list', 'feat/m')).not.toBe('');
  });

  it('deletes a workspace whose folder was already removed by hand', async () => {
    const { r, w } = await worktreeWorkspace();
    rmSync(w.path, { recursive: true, force: true });
    expect((await ctx.workspaces.list())[0]?.missing).toBe(true);
    await ctx.workspaces.remove({ id: w.id, deleteFolder: true });
    expect(r.git('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
  });

  it('renames, and follows branch switches made outside the app', async () => {
    const { w } = await worktreeWorkspace();
    expect((await ctx.workspaces.rename(w.id, '  OAuth  ')).name).toBe('OAuth');
    expect((await rejection(ctx.workspaces.rename(w.id, ' '))).code).toBe('invalid-argument');

    git(w.path, 'switch', '-q', '-c', 'feat/renamed');
    ctx.events.length = 0;
    const [listed] = await ctx.workspaces.list();
    expect(listed).toMatchObject({ branch: 'feat/renamed', repos: [{ branch: 'feat/renamed' }] });
    expect(ctx.events).toEqual([{ type: 'workspace.changed', workspace: listed }]);
    ctx.events.length = 0;
    await ctx.workspaces.list();
    expect(ctx.events).toEqual([]);

    git(w.path, 'switch', '-q', 'feat/del');
    const status = await ctx.git.status(w.path);
    expect(ctx.workspaces.noteStatus(status).map((x) => x.branch)).toEqual(['feat/del']);
    expect(ctx.workspaces.noteStatus(status)).toEqual([]);
  });
});

describe('branchSlug', () => {
  it('turns branch names into folder names', () => {
    expect(branchSlug('feat/oauth')).toBe('feat-oauth');
    expect(branchSlug('fix/rate limit//x')).toBe('fix-rate-limit-x');
    expect(branchSlug('../..')).toBe('branch');
  });
});
