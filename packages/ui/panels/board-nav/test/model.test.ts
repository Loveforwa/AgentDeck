import type { FrameNode, Project, ProjectId, StatusSnapshot, TerminalId, WindowId, WindowNode, Workspace, WorkspaceId } from '@agentdeck/contracts';
import { describe, expect, it } from 'vitest';
import { buildTree, navWindow, windowName } from '../src/index.ts';

const P = 'prj-a' as ProjectId;
const WS = 'ws-a' as WorkspaceId;

function project(id: ProjectId, name: string): Project {
  return { id, name, kind: 'git', path: `/p/${name}`, repos: [], worktreeRoot: '/w', copyIntoWorktrees: [], setupCommand: null, missing: false, lastUsedAt: '' };
}

function workspace(id: WorkspaceId, branch: string | null, name = 'main'): Workspace {
  return { id, projectId: P, name, mode: 'main-folder', path: '/p/a', branch, repos: [], createdAt: '', missing: false };
}

function frame(ws: WorkspaceId, x: number, y: number): FrameNode {
  return { workspaceId: ws, rect: { x, y, w: 400, h: 300 }, z: 0, autoApprove: false };
}

function term(id: string, ws: WorkspaceId | null, x: number, y: number, extra: Partial<WindowNode> = {}, agent = 'claude', terminalId: string | null = `t-${id}`): WindowNode {
  return {
    id: id as WindowId,
    type: 'terminal',
    workspaceId: ws,
    rect: { x, y, w: 100, h: 100 },
    z: 0,
    title: null,
    restoreRect: null,
    data: { terminalId, agent, cmd: agent === 'shell' ? '/bin/zsh' : agent, args: [], cwd: '/', sessionId: null, startCommand: null },
    ...extra,
  };
}

function snap(terminalId: string, status: StatusSnapshot['status']): StatusSnapshot {
  return { terminalId: terminalId as TerminalId, status, since: '', exitCode: null, pending: null };
}

describe('windowName', () => {
  it('uses the rename, then the agent, the command name or the host', () => {
    expect(windowName(term('a', WS, 0, 0))).toBe('claude');
    expect(windowName(term('a', WS, 0, 0, {}, 'shell'))).toBe('zsh');
    expect(windowName(term('a', WS, 0, 0, { title: 'setup' }))).toBe('setup');
    const browser: WindowNode = { ...term('b', WS, 0, 0), type: 'browser', data: { url: 'http://localhost:5173/x', mode: 'frame' } };
    expect(windowName(browser)).toBe('localhost:5173');
    expect(windowName({ ...browser, data: { url: '/Users/you/notes.html', mode: 'frame' } })).toBe('/Users/you/notes.html');
    expect(windowName({ ...browser, type: 'notes', data: {} })).toBe('notes');
  });
});

describe('navWindow lamps', () => {
  const cases: [StatusSnapshot['status'], string, boolean][] = [
    ['starting', 'idle', false],
    ['running', 'running', false],
    ['needs-approval', 'waiting', true],
    ['needs-reply', 'waiting', true],
    ['idle', 'idle', false],
    ['exited', 'exited', false],
    ['error', 'error', false],
  ];
  it.each(cases)('%s → %s', (status, lamp, waiting) => {
    const w = navWindow(term('a', WS, 0, 0), { statuses: { 't-a': snap('t-a', status) }, badges: {} });
    expect(w.lamp).toBe(lamp);
    expect(w.waiting).toBe(waiting);
  });

  it('falls back to the badge, then idle; a terminal whose session is gone is exited', () => {
    expect(navWindow(term('a', WS, 0, 0), { statuses: {}, badges: {} }).lamp).toBe('idle');
    expect(navWindow(term('a', WS, 0, 0), { statuses: {}, badges: { a: { text: 'Running', tone: 'running', dot: 'filled' } } }).lamp).toBe('running');
    expect(navWindow(term('a', WS, 0, 0, {}, 'claude', null), { statuses: {}, badges: {} }).lamp).toBe('exited');
  });
});

describe('buildTree', () => {
  it('groups by project and orders frames and windows by position', () => {
    const ws2 = 'ws-b' as WorkspaceId;
    const tree = buildTree({
      projects: [project(P, 'a')],
      workspaces: { [WS]: workspace(WS, 'main'), [ws2]: workspace(ws2, null, 'notes') },
      // ws2 的框在上面，排在前面
      frames: [frame(WS, 0, 500), frame(ws2, 0, 0)],
      windows: [term('right', WS, 300, 520), term('left', WS, 20, 530), term('b1', ws2, 10, 10), term('loose', null, 0, 0)],
      statuses: {},
      badges: {},
    });
    expect(tree.projects).toHaveLength(1);
    const [first, second] = tree.projects[0]!.workspaces;
    expect(first).toMatchObject({ id: ws2, label: 'notes', isBranch: false });
    expect(second).toMatchObject({ id: WS, label: 'main', isBranch: true });
    expect(second!.windows.map((w) => w.id)).toEqual(['left', 'right']);
    expect(tree.loose.map((w) => w.id)).toEqual(['loose']);
  });

  it('puts windows of a workspace without a frame with the loose ones', () => {
    const tree = buildTree({
      projects: [project(P, 'a')],
      workspaces: { [WS]: workspace(WS, 'main') },
      frames: [],
      windows: [term('a', WS, 0, 0)],
      statuses: {},
      badges: {},
    });
    expect(tree.projects[0]!.workspaces).toEqual([]);
    expect(tree.loose.map((w) => w.id)).toEqual(['a']);
  });
});
