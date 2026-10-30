// MP2：左边管理面板的界面——标题、New 菜单、Search、NEEDS YOU、PINNED（拖动换顺序）、项目 → 工作路径 → 行、
// 单击跳过去 / Resume、⋯ 和右键菜单、Other folders 收着并记住、Show n more、悬停提示、轮询。
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSessionId, BoardPin, SessionSummary, WindowId, WorkspaceId } from '@agentdeck/contracts';
import { fakeSession } from '@agentdeck/fakes';
import { ManagerPanel, OTHER_OPEN_KEY, type ManagerApi, type ManagerPanelProps } from '../src/index.ts';
import { TIP_DELAY_MS } from '../src/ReplyTip.tsx';
import { NOW, SESSIONS, at, board, snap, term } from './fixtures.ts';

function fakeApi(lines: string[] = []): ManagerApi {
  return {
    terminals: { list: vi.fn(async () => []), lastLines: vi.fn(async () => lines) } as unknown as ManagerApi['terminals'],
    on: (() => () => undefined) as unknown as ManagerApi['on'],
  };
}

function mount(over: Partial<ManagerPanelProps> = {}) {
  const props: ManagerPanelProps = {
    ...board(),
    title: 'My Board',
    pins: [],
    activeProjectId: null,
    newMenu: vi.fn(() => [
      { id: 'new-terminal', label: 'Terminal', items: [{ id: 'agent-claude', label: 'Claude Code', onSelect: vi.fn() }] },
      { id: 'new-browser', label: 'Browser', onSelect: vi.fn() },
    ]),
    forkTargets: [{ id: 'w-main' as WorkspaceId, label: 'shop · main' }],
    onTogglePin: vi.fn(),
    onMovePin: vi.fn(),
    onJump: vi.fn(),
    onResume: vi.fn(),
    onFork: vi.fn(),
    onCopyId: vi.fn(),
    onReveal: vi.fn(),
    onRename: vi.fn(),
    onClose: vi.fn(),
    onOpenWorkspace: vi.fn(),
    load: vi.fn(async () => SESSIONS),
    api: fakeApi(),
    now: () => NOW,
    ...over,
  };
  const r = render(<ManagerPanel {...props} />);
  return { props, rerender: (more: Partial<ManagerPanelProps>) => r.rerender(<ManagerPanel {...props} {...more} />) };
}

const row = (key: string) => document.querySelector<HTMLElement>(`.mgr-row[data-key="${key}"]`);
const main = (key: string) => row(key)!.querySelector<HTMLElement>('.mgr-row-main')!;

beforeEach(() => window.localStorage.clear());

describe('manager panel', () => {
  it('shows the board name, New and Search; open rows have a lamp and status, closed rows a time; agent squares, no agent headings', async () => {
    mount();
    await waitFor(() => expect(row('session:claude:c2')).not.toBeNull());
    expect(screen.getByRole('heading', { name: 'My Board' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Search' })).toBeTruthy();
    expect(row('session:claude:c1')!.querySelector('.mgr-lamp--running')).not.toBeNull();
    expect(row('session:claude:c1')!.querySelector('.mgr-time')!.textContent).toBe('Running · 4m');
    expect(row('session:claude:c2')!.querySelector('.mgr-lamp')).toBeNull();
    expect(row('session:claude:c2')!.querySelector('.mgr-time')!.textContent).toBe('7h');
    expect(row('session:claude:c2')!.querySelector('.mgr-agent[data-agent="claude"]')).not.toBeNull();
    expect(row('window:win-sh')!.querySelector('.mgr-agent[data-agent="shell"]')).not.toBeNull();
    expect(row('window:win-web')!.querySelector('[data-icon="window"]')).not.toBeNull();
    // 白板上有框的 main 展开，feat/login 收着
    expect(row('session:claude:c3')).toBeNull();
    expect(document.querySelector('.hist-agent-name, .mgr-agent-name')).toBeNull();
  });

  it('clicking an open row jumps to its window, a closed row resumes it in its work path', async () => {
    const { props } = mount();
    await waitFor(() => expect(row('session:claude:c2')).not.toBeNull());
    fireEvent.click(main('session:claude:c1'));
    expect(props.onJump).toHaveBeenCalledWith('win-1');
    fireEvent.click(main('session:claude:c2'));
    expect(props.onResume).toHaveBeenCalledWith(expect.objectContaining({ id: 'c2' }), { workspaceId: 'w-main', cwd: '/work/shop/packages/web' });
  });

  it('⋯ on an open row: Open, Pin, Rename…, Copy session id, Close terminal', async () => {
    const { props } = mount();
    await waitFor(() => expect(row('session:claude:c1')).not.toBeNull());
    fireEvent.click(within(row('session:claude:c1')!).getByRole('button', { name: /More for/ }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent?.replace(/↩$/, ''))).toEqual(['Open', 'Pin', 'Rename…', 'Copy session id', 'Close terminal']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Pin' }));
    expect(props.onTogglePin).toHaveBeenCalledWith({ kind: 'session', agent: 'claude', sessionId: 'c1' });
    fireEvent.contextMenu(main('window:win-sh'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Close terminal' }));
    expect(props.onClose).toHaveBeenCalledWith('win-sh');
    fireEvent.contextMenu(main('window:win-sh'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename…' }));
    expect(props.onRename).toHaveBeenCalledWith('win-sh');
  });

  it('right-click on a closed row: Resume, Pin, Fork into…, Copy session id, Reveal in Finder; kimi can’t fork', async () => {
    window.localStorage.setItem(OTHER_OPEN_KEY, '1');
    const { props } = mount();
    await waitFor(() => expect(row('session:claude:c2')).not.toBeNull());
    fireEvent.contextMenu(main('session:claude:c2'));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Resume↩', 'Pin', 'Fork into…', 'Copy session id', 'Reveal in Finder']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Copy session id' }));
    expect(props.onCopyId).toHaveBeenCalledWith('c2');
    await waitFor(() => expect(row('session:kimi:k1')).toBeNull());
    fireEvent.click(within(screen.getByRole('group', { name: 'Other folders · /tmp/demo' })).getByRole('button', { expanded: false }));
    fireEvent.contextMenu(main('session:kimi:k1'));
    const fork = await screen.findByRole('menuitem', { name: /Fork into/ });
    expect(fork.getAttribute('aria-disabled')).toBe('true');
    expect(fork.textContent).toContain('kimi can’t fork');
  });

  it('New opens the same menu as right-clicking the board, under a NEW heading', async () => {
    const { props } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('NEW')).toBeTruthy();
    expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Terminal', 'Browser']);
    expect(props.newMenu).toHaveBeenCalled();
  });

  it('Search turns into a box, keeps only hits with their groups open, and Esc leaves it', async () => {
    mount();
    await waitFor(() => expect(row('session:claude:c1')).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    const box = screen.getByRole('searchbox', { name: 'Search' });
    expect(document.activeElement).toBe(box);
    fireEvent.change(box, { target: { value: 'oauth' } });
    await waitFor(() => expect(row('session:claude:c3')).not.toBeNull());
    expect(row('session:claude:c1')).toBeNull();
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByRole('searchbox')).toBeNull();
    await waitFor(() => expect(row('session:claude:c1')).not.toBeNull());
  });

  it('NEEDS YOU: waiting and failed rows on top with a count, yellow background, the status in colour', async () => {
    mount(
      board({
        windows: [term('win-1', 'w-main', 0, 'claude', { sessionId: 'c1' }), term('win-2', 'w-main', 200, 'codex')],
        statuses: { 't-win-1': snap('t-win-1', 'needs-approval', at(11, 58)), 't-win-2': snap('t-win-2', 'error', at(11, 50), 1) },
      }),
    );
    const needs = await screen.findByRole('region', { name: 'Needs you' });
    expect(within(needs).getByRole('heading').textContent).toBe('NEEDS YOU · 2');
    const rows = needs.querySelectorAll('.mgr-row');
    expect([...rows].map((r) => r.getAttribute('data-window-id'))).toEqual(['win-2', 'win-1']);
    expect(rows[1]!.classList.contains('mgr-row--waiting')).toBe(true);
    expect(rows[1]!.querySelector('.mgr-time')!.textContent).toBe('Waiting · 2m');
    expect(rows[1]!.querySelector('.mgr-where')!.textContent).toBe('shop · main');
    expect(rows[0]!.querySelector('.mgr-time--error')!.textContent).toBe('exit 1 · 10m');
    expect(main('session:claude:c1').getAttribute('aria-label')).toBe('Fix the login bug, Needs approval, shop · main');
  });

  it('PINNED shows pinned rows, projects and workspaces in order; drag reorders; a pinned workspace opens its frame', async () => {
    const pins: BoardPin[] = [
      { kind: 'session', agent: 'claude', sessionId: 'c3' as AgentSessionId },
      { kind: 'workspace', workspaceId: 'w-login' as WorkspaceId },
      { kind: 'window', windowId: 'win-sh' as WindowId },
    ];
    const { props } = mount({ pins });
    const pinned = await screen.findByRole('region', { name: 'Pinned' });
    await waitFor(() => expect(within(pinned).queryByText('OAuth')).not.toBeNull());
    expect([...pinned.querySelectorAll('.mgr-row')].map((r) => r.getAttribute('data-key'))).toEqual(['session:claude:c3', 'workspace:w-login', 'window:win-sh']);
    fireEvent.click(within(pinned).getByRole('button', { name: 'shop · feat/login' }));
    expect(props.onOpenWorkspace).toHaveBeenCalledWith('w-login');
    // 拖第 3 项到第 1 项
    const data = new Map<string, string>();
    const dataTransfer = { setData: (t: string, v: string) => data.set(t, v), getData: (t: string) => data.get(t) ?? '', get types() { return [...data.keys()]; }, effectAllowed: '' };
    fireEvent.dragStart(row('window:win-sh')!, { dataTransfer });
    fireEvent.dragOver(row('session:claude:c3')!, { dataTransfer });
    fireEvent.drop(row('session:claude:c3')!, { dataTransfer });
    expect(props.onMovePin).toHaveBeenCalledWith(2, 0);
    // 置顶的行不在下面的项目里再出现一次
    expect(document.querySelectorAll('.mgr-row[data-key="window:win-sh"]')).toHaveLength(1);
    // 右键置顶的项：Unpin
    fireEvent.contextMenu(within(pinned).getByRole('button', { name: 'shop · feat/login' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Unpin' }));
    expect(props.onTogglePin).toHaveBeenCalledWith(pins[1]);
  });

  it('projects and workspace paths can be pinned from their headers and collapsed', async () => {
    const { props } = mount();
    const shop = await screen.findByRole('button', { name: /^shop/ });
    fireEvent.contextMenu(shop);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Pin' }));
    expect(props.onTogglePin).toHaveBeenCalledWith({ kind: 'project', projectId: 'p-shop' });
    const path = within(screen.getByRole('group', { name: 'shop · feat/login' })).getByRole('button', { expanded: false });
    fireEvent.contextMenu(path);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Pin' }));
    expect(props.onTogglePin).toHaveBeenCalledWith({ kind: 'workspace', workspaceId: 'w-login' });
    fireEvent.click(shop);
    expect(screen.queryByRole('group', { name: 'shop · main' })).toBeNull();
    expect(shop.getAttribute('aria-expanded')).toBe('false');
  });

  it('shows five rows per path (all open ones), then Show n more', async () => {
    const many = Array.from({ length: 7 }, (_, i) => fakeSession({ id: `m${i}`, agent: 'claude', cwd: '/work/api', title: `Task ${i}`, updatedAt: at(i) }));
    mount({ load: async () => [...SESSIONS, ...many] });
    const api = await screen.findByRole('group', { name: 'api · main' });
    fireEvent.click(within(api).getByRole('button', { expanded: false }));
    expect(within(api).getAllByRole('listitem')).toHaveLength(5);
    fireEvent.click(within(api).getByText('Show 3 more'));
    expect(within(api).getAllByRole('listitem')).toHaveLength(8);
  });

  it('Other folders starts collapsed with its total, opens on click, and remembers it', async () => {
    mount();
    const other = await screen.findByRole('button', { name: /Other folders/ });
    expect(other.getAttribute('aria-expanded')).toBe('false');
    await waitFor(() => expect(other.textContent).toContain('1'));
    fireEvent.click(other);
    expect(screen.getByRole('group', { name: 'Other folders · /tmp/demo' })).toBeTruthy();
    expect(window.localStorage.getItem(OTHER_OPEN_KEY)).toBe('1');
    fireEvent.click(other);
    expect(screen.queryByRole('group', { name: 'Other folders · /tmp/demo' })).toBeNull();
    expect(window.localStorage.getItem(OTHER_OPEN_KEY)).toBe('0');
  });

  it('hovering an open agent row shows the last reply and, under NEEDS YOU, the ⌥⌘ shortcut', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mount({
        ...board({ windows: [term('win-1', 'w-main', 0, 'claude', { sessionId: 'c1' })], statuses: { 't-win-1': snap('t-win-1', 'needs-reply', at(11, 58)) } }),
        api: fakeApi(['⏺ Should I also update the docs?', '', '╭──────╮', '│ >    │', '╰──────╯']),
      });
      await waitFor(() => expect(row('session:claude:c1')).not.toBeNull());
      fireEvent.mouseEnter(main('session:claude:c1'));
      await act(async () => {
        vi.advanceTimersByTime(TIP_DELAY_MS + 10);
      });
      const tip = await screen.findByRole('tooltip');
      await waitFor(() => expect(tip.textContent).toContain('Should I also update the docs?'));
      expect(tip.textContent).toContain('claude · shop · main · Waiting · 2m');
      expect(tip.textContent).toContain('Click to jump · ⌥⌘1');
      expect(main('session:claude:c1').getAttribute('aria-describedby')).toBe(tip.id);
      fireEvent.mouseLeave(main('session:claude:c1'));
      expect(screen.queryByRole('tooltip')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('polls the history while open', async () => {
    vi.useFakeTimers();
    try {
      const load = vi.fn(async () => [] as SessionSummary[]);
      mount({ load, refreshMs: 1000, windows: [], frames: [] });
      await act(async () => {});
      await act(async () => {
        vi.advanceTimersByTime(2100);
      });
      expect(load).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
