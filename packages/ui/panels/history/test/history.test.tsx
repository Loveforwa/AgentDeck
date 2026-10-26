// N11：左边栏历史会话——分组（项目 → 工作路径 → agent）、排序、筛选，以及界面上的行、跳转、Resume、⋯ 菜单、轮询。
import { act, fireEvent, render, screen, waitFor, within as inside } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Project, ProjectId, SessionSummary, Workspace, WorkspaceId } from '@agentdeck/contracts';
import { fakeSession } from '@agentdeck/fakes';
import { HistoryPanel, buildHistory, relativeTime, sessionKey, shortPath, type HistoryPanelProps } from '../src/index.ts';

const project = (id: string, path: string, name = id): Project => ({
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
const workspace = (id: string, projectId: string, path: string, branch: string | null, mode: Workspace['mode'] = 'worktree'): Workspace => ({
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

const PROJECTS = [project('p-shop', '/work/shop', 'shop'), project('p-api', '/work/api', 'api')];
const WORKSPACES: Record<string, Workspace> = {
  'w-main': workspace('w-main', 'p-shop', '/work/shop', 'main', 'main-folder'),
  'w-login': workspace('w-login', 'p-shop', '/home/.agentdeck/worktrees/shop/feat-login', 'feat/login'),
  'w-api': workspace('w-api', 'p-api', '/work/api', 'main', 'main-folder'),
};
const at = (h: number) => new Date(Date.UTC(2026, 9, 26, h)).toISOString();
const SESSIONS: SessionSummary[] = [
  fakeSession({ id: 'c1', agent: 'claude', cwd: '/work/shop', title: 'Fix the login bug', updatedAt: at(9), branch: 'main' }),
  fakeSession({ id: 'c2', agent: 'claude', cwd: '/work/shop/packages/web', title: 'Web tweaks', updatedAt: at(5) }),
  fakeSession({ id: 'x1', agent: 'codex', cwd: '/work/shop', title: 'Review API', updatedAt: at(7) }),
  fakeSession({ id: 'c3', agent: 'claude', cwd: '/home/.agentdeck/worktrees/shop/feat-login', title: 'OAuth', updatedAt: at(8) }),
  fakeSession({ id: 'p1', agent: 'pi', cwd: '/work/api', title: 'Rate limits', updatedAt: at(3) }),
  fakeSession({ id: 'k1', agent: 'kimi', cwd: '/tmp/demo', title: 'Hello', updatedAt: at(10) }),
  fakeSession({ id: 'o1', agent: 'omp', cwd: '/home/.agentdeck/worktrees/shop/feat-old', title: 'Old branch', updatedAt: at(1) }),
];

const input = (over: Partial<Parameters<typeof buildHistory>[0]> = {}) => ({
  sessions: SESSIONS,
  projects: PROJECTS,
  workspaces: WORKSPACES,
  onBoard: new Set<string>(['w-main']),
  activeProjectId: null,
  filter: { query: '', agent: null },
  ...over,
});

describe('history · grouping', () => {
  it('groups by project → work path → agent, newest first, Other folders last', () => {
    const tree = buildHistory(input());
    expect(tree.map((p) => p.name)).toEqual(['shop', 'api', 'Other folders']);
    const shop = tree[0]!;
    expect(shop.paths.map((p) => [p.label, p.count])).toEqual([
      ['main', 3],
      ['feat/login', 1],
      ['feat-old', 1],
    ]);
    const main = shop.paths[0]!;
    expect(main).toMatchObject({ workspaceId: 'w-main', detail: 'main folder', onBoard: true, cwd: '/work/shop' });
    expect(main.agents.map((a) => [a.agent, a.sessions.map((s) => s.id)])).toEqual([
      ['claude', ['c1', 'c2']],
      ['codex', ['x1']],
    ]);
    // 不在工作区里、在项目的 worktree 目录下：按目录归到项目
    expect(shop.paths[2]).toMatchObject({ workspaceId: null, cwd: '/home/.agentdeck/worktrees/shop/feat-old' });
    expect(tree[2]!.paths[0]).toMatchObject({ label: '/tmp/demo', workspaceId: null });
  });

  it('puts the current project first and filters by text and agent', () => {
    expect(buildHistory(input({ activeProjectId: 'p-api' as ProjectId })).map((p) => p.name)).toEqual(['api', 'shop', 'Other folders']);
    const q = buildHistory(input({ filter: { query: 'oauth', agent: null } }));
    expect(q.flatMap((p) => p.paths.flatMap((x) => x.agents.flatMap((a) => a.sessions.map((s) => s.id))))).toEqual(['c3']);
    const codex = buildHistory(input({ filter: { query: '', agent: 'codex' } }));
    expect(codex.flatMap((p) => p.paths.flatMap((x) => x.agents.map((a) => a.agent)))).toEqual(['codex']);
  });

  it('treats /tmp and /private/tmp as the same folder and shortens long folders', () => {
    const ws = { 'w-tmp': workspace('w-tmp', 'p-tmp', '/private/tmp/demo/repo', 'main', 'main-folder') };
    const tree = buildHistory(
      input({
        sessions: [
          fakeSession({ id: 't1', agent: 'claude', cwd: '/tmp/demo/repo', title: 'Tmp' }),
          fakeSession({ id: 't2', agent: 'claude', cwd: '/Users/me/code/a-long-folder/another-long-folder/deep/folder/name', title: 'Deep' }),
        ],
        projects: [project('p-tmp', '/private/tmp/demo/repo', 'tmp')],
        workspaces: ws,
        home: '/Users/me',
      }),
    );
    expect(tree[0]!.paths[0]).toMatchObject({ workspaceId: 'w-tmp', count: 1 });
    expect(tree[1]!.paths[0]!.label).toBe('…/folder/name');
    expect(shortPath('/Users/me/code/x', '/Users/me')).toBe('~/code/x');
  });

  it('relative times', () => {
    const now = Date.parse(at(12));
    expect(relativeTime(at(12), now)).toBe('now');
    expect(relativeTime(new Date(now - 5 * 60_000).toISOString(), now)).toBe('5m');
    expect(relativeTime(at(9), now)).toBe('3h');
    expect(relativeTime(new Date(now - 3 * 86_400_000).toISOString(), now)).toBe('3d');
    expect(relativeTime('2026-10-12T10:00:00.000Z', now)).toBe('12 Oct');
  });
});

describe('history · panel', () => {
  function mount(over: Partial<HistoryPanelProps> = {}) {
    const props: HistoryPanelProps = {
      projects: PROJECTS,
      workspaces: WORKSPACES,
      onBoard: new Set(['w-main']),
      activeProjectId: null,
      open: { [sessionKey('claude', 'c1')]: { windowId: 'win-1', lamp: 'running' } },
      forkTargets: [
        { id: 'w-main' as WorkspaceId, label: 'shop · main' },
        { id: 'w-api' as WorkspaceId, label: 'api · main' },
      ],
      onJump: vi.fn(),
      onResume: vi.fn(),
      onFork: vi.fn(),
      onCopyId: vi.fn(),
      onReveal: vi.fn(),
      load: vi.fn(async () => SESSIONS),
      now: () => Date.parse(at(12)),
      ...over,
    };
    render(<HistoryPanel {...props} />);
    return props;
  }
  const row = (agent: string, id: string) => document.querySelector<HTMLElement>(`[data-session="${agent}:${id}"]`);

  it('shows the paths on the board expanded, with lamps only for open sessions; clicking an open one jumps', async () => {
    const props = mount();
    await waitFor(() => expect(row('claude', 'c1')).not.toBeNull());
    expect(screen.getByRole('heading', { name: 'HISTORY' })).toBeTruthy();
    // 白板上有框的 main 展开，别的收着
    expect(row('claude', 'c3')).toBeNull();
    expect(row('claude', 'c1')!.querySelector('.hist-lamp--running')).not.toBeNull();
    expect(row('claude', 'c2')!.querySelector('.hist-lamp')).toBeNull();
    expect(row('claude', 'c1')!.querySelector('.hist-time')!.textContent).toBe('3h');
    fireEvent.click(row('claude', 'c1')!.querySelector('.hist-row-main')!);
    expect(props.onJump).toHaveBeenCalledWith('win-1');
  });

  it('Resume opens a closed session in its work path; ⋯ forks, copies the id, reveals the file', async () => {
    const props = mount();
    await waitFor(() => expect(row('claude', 'c2')).not.toBeNull());
    fireEvent.click(inside(row('claude', 'c2')!).getByText('Resume'));
    expect(props.onResume).toHaveBeenCalledWith(expect.objectContaining({ id: 'c2' }), expect.objectContaining({ workspaceId: 'w-main' }));
    fireEvent.click(inside(row('claude', 'c2')!).getByRole('button', { name: 'More' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Copy session id/ }));
    expect(props.onCopyId).toHaveBeenCalledWith(expect.objectContaining({ id: 'c2' }));
  });

  it('expands a collapsed path, searches, filters by agent, and shows more than five', async () => {
    const many = Array.from({ length: 7 }, (_, i) => fakeSession({ id: `m${i}`, agent: 'claude', cwd: '/work/api', title: `Task ${i}`, updatedAt: at(i) }));
    mount({ load: async () => [...SESSIONS, ...many] });
    await waitFor(() => expect(row('claude', 'c1')).not.toBeNull());
    const apiPath = screen.getByRole('group', { name: 'api · main' });
    fireEvent.click(inside(apiPath).getByRole('button', { expanded: false }));
    const claudeRows = () => inside(inside(apiPath).getByRole('group', { name: 'claude' })).getAllByRole('listitem');
    expect(claudeRows()).toHaveLength(5);
    fireEvent.click(inside(apiPath).getByText('Show 2 more'));
    expect(claudeRows()).toHaveLength(7);

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search sessions' }), { target: { value: 'oauth' } });
    await waitFor(() => expect(row('claude', 'c3')).not.toBeNull());
    expect(row('claude', 'c1')).toBeNull();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search sessions' }), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'codex' }));
    await waitFor(() => expect(row('claude', 'c1')).toBeNull());
    expect(row('codex', 'x1')).not.toBeNull();
  });

  it('kimi cannot fork', async () => {
    mount({ onBoard: new Set() });
    await waitFor(() => expect(screen.getByRole('group', { name: 'Other folders · /tmp/demo' })).toBeTruthy());
    fireEvent.click(inside(screen.getByRole('group', { name: 'Other folders · /tmp/demo' })).getByRole('button', { expanded: false }));
    fireEvent.click(inside(row('kimi', 'k1')!).getByRole('button', { name: 'More' }));
    const fork = await screen.findByRole('menuitem', { name: /Fork into/ });
    expect(fork.getAttribute('aria-disabled')).toBe('true');
    expect(fork.textContent).toContain('kimi can’t fork');
  });

  it('polls while open and shows when nothing could be read', async () => {
    vi.useFakeTimers();
    try {
      const load = vi.fn(async () => [] as SessionSummary[]);
      mount({ load, refreshMs: 1000 });
      await act(async () => {});
      expect(screen.getByText('No sessions yet.')).toBeTruthy();
      await act(async () => {
        vi.advanceTimersByTime(2100);
      });
      expect(load).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
