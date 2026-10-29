import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSessionId, BoardState, WorkspaceId } from '@agentdeck/contracts';
import { createFakeServices } from '../src/api.ts';
import { FakeAppService } from '../src/app-service.ts';
import { FakeBoardStore } from '../src/board-store.ts';
import { FakeBrowserService } from '../src/browser-service.ts';

const HOME = '/Users/you';

function setup() {
  const { bus, fakes } = createFakeServices({ home: HOME });
  fakes.git.addRepo({ path: `${HOME}/code/app`, branches: [{ name: 'existing' }] });
  fakes.git.addRepo({ path: `${HOME}/code/multi/web` });
  fakes.git.addRepo({ path: `${HOME}/code/multi/api`, defaultBranch: 'master' });
  return { bus, ...fakes };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('FakeProjectService', () => {
  it('probes folders', async () => {
    const { projects } = setup();
    expect(await projects.probe(`${HOME}/code/app/src`)).toEqual({
      kind: 'git',
      folder: `${HOME}/code/app/src`,
      repoRoot: `${HOME}/code/app`,
      usedRepoRoot: true,
    });
    expect(await projects.probe(`${HOME}/code/multi`)).toEqual({
      kind: 'multi-repo',
      folder: `${HOME}/code/multi`,
      repos: [
        { name: 'api', path: `${HOME}/code/multi/api` },
        { name: 'web', path: `${HOME}/code/multi/web` },
      ],
    });
    expect(await projects.probe(`${HOME}/notes`)).toEqual({ kind: 'plain', folder: `${HOME}/notes` });
  });

  it('adds git, multi-repo, separate and plain projects', async () => {
    const { projects, bus } = setup();
    const [app] = await projects.add({ folder: `${HOME}/code/app`, as: 'git' });
    expect(app).toMatchObject({
      name: 'app',
      kind: 'git',
      repos: [{ name: '.', path: `${HOME}/code/app`, baseBranch: 'main' }],
      worktreeRoot: `${HOME}/.agentdeck/worktrees/app`,
      copyIntoWorktrees: ['.env', '.env.local'],
      missing: false,
    });
    expect(await projects.probe(`${HOME}/code/app`)).toMatchObject({ kind: 'already-added' });

    const [multi] = await projects.add({ folder: `${HOME}/code/multi`, as: 'multi-repo' });
    expect(multi?.repos.map((r) => [r.name, r.baseBranch])).toEqual([
      ['api', 'master'],
      ['web', 'main'],
    ]);
    await projects.remove(multi!.id);
    const separate = await projects.add({ folder: `${HOME}/code/multi`, as: 'separately' });
    expect(separate.map((p) => p.name)).toEqual(['api', 'web']);
    await expect(projects.add({ folder: `${HOME}/notes`, as: 'git' })).rejects.toMatchObject({ code: 'not-a-git-repo' });
    const [plain] = await projects.add({ folder: `${HOME}/notes`, as: 'plain' });
    expect(plain?.repos).toEqual([]);

    // 最近用过的在前
    expect((await projects.list()).map((p) => p.name)).toEqual(['notes', 'web', 'api', 'app']);
    expect(bus.eventsOf('project.changed')).toHaveLength(5);
    expect(bus.eventsOf('project.removed')).toHaveLength(1);
  });

  it('updates, locates and initialises git', async () => {
    const { projects, git } = setup();
    const [plain] = await projects.add({ folder: `${HOME}/notes`, as: 'plain' });
    const updated = await projects.update(plain!.id, { name: 'Notes', setupCommand: 'make' });
    expect(updated).toMatchObject({ name: 'Notes', setupCommand: 'make' });
    projects.setMissing(plain!.id, true);
    expect((await projects.locate(plain!.id, `${HOME}/moved/notes`)).missing).toBe(false);
    const asGit = await projects.initGit(plain!.id);
    expect(asGit).toMatchObject({ kind: 'git', repos: [{ name: '.', path: `${HOME}/moved/notes`, baseBranch: 'main' }] });
    expect(await git.repoRoot(`${HOME}/moved/notes`)).toBe(`${HOME}/moved/notes`);
    await expect(projects.initGit(plain!.id)).rejects.toMatchObject({ code: 'invalid-argument' });

    const [app] = await projects.add({ folder: `${HOME}/code/app`, as: 'git' });
    await projects.update(app!.id, { baseBranch: { '.': 'existing' } });
    expect((await git.status(`${HOME}/code/app`)).baseBranch).toBe('existing');
    await expect(projects.update(app!.id, { baseBranch: { nope: 'x' } })).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});

describe('FakeWorkspaceService', () => {
  it('creates a worktree workspace and returns the setup command', async () => {
    const { projects, workspaces, git, bus } = setup();
    const [app] = await projects.add({ folder: `${HOME}/code/app`, as: 'git' });
    await projects.update(app!.id, { setupCommand: 'pnpm install' });
    const { workspace, setup: s } = await workspaces.create({
      projectId: app!.id,
      mode: 'worktree',
      branch: { kind: 'new', name: 'feat/login', from: 'main' },
    });
    const path = `${HOME}/.agentdeck/worktrees/app/feat-login`;
    expect(workspace).toMatchObject({ name: 'feat/login', mode: 'worktree', path, branch: 'feat/login' });
    expect(s).toEqual({ command: 'pnpm install', cwd: path });
    expect((await git.status(path)).branch).toBe('feat/login');
    expect(bus.eventsOf('workspace.progress').map((e) => e.step)).toEqual(['worktree', 'copy-files', 'done']);

    // 同一个分支不能检出两次
    await expect(
      workspaces.create({ projectId: app!.id, mode: 'worktree', branch: { kind: 'existing', name: 'feat/login' } }),
    ).rejects.toMatchObject({ code: 'branch-in-use' });
  });

  it('main folder workspace: one per project, no setup', async () => {
    const { projects, workspaces } = setup();
    const [app] = await projects.add({ folder: `${HOME}/code/app`, as: 'git' });
    const { workspace, setup: s } = await workspaces.create({ projectId: app!.id, mode: 'main-folder' });
    expect(workspace).toMatchObject({ name: 'app', branch: 'main', path: `${HOME}/code/app` });
    expect(s).toBeNull();
    await expect(workspaces.create({ projectId: app!.id, mode: 'main-folder' })).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    const [plain] = await projects.add({ folder: `${HOME}/notes`, as: 'plain' });
    await expect(
      workspaces.create({ projectId: plain!.id, mode: 'worktree', branch: { kind: 'new', name: 'x', from: 'main' } }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    expect((await workspaces.create({ projectId: plain!.id, mode: 'main-folder' })).workspace).toMatchObject({
      branch: null,
      repos: [],
    });
  });

  it('multi-repo create rolls back when one repo fails', async () => {
    const { projects, workspaces, git } = setup();
    const [multi] = await projects.add({ folder: `${HOME}/code/multi`, as: 'multi-repo' });
    // api 的默认分支是 master，先补一个 main，让 from: 'main' 两边都能用
    await git.createBranch(`${HOME}/code/multi/api`, 'main', { switchTo: false });
    // web 上已经有这个分支 → web 失败，api 上建好的要回滚
    await git.createBranch(`${HOME}/code/multi/web`, 'feat/x', { switchTo: false });
    await expect(
      workspaces.create({ projectId: multi!.id, mode: 'worktree', branch: { kind: 'new', name: 'feat/x', from: 'main' } }),
    ).rejects.toMatchObject({ code: 'branch-exists' });
    expect((await git.worktrees(`${HOME}/code/multi/api`)).map((w) => w.path)).toEqual([`${HOME}/code/multi/api`]);
    expect((await git.branches(`${HOME}/code/multi/api`)).map((b) => b.name)).not.toContain('feat/x');
    expect(await workspaces.list()).toEqual([]);

    const { workspace } = await workspaces.create({
      projectId: multi!.id,
      mode: 'worktree',
      repos: ['web'],
      name: 'Only web',
      branch: { kind: 'existing', name: 'feat/x' },
    });
    expect(workspace).toMatchObject({
      name: 'Only web',
      path: `${HOME}/.agentdeck/worktrees/multi/feat-x`,
      repos: [{ name: 'web', path: `${HOME}/.agentdeck/worktrees/multi/feat-x/web`, branch: 'feat/x' }],
    });
  });

  it('renames, removes with or without the folder, and follows project removal', async () => {
    const { projects, workspaces, git, bus } = setup();
    const [app] = await projects.add({ folder: `${HOME}/code/app`, as: 'git' });
    const a = await workspaces.create({ projectId: app!.id, mode: 'worktree', branch: { kind: 'new', name: 'a', from: 'main' } });
    const b = await workspaces.create({ projectId: app!.id, mode: 'worktree', branch: { kind: 'new', name: 'b', from: 'main' } });
    expect((await workspaces.rename(a.workspace.id, 'Renamed')).name).toBe('Renamed');
    await workspaces.remove({ id: a.workspace.id, deleteFolder: true });
    expect((await git.worktrees(`${HOME}/code/app`)).map((w) => w.branch)).toEqual(['main', 'b']);
    expect((await git.branches(`${HOME}/code/app`)).map((x) => x.name)).toContain('a');
    await projects.remove(app!.id);
    expect(await workspaces.list()).toEqual([]);
    expect(bus.eventsOf('workspace.removed').map((e) => e.id)).toEqual([a.workspace.id, b.workspace.id]);
    await expect(workspaces.rename('nope' as WorkspaceId, 'x')).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('FakeAgentService', () => {
  it('lists agents and starts terminals with adapter-like commands', async () => {
    const { agents, terminals, status } = setup();
    expect((await agents.list()).map((a) => [a.id, a.installed])).toEqual([
      ['claude', true],
      ['codex', true],
      ['gemini', false],
      ['shell', true],
    ]);
    const claude = await agents.start({ agent: 'claude', cwd: '/w', workspaceId: null, mode: { kind: 'new' } });
    expect(claude.cmd).toBe('claude');
    expect(claude.args).toEqual(['--session-id', claude.sessionId]);
    expect(terminals.get(claude.terminalId).request.cwd).toBe('/w');
    expect((await status.snapshot()).find((s) => s.terminalId === claude.terminalId)?.status).toBe('starting');

    const sid = 'abc' as AgentSessionId;
    expect(await agents.start({ agent: 'codex', cwd: '/w', workspaceId: null, mode: { kind: 'resume', sessionId: sid } })).toMatchObject({
      cmd: 'codex',
      args: ['resume', 'abc'],
      sessionId: sid,
    });
    expect(
      (await agents.start({ agent: 'shell', cwd: '/w', workspaceId: null, mode: { kind: 'new' }, command: 'pnpm dev' })).args,
    ).toEqual(['-lc', 'pnpm dev']);
    expect(
      await agents.start({ agent: 'custom', cwd: '/w', workspaceId: null, mode: { kind: 'new' }, command: 'make watch' }),
    ).toMatchObject({ cmd: 'make', args: ['watch'] });
  });

  it('rejects missing agents and unsupported modes', async () => {
    const { agents } = setup();
    await expect(agents.start({ agent: 'gemini', cwd: '/w', workspaceId: null, mode: { kind: 'new' } })).rejects.toMatchObject({
      code: 'command-not-found',
    });
    await expect(
      agents.start({ agent: 'shell', cwd: '/w', workspaceId: null, mode: { kind: 'fork', sessionId: 'x' as AgentSessionId } }),
    ).rejects.toMatchObject({ code: 'unsupported' });
    agents.setAgent('codex', { capabilities: { hooks: false, resume: true, fork: false, askTool: false } });
    await expect(
      agents.start({ agent: 'codex', cwd: '/w', workspaceId: null, mode: { kind: 'fork', sessionId: 'x' as AgentSessionId } }),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('lastReply (contracts 0.1.22): the preset transcript reply, else the screen; sendText types literally', async () => {
    const { agents, terminals } = setup();
    const { terminalId } = await agents.start({ agent: 'claude', cwd: '/w', workspaceId: null, mode: { kind: 'new' } });
    terminals.feed(terminalId, '⏺ Done.\r\n');
    expect(await agents.lastReply(terminalId)).toEqual({ text: '⏺ Done.', source: 'screen', at: null });
    agents.setLastReply(terminalId, 'Done. All tests pass.', '2026-10-28T08:00:00.000Z');
    expect(await agents.lastReply(terminalId)).toEqual({ text: 'Done. All tests pass.', source: 'transcript', at: '2026-10-28T08:00:00.000Z' });
    await expect(agents.lastReply('nope' as never)).rejects.toMatchObject({ code: 'not-found' });
    await terminals.sendText(terminalId, 'Enter;');
    expect(terminals.get(terminalId).texts).toEqual(['Enter;']);
    expect(terminals.get(terminalId).keys).toEqual([]);
  });
});

describe('FakeStatusService and FakeApprovalService', () => {
  const ws = 'ws-1' as WorkspaceId;

  async function startClaude(s: ReturnType<typeof setup>) {
    return (await s.agents.start({ agent: 'claude', cwd: '/w', workspaceId: ws, mode: { kind: 'new' } })).terminalId;
  }

  it('follows terminal activity, silence and exit', async () => {
    const s = setup();
    const id = await startClaude(s);
    s.terminals.feed(id, 'hello');
    expect((await s.status.snapshot())[0]?.status).toBe('running');
    await vi.advanceTimersByTimeAsync(3000);
    expect((await s.status.snapshot())[0]?.status).toBe('idle');
    s.terminals.exit(id, 1);
    expect((await s.status.snapshot())[0]).toMatchObject({ status: 'error', exitCode: 1 });
  });

  it('approval flow: needs-approval → approve sends keys → running, recorded in history', async () => {
    const s = setup();
    const id = await startClaude(s);
    const req = s.status.requestApproval(id, { summary: 'pnpm test', command: 'pnpm test' });
    expect(req).toMatchObject({ kind: 'approval', destructive: false, workspaceId: ws, agent: 'claude' });
    const snap = (await s.status.snapshot())[0];
    expect(snap).toMatchObject({ status: 'needs-approval', pending: { id: req!.id } });
    // 等待状态不会被新输出改掉
    s.terminals.feed(id, 'Allow? ');
    expect((await s.status.snapshot())[0]?.status).toBe('needs-approval');

    expect(await s.approvals.approve([req!.id])).toEqual([{ id: req!.id, ok: true }]);
    expect(s.terminals.get(id).keys).toEqual([['Enter']]);
    expect((await s.status.snapshot())[0]).toMatchObject({ status: 'running', pending: null });
    expect(await s.approvals.approve([req!.id])).toEqual([{ id: req!.id, ok: false, reason: 'gone' }]);
    expect(await s.approvals.history(ws, 10)).toMatchObject([{ by: 'user', request: { summary: 'pnpm test' } }]);
  });

  it('marks destructive commands and supports auto-approve', async () => {
    const s = setup();
    const id = await startClaude(s);
    await s.approvals.setAutoApprove(ws, true);
    expect(s.status.requestApproval(id, { summary: 'pnpm lint', command: 'pnpm lint' })).toBeNull();
    expect(s.bus.eventsOf('approval.auto-approved')).toHaveLength(1);
    const risky = s.status.requestApproval(id, { summary: 'rm -rf dist', command: 'rm -rf dist' });
    expect(risky).toMatchObject({ destructive: true });
    expect((await s.status.snapshot())[0]?.status).toBe('needs-approval');
    expect((await s.approvals.history(ws, 10)).map((r) => r.by)).toEqual(['auto-approve']);
  });

  it('approve-all, unsupported agents and stuck terminals', async () => {
    const s = setup();
    const a = await startClaude(s);
    const b = (await s.agents.start({ agent: 'shell', cwd: '/w', workspaceId: ws, mode: { kind: 'new' } })).terminalId;
    const c = await startClaude(s);
    const ra = s.status.requestApproval(a, { summary: 'x' })!;
    const rb = s.status.requestApproval(b, { summary: 'y' })!;
    const rc = s.status.requestApproval(c, { summary: 'z' })!;
    s.approvals.simulateStuck(c);
    const p = s.approvals.approve([ra.id, rb.id, rc.id]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await p).toEqual([
      { id: ra.id, ok: true },
      { id: rb.id, ok: false, reason: 'unsupported' },
      { id: rc.id, ok: false, reason: 'couldnt-approve' },
    ]);
    expect((await s.approvals.history(ws, 10)).map((r) => r.by)).toEqual(['approve-all']);
  });

  it('questions and turn end', async () => {
    const s = setup();
    const id = await startClaude(s);
    expect(s.status.askQuestion(id, 'Which DB?')).toMatchObject({ kind: 'question' });
    expect((await s.status.snapshot())[0]?.status).toBe('needs-reply');
    expect(s.status.pending()).toHaveLength(1);
    s.status.turnEnd(id);
    expect((await s.status.snapshot())[0]).toMatchObject({ status: 'idle', pending: null });
    expect(s.bus.eventsOf('agent.turn-end')).toEqual([{ type: 'agent.turn-end', terminalId: id, workspaceId: ws }]);
  });
});

describe('FakeBoardStore, FakeBrowserService, FakeAppService', () => {
  it('board load / save round-trips copies', async () => {
    const board = new FakeBoardStore();
    const empty = await board.load();
    expect(empty).toMatchObject({ version: 1, frames: [], windows: [] });
    const next: BoardState = { ...empty, viewport: { x: 10, y: 20, zoom: 2 } };
    await board.save(next);
    next.viewport.zoom = 99;
    expect((await board.load()).viewport).toEqual({ x: 10, y: 20, zoom: 2 });
    expect(board.saves).toBe(1);
  });

  it('browser prepares localhost and local files', async () => {
    const browser = new FakeBrowserService();
    expect(await browser.prepare('http://localhost:5173/login')).toEqual({ src: 'http://localhost:5173/login', mode: 'frame' });
    expect([...browser.allowedOrigins]).toEqual(['http://localhost:5173']);
    expect(await browser.prepare('/Users/me/report.html')).toEqual({ src: 'agentdeck-file:///Users/me/report.html', mode: 'frame' });
    expect(await browser.fileUrl('/Users/me/my report.html')).toBe('agentdeck-file:///Users/me/my%20report.html');
    await expect(browser.prepare('not a url')).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(await browser.ping('http://localhost:5173/x')).toEqual({ ok: true, status: 200 });
    browser.setReachable('http://localhost:5173', false);
    expect(await browser.ping('http://localhost:5173/x')).toEqual({ ok: false, status: null });
    await browser.openExternal('https://example.com');
    expect(browser.opened).toEqual(['https://example.com']);
  });

  it('app records calls and merges settings', async () => {
    const app = new FakeAppService({ defaultPick: '/default' });
    app.queuePickFolder('/a', null);
    expect(await app.pickFolder({ title: 'Add project' })).toBe('/a');
    expect(await app.pickFolder({ title: 'Add project' })).toBeNull();
    expect(await app.pickFolder({ title: 'Add project' })).toBe('/default');
    await app.openInEditor('/x.ts', 3);
    await app.moveToTrash('/tmp/x');
    expect(app.calls.map((c) => c.method)).toEqual(['openInEditor', 'moveToTrash']);
    const events: string[] = [];
    app.bus.on('app.settings', (e) => events.push(e.settings.editorCommand));
    expect((await app.updateSettings({ editorCommand: 'cursor -g' })).closeWindow).toBe('background');
    expect(events).toEqual(['cursor -g']);
    app.setBadge(3);
    await app.quit({ stopTerminals: true });
    expect([app.badge, app.quitRequest]).toEqual([3, { stopTerminals: true }]);
  });
});
