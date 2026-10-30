// MP2：管理面板的数据——开着的窗口和历史会话合成一行、NEEDS YOU、PINNED、项目 → 工作路径 → 行、搜索；
// 以及从 BoardNav 搬过来的窗口名字、状态灯、窗口组名字、状态文字、⌥⌘1–9 的顺序。
import type { AgentSessionId, BoardPin, ProjectId, StatusSnapshot, WindowGroupId, WindowId, WindowNode, WorkspaceId } from '@agentdeck/contracts';
import { describe, expect, it } from 'vitest';
import { buildManager, groupNames, needsYouOrder, openWindow, relativeTime, shortPath, statusText, windowName, type ManagerInput } from '../src/index.ts';
import { NOW, SESSIONS, at, board, browser, frame, snap, term } from './fixtures.ts';

const input = (over: Partial<ManagerInput> = {}): ManagerInput => ({
  ...board(),
  sessions: SESSIONS,
  pins: [],
  activeProjectId: null,
  query: '',
  ...over,
});

const keysOf = (rows: { key: string }[]) => rows.map((r) => r.key);

describe('manager · tree', () => {
  it('one row per terminal: the open claude is the c1 session row with a lamp, open rows first, Other folders last', () => {
    const v = buildManager(input());
    expect(v.projects.map((p) => p.name)).toEqual(['shop', 'api', 'Not in a workspace', 'Other folders']);
    const shop = v.projects[0]!;
    // 白板上有框的 main 在前，其余按最后活动
    expect(shop.paths.map((p) => p.label)).toEqual(['main', 'feat/login', 'feat-old']);
    const main = shop.paths[0]!;
    expect(main.detail).toBe('main folder');
    // c2 的目录在主目录下面，归到 main
    expect(keysOf(main.rows)).toEqual(['session:claude:c1', 'window:win-sh', 'session:codex:x1', 'session:claude:c2']);
    expect(main.rows[0]!.open?.lamp).toBe('running');
    expect(main.rows[0]!.title).toBe('Fix the login bug');
    expect(main.rows[1]!.title).toBe('zsh');
    expect(main.count).toBe(4);
    // c1 只出现一次
    const all = v.projects.flatMap((p) => p.paths.flatMap((x) => x.rows));
    expect(all.filter((r) => r.key === 'session:claude:c1')).toHaveLength(1);
    // 散放的网页在 Not in a workspace；/tmp 的会话在 Other folders
    expect(v.projects[2]!.paths[0]!.rows.map((r) => r.open?.name)).toEqual(['localhost:5173']);
    expect(v.projects[3]!.paths[0]!.rows.map((r) => r.key)).toEqual(['session:kimi:k1']);
  });

  it('lists every project and every workspace with a frame even without sessions; puts the active project first', () => {
    const v = buildManager(input({ sessions: [], frames: [frame('w-main', 0, 0), frame('w-api', 600, 0)] }));
    expect(v.projects.map((p) => p.name)).toEqual(['shop', 'api', 'Not in a workspace']);
    expect(v.projects[1]!.paths.map((p) => [p.label, p.count])).toEqual([['main', 0]]);
    expect(buildManager(input({ activeProjectId: 'p-api' as ProjectId })).projects[0]!.name).toBe('api');
  });

  it('uses the status machine’s session id when the window has none yet (codex, omp)', () => {
    const v = buildManager(
      input({
        windows: [term('win-x', 'w-main', 0, 'codex')],
        statuses: { 't-win-x': { ...snap('t-win-x', 'idle', at(11)), sessionId: 'x1' } as StatusSnapshot },
      }),
    );
    const main = v.projects[0]!.paths[0]!;
    expect(main.rows[0]).toMatchObject({ key: 'session:codex:x1', title: 'Review API' });
    expect(main.rows[0]!.open?.id).toBe('win-x');
  });

  it('search keeps only hits (title, first prompt, branch, window name, topic) and drops empty groups', () => {
    const q = buildManager(input({ query: 'oauth' }));
    expect(q.projects.map((p) => p.name)).toEqual(['shop']);
    expect(keysOf(q.projects[0]!.paths.flatMap((p) => p.rows))).toEqual(['session:claude:c3']);
    const topic = buildManager(input({ query: 'git history', topics: { 't-win-sh': 'Check local git history' } }));
    expect(keysOf(topic.projects.flatMap((p) => p.paths.flatMap((x) => x.rows)))).toEqual(['window:win-sh']);
    expect(buildManager(input({ query: 'localhost' })).projects.map((p) => p.name)).toEqual(['Not in a workspace']);
  });
});

describe('manager · NEEDS YOU and PINNED', () => {
  const waitingBoard = () =>
    board({
      windows: [term('win-1', 'w-main', 0, 'claude', { sessionId: 'c1' }), term('win-2', 'w-main', 200, 'codex'), term('win-3', null, 900, 'claude')],
      statuses: {
        't-win-1': snap('t-win-1', 'needs-approval', at(11, 58)),
        't-win-2': snap('t-win-2', 'error', at(11, 50), 1),
        't-win-3': snap('t-win-3', 'needs-reply', at(11, 55)),
      },
    });

  it('NEEDS YOU lists waiting and failed rows, longest wait first, and they leave the tree', () => {
    const v = buildManager(input(waitingBoard()));
    expect(v.needsYou.map((r) => r.open?.id)).toEqual(['win-2', 'win-3', 'win-1']);
    expect(v.needsYou[2]!.where).toBe('shop · main');
    expect(v.needsYou[1]!.where).toBeNull();
    const main = v.projects[0]!.paths[0]!;
    expect(keysOf(main.rows)).toEqual(['session:codex:x1', 'session:claude:c2']);
    expect(needsYouOrder(waitingBoard())).toEqual(['win-2', 'win-3', 'win-1']);
  });

  it('PINNED keeps pin order: a closed session stays (Resume row), a window, a project and a workspace; pinned rows leave the tree', () => {
    const pins: BoardPin[] = [
      { kind: 'session', agent: 'claude', sessionId: 'c3' as AgentSessionId },
      { kind: 'window', windowId: 'win-sh' as WindowId },
      { kind: 'project', projectId: 'p-api' as ProjectId },
      { kind: 'workspace', workspaceId: 'w-login' as WorkspaceId },
      { kind: 'session', agent: 'claude', sessionId: 'gone' as AgentSessionId },
    ];
    const v = buildManager(input({ pins }));
    expect(v.pinned.map((p) => [p.kind, p.index])).toEqual([
      ['row', 0],
      ['row', 1],
      ['project', 2],
      ['workspace', 3],
    ]);
    const first = v.pinned[0]!;
    expect(first.kind === 'row' && first.row.open).toBeNull();
    expect(first.kind === 'row' && first.row.where).toBe('shop · feat/login');
    expect(v.pinned[3]!.kind === 'workspace' && v.pinned[3]!.label).toBe('shop · feat/login');
    const rest = v.projects.flatMap((p) => p.paths.flatMap((x) => x.rows)).map((r) => r.key);
    expect(rest).not.toContain('session:claude:c3');
    expect(rest).not.toContain('window:win-sh');
  });

  it('a pinned window found by id even after it got a session id; a waiting pinned row shows under NEEDS YOU only', () => {
    const pins: BoardPin[] = [{ kind: 'window', windowId: 'win-1' as WindowId }];
    expect(buildManager(input({ pins })).pinned[0]).toMatchObject({ kind: 'row', row: { key: 'session:claude:c1' } });
    const v = buildManager(input({ ...waitingBoard(), pins }));
    expect(v.pinned).toEqual([]);
    expect(v.needsYou.map((r) => r.open?.id)).toContain('win-1');
  });
});

describe('board rows (from BoardNav)', () => {
  const WS = 'w-main';
  it('windowName uses the rename, then the agent, the command name or the host', () => {
    expect(windowName(term('a', WS, 0))).toBe('claude');
    expect(windowName(term('a', WS, 0, 'shell'))).toBe('zsh');
    expect(windowName(term('a', WS, 0, 'claude', { title: 'setup' }))).toBe('setup');
    expect(windowName(browser('b', WS, 0, 'http://localhost:5173/x'))).toBe('localhost:5173');
    expect(windowName({ ...browser('b', WS, 0), data: { url: '/Users/you/notes.html', mode: 'frame' } })).toBe('/Users/you/notes.html');
  });

  const cases: [StatusSnapshot['status'], string, boolean][] = [
    ['starting', 'idle', false],
    ['running', 'running', false],
    ['needs-approval', 'waiting', true],
    ['needs-reply', 'waiting', true],
    ['idle', 'idle', false],
    ['exited', 'exited', false],
    ['error', 'error', false],
  ];
  it.each(cases)('lamp: %s → %s', (status, lamp, waiting) => {
    const w = openWindow(term('a', WS, 0), { statuses: { 't-a': snap('t-a', status) }, badges: {} });
    expect(w.lamp).toBe(lamp);
    expect(w.waiting).toBe(waiting);
  });

  it('falls back to the badge, then idle; a terminal whose session is gone is exited; a browser with an attention badge waits', () => {
    expect(openWindow(term('a', WS, 0), { statuses: {}, badges: {} }).lamp).toBe('idle');
    expect(openWindow(term('a', WS, 0), { statuses: {}, badges: { a: { text: 'Running', tone: 'running', dot: 'filled' } } }).lamp).toBe('running');
    expect(openWindow(term('a', WS, 0, 'claude', { terminalId: null }), { statuses: {}, badges: {} }).lamp).toBe('exited');
    const web = openWindow(browser('b', WS, 0), { statuses: {}, badges: { b: { text: 'Sign in', tone: 'attention', dot: 'filled', detail: 'Needs sign-in' } } });
    expect([web.lamp, web.waiting, web.detail]).toEqual(['waiting', true, 'Needs sign-in']);
  });

  it('window groups: members named like the group sidebar, the lead “lead”, a renamed window only its rename', () => {
    const G = 'grp-1' as WindowGroupId;
    const lead: WindowNode = { ...term('lead', WS, 0), group: { id: G, role: 'lead', label: null } };
    const api: WindowNode = { ...term('api', WS, 200, 'shell'), group: { id: G, role: 'member', label: 'api' } };
    const plain: WindowNode = { ...term('plain', WS, 400), group: { id: G, role: 'member', label: '  ' } };
    expect(Object.fromEntries(groupNames([lead, api, plain]))).toEqual({ lead: 'lead', api: 'sub-1 · api', plain: 'sub-2' });
    expect(groupNames([api]).size).toBe(0);
    expect(groupNames([lead]).size).toBe(0);
    const renamed = { ...plain, title: 'frontend' };
    expect(openWindow(renamed, { statuses: {}, badges: {} }, groupNames([lead, api, renamed])).group).toBeNull();
  });

  it('status text like the title bar', () => {
    const w = (status: StatusSnapshot['status'] | null, since: string | null, exitCode: number | null = null, lamp: 'waiting' | 'error' | null = null) => ({ status, since, exitCode, lamp });
    expect(statusText(w('needs-reply', at(11, 58)), NOW)).toBe('Waiting · 2m');
    expect(statusText(w('running', at(11, 56)), NOW)).toBe('Running · 4m');
    expect(statusText(w('idle', at(11)), NOW)).toBe('Idle · 1h');
    expect(statusText(w('error', at(11, 55), 1), NOW)).toBe('exit 1 · 5m');
    expect(statusText(w('exited', null), NOW)).toBe('Exited');
    expect(statusText(w('starting', null), NOW)).toBe('Starting');
    expect(statusText(w(null, null), NOW)).toBe('');
    expect(statusText(w(null, null, null, 'waiting'), NOW)).toBe('Waiting');
  });

  it('short paths and relative times', () => {
    expect(shortPath('/Users/me/code/x', '/Users/me')).toBe('~/code/x');
    expect(relativeTime(at(12), NOW)).toBe('now');
    expect(relativeTime(at(9), NOW)).toBe('3h');
    expect(relativeTime(new Date(NOW - 3 * 86_400_000).toISOString(), NOW)).toBe('3d');
    expect(relativeTime('2026-10-12T10:00:00.000Z', NOW)).toBe('12 Oct');
  });
});
