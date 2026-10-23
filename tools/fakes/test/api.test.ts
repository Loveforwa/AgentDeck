import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONTRACTS_VERSION } from '@agentdeck/contracts';
import type { AgentDeckApi, StatusSnapshot, TerminalDataMessage } from '@agentdeck/contracts';
import { SAMPLE, createFakeApi } from '../src/index.ts';
import type { FakeApi } from '../src/index.ts';

let api: FakeApi;
beforeEach(() => {
  vi.useFakeTimers();
  api = createFakeApi();
});
afterEach(() => {
  api.dispose();
  vi.useRealTimers();
});

describe('createFakeApi sample data', () => {
  it('is a full AgentDeckApi', () => {
    const typed: AgentDeckApi = api;
    expect(typed.contractsVersion).toBe(CONTRACTS_VERSION);
  });

  it('has 2 projects, 3 workspaces, 5 terminals and one waiting on approval', async () => {
    expect((await api.projects.list()).map((p) => p.id)).toEqual([SAMPLE.projects.agentdeck, SAMPLE.projects.shop]);
    expect(await api.workspaces.list()).toHaveLength(3);
    expect(await api.terminals.list()).toHaveLength(5);
    const statuses = Object.fromEntries((await api.status.snapshot()).map((s) => [s.terminalId, s.status]));
    expect(statuses).toEqual({
      [SAMPLE.terminals.devServer]: 'running',
      [SAMPLE.terminals.loginClaude]: 'running',
      [SAMPLE.terminals.loginCodex]: 'needs-approval',
      [SAMPLE.terminals.shopClaude]: 'idle',
      [SAMPLE.terminals.shopShell]: 'error',
    });
    const board = await api.board.load();
    expect(board.frames).toHaveLength(3);
    expect(board.windows.filter((w) => w.type === 'terminal')).toHaveLength(5);
    expect(api.bus.log).toEqual([]);
  });

  it('git state matches the workspaces', async () => {
    const s = await api.git.status(SAMPLE.paths.agentdeckLogin);
    expect(s).toMatchObject({ branch: 'feat/login', aheadOfBase: 2, ahead: 1, upstream: 'origin/feat/login' });
    expect(s.files).toHaveLength(3);
    for (const ws of await api.workspaces.list()) {
      for (const r of ws.repos) expect((await api.git.status(r.path)).branch).toBe(r.branch);
    }
    expect(await api.projects.probe(SAMPLE.paths.blog)).toMatchObject({ kind: 'git' });
    expect(await api.app.pickFolder({ title: 'Add project' })).toBe(SAMPLE.paths.notes);
  });

  it('every terminal has output once attached', async () => {
    for (const t of await api.terminals.list()) await api.terminals.attach(t.id, { cols: 100, rows: 30 });
    await vi.advanceTimersByTimeAsync(10_000);
    for (const t of await api.terminals.list()) {
      expect((await api.terminals.lastLines(t.id, 5)).length).toBeGreaterThan(0);
    }
  });
});

describe('approving the sample codex terminal', () => {
  it('resumes its recording', async () => {
    const id = SAMPLE.terminals.loginCodex;
    const data: TerminalDataMessage[] = [];
    api.onTerminalData((m) => data.push(m));
    await api.terminals.attach(id, { cols: 100, rows: 30 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(data.map((m) => m.data).join('')).toContain('(y/n)');

    const [snap] = (await api.status.snapshot()).filter((s) => s.terminalId === id);
    const result = await api.approvals.approve([snap!.pending!.id]);
    expect(result).toEqual([{ id: snap!.pending!.id, ok: true }]);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await api.terminals.lastLines(id, 3)).join('\n')).toContain('All 12 tests pass');
  });
});

describe('scenario', () => {
  it('agentNeedsApproval moves a terminal to needs-approval and prints the prompt', async () => {
    const changes: StatusSnapshot[] = [];
    api.on('status.changed', (e) => changes.push(e.snapshot));
    const id = SAMPLE.terminals.shopClaude;
    const pending = api.scenario.agentNeedsApproval(id, { command: 'git push --force' });
    expect(pending).toMatchObject({ destructive: true, summary: 'git push --force' });
    expect(changes.at(-1)).toMatchObject({ terminalId: id, status: 'needs-approval' });
    expect((await api.terminals.lastLines(id, 1))[0]).toContain('(y/n)');
  });

  it('turn end with changes refreshes git and emits agent.turn-end', () => {
    const seen: string[] = [];
    api.on('git.status', () => seen.push('git'));
    api.on('agent.turn-end', () => seen.push('turn-end'));
    api.scenario.agentTurnEnd(SAMPLE.terminals.loginClaude, {
      repo: SAMPLE.paths.agentdeckLogin,
      files: [{ path: 'src/session.ts', unstaged: 'untracked' }],
    });
    expect(seen).toEqual(['git', 'turn-end']);
  });

  it('dev server link, exits, missing folders and host lost', async () => {
    const links: string[] = [];
    api.on('terminal.link', (e) => {
      if (e.link.kind === 'localhost') links.push(e.link.url);
    });
    api.scenario.devServerStarts(SAMPLE.terminals.devServer, 'http://localhost:3000/');
    expect(links).toEqual(['http://localhost:3000/']);

    api.scenario.terminalExits(SAMPLE.terminals.devServer, 0);
    expect((await api.status.snapshot()).find((s) => s.terminalId === SAMPLE.terminals.devServer)?.status).toBe('exited');

    api.scenario.projectFolderMissing(SAMPLE.projects.shop);
    expect((await api.projects.list()).find((p) => p.id === SAMPLE.projects.shop)?.missing).toBe(true);
    api.scenario.workspaceFolderMissing(SAMPLE.workspaces.shopCart);
    expect((await api.workspaces.list()).find((w) => w.id === SAMPLE.workspaces.shopCart)?.missing).toBe(true);

    let lost = false;
    api.on('terminal.host-lost', () => (lost = true));
    api.scenario.hostLost();
    expect(lost).toBe(true);
    expect(await api.terminals.list()).toEqual([]);
  });

  it('agentAsks and notificationClicked', async () => {
    const focused: string[] = [];
    api.on('app.focus-terminal', (e) => focused.push(e.terminalId));
    api.scenario.agentAsks(SAMPLE.terminals.loginClaude, 'Use Postgres or SQLite?');
    expect((await api.status.snapshot()).find((s) => s.terminalId === SAMPLE.terminals.loginClaude)).toMatchObject({
      status: 'needs-reply',
      pending: { kind: 'question', summary: 'Use Postgres or SQLite?' },
    });
    api.scenario.notificationClicked(SAMPLE.terminals.loginClaude);
    expect(focused).toEqual([SAMPLE.terminals.loginClaude]);
  });
});

describe('createFakeApi options', () => {
  it('seed: false starts empty', async () => {
    const empty = createFakeApi({ seed: false });
    expect(await empty.projects.list()).toEqual([]);
    expect(await empty.terminals.list()).toEqual([]);
    expect((await empty.board.load()).windows).toEqual([]);
  });

  it('latencyMs delays async calls but not fire-and-forget ones', async () => {
    const slow = createFakeApi({ latencyMs: 200 });
    let done = false;
    const p = slow.projects.list().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(199);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(done).toBe(true);
    expect(slow.app.setBadge(2)).toBeUndefined();
    expect(slow.fakes.app.badge).toBe(2);
  });

  it('methods can be destructured like the real preload API', async () => {
    const { list } = api.projects;
    expect(await list()).toHaveLength(2);
  });

  it('new agent terminals pick a recording by command', async () => {
    const { terminalId } = await api.agents.start({
      agent: 'claude',
      cwd: SAMPLE.paths.agentdeckLogin,
      workspaceId: SAMPLE.workspaces.agentdeckLogin,
      mode: { kind: 'new' },
    });
    expect(api.fakes.terminals.get(terminalId).recording).toBe('claude-chat');
    const shell = await api.agents.start({
      agent: 'shell',
      cwd: SAMPLE.paths.agentdeck,
      workspaceId: SAMPLE.workspaces.agentdeckMain,
      mode: { kind: 'new' },
      command: 'pnpm dev',
    });
    expect(api.fakes.terminals.get(shell.terminalId).recording).toBe('pnpm-dev');
  });
});
