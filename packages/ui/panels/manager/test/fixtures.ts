// 测试用的白板和历史会话：shop（main 主目录在白板上、feat/login worktree）、api（主目录）、/tmp 里的散会话。
import type { FrameNode, Project, ProjectId, SessionSummary, StatusSnapshot, TerminalId, WindowId, WindowNode, Workspace, WorkspaceId } from '@agentdeck/contracts';
import { fakeSession } from '@agentdeck/fakes';
import type { BoardInput } from '../src/index.ts';

export const project = (id: string, path: string, name = id): Project => ({
  id: id as ProjectId,
  name,
  kind: 'git',
  path,
  repos: [],
  worktreeRoot: `/home/.agentdeck/worktrees/${name}`,
  copyIntoWorktrees: [],
  setupCommand: null,
  missing: false,
  lastUsedAt: '2026-10-26T00:00:00.000Z',
});

export const workspace = (id: string, projectId: string, path: string, branch: string | null, mode: Workspace['mode'] = 'worktree'): Workspace => ({
  id: id as WorkspaceId,
  projectId: projectId as ProjectId,
  name: branch ?? id,
  mode,
  path,
  branch,
  repos: [],
  createdAt: '2026-10-26T00:00:00.000Z',
  missing: false,
});

export const frame = (ws: string, x: number, y: number): FrameNode => ({ workspaceId: ws as WorkspaceId, rect: { x, y, w: 400, h: 300 }, z: 0, autoApprove: false });

export function term(id: string, ws: string | null, x: number, agent = 'claude', extra: { sessionId?: string | null; title?: string | null; terminalId?: string | null } = {}): WindowNode {
  return {
    id: id as WindowId,
    type: 'terminal',
    workspaceId: ws as WorkspaceId | null,
    rect: { x, y: 0, w: 100, h: 100 },
    z: 0,
    title: extra.title ?? null,
    restoreRect: null,
    data: {
      terminalId: extra.terminalId === undefined ? `t-${id}` : extra.terminalId,
      agent,
      cmd: agent === 'shell' ? '/bin/zsh' : agent,
      args: [],
      cwd: '/',
      sessionId: extra.sessionId ?? null,
      startCommand: null,
    },
  };
}

export function browser(id: string, ws: string | null, x: number, url = 'http://localhost:5173/'): WindowNode {
  return { id: id as WindowId, type: 'browser', workspaceId: ws as WorkspaceId | null, rect: { x, y: 0, w: 100, h: 100 }, z: 0, title: null, restoreRect: null, data: { url, mode: 'frame' } };
}

export function snap(terminalId: string, status: StatusSnapshot['status'], since = '', exitCode: number | null = null): StatusSnapshot {
  return { terminalId: terminalId as TerminalId, status, since, exitCode, pending: null };
}

export const at = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 26, h, m)).toISOString();
export const NOW = Date.parse(at(12));

export const PROJECTS = [project('p-shop', '/work/shop', 'shop'), project('p-api', '/work/api', 'api')];
export const WORKSPACES: Record<string, Workspace> = {
  'w-main': workspace('w-main', 'p-shop', '/work/shop', 'main', 'main-folder'),
  'w-login': workspace('w-login', 'p-shop', '/home/.agentdeck/worktrees/shop/feat-login', 'feat/login'),
  'w-api': workspace('w-api', 'p-api', '/work/api', 'main', 'main-folder'),
};
export const SESSIONS: SessionSummary[] = [
  fakeSession({ id: 'c1', agent: 'claude', cwd: '/work/shop', title: 'Fix the login bug', updatedAt: at(9), branch: 'main' }),
  fakeSession({ id: 'c2', agent: 'claude', cwd: '/work/shop/packages/web', title: 'Web tweaks', updatedAt: at(5) }),
  fakeSession({ id: 'x1', agent: 'codex', cwd: '/work/shop', title: 'Review API', updatedAt: at(7) }),
  fakeSession({ id: 'c3', agent: 'claude', cwd: '/home/.agentdeck/worktrees/shop/feat-login', title: 'OAuth', updatedAt: at(8) }),
  fakeSession({ id: 'p1', agent: 'pi', cwd: '/work/api', title: 'Rate limits', updatedAt: at(3) }),
  fakeSession({ id: 'k1', agent: 'kimi', cwd: '/tmp/demo', title: 'Hello', updatedAt: at(10) }),
  fakeSession({ id: 'o1', agent: 'omp', cwd: '/home/.agentdeck/worktrees/shop/feat-old', title: 'Old branch', updatedAt: at(1) }),
];

/** 白板：shop · main 有框，里面开着 c1 的 claude（运行中）和一个 Shell；还有一个散放的网页。 */
export function board(over: Partial<BoardInput> = {}): BoardInput {
  return {
    projects: PROJECTS,
    workspaces: WORKSPACES,
    frames: [frame('w-main', 0, 0)],
    windows: [term('win-1', 'w-main', 0, 'claude', { sessionId: 'c1' }), term('win-sh', 'w-main', 200, 'shell'), browser('win-web', null, 900)],
    statuses: { 't-win-1': snap('t-win-1', 'running', at(11, 56)), 't-win-sh': snap('t-win-sh', 'idle', at(11)) },
    badges: {},
    ...over,
  };
}
