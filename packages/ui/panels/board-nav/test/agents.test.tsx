// CO4（TC-148 的界面部分）：Agents 视图、Unseen、悬停看最后一条回复。
import type { StatusSnapshot, TerminalId, TerminalWindowData, WindowId, WindowNode } from '@agentdeck/contracts';
import { SAMPLE, createFakeApi, type FakeApi } from '@agentdeck/fakes';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  agentOrder,
  agentReplyReader,
  agentShortcut,
  BoardNav,
  buildAgents,
  replyFromScreen,
  VIEW_STORAGE_KEY,
  type BoardNavInput,
  type LastReplyReader,
} from '../src/index.ts';
import { rowStatusText, titleStatusText } from '../src/agents.ts';
import { TIP_DELAY_MS } from '../src/AgentsView.tsx';

const T = SAMPLE.terminals;
const NOW = Date.parse('2026-10-28T10:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

async function boardFrom(fake: FakeApi): Promise<BoardNavInput> {
  const [projects, workspaces, board, snaps] = await Promise.all([fake.projects.list(), fake.workspaces.list(), fake.board.load(), fake.status.snapshot()]);
  return {
    projects,
    workspaces: Object.fromEntries(workspaces.map((w) => [w.id, w])),
    frames: board.frames,
    windows: board.windows,
    statuses: Object.fromEntries(snaps.map((s: StatusSnapshot) => [s.terminalId, s])),
    badges: {},
  };
}

function setStatus(input: BoardNavInput, id: TerminalId, patch: Partial<StatusSnapshot>): BoardNavInput {
  const cur = input.statuses[id]!;
  return { ...input, statuses: { ...input.statuses, [id]: { ...cur, ...patch } } };
}

function setData(input: BoardNavInput, windowId: string, patch: Partial<TerminalWindowData>): BoardNavInput {
  return {
    ...input,
    windows: input.windows.map((w) => (w.id === windowId ? ({ ...w, data: { ...(w.data as TerminalWindowData), ...patch } } as WindowNode) : w)),
  };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Agents view model', () => {
  it('lists agent terminals only, grouped in a fixed order, board order inside a group', async () => {
    const fake = createFakeApi();
    let input = await boardFrom(fake);
    input = setData(input, 'win-shop-claude', { unseen: true });
    const view = buildAgents(input);
    // 两个 shell 和网页不列
    expect(view.rows.map((r) => r.id)).toEqual(['win-login-codex', 'win-login-claude', 'win-shop-claude']);
    expect(view.groups.map((g) => [g.label, g.rows.length])).toEqual([
      ['NEEDS YOU', 1],
      ['RUNNING', 1],
      ['DONE · UNSEEN', 1],
    ]);
    expect(view.rows[0]!.where).toBe('agentdeck · feat/login');
    expect(view.rows[2]!.where).toBe('shop · fix/cart-total');
    expect(agentOrder(input)).toEqual(['win-login-codex', 'win-login-claude', 'win-shop-claude']);
  });

  it('puts errors first and idle last; Unseen only while idle', async () => {
    const fake = createFakeApi();
    let input = await boardFrom(fake);
    input = setStatus(input, T.loginClaude, { status: 'error', exitCode: 1 });
    expect(buildAgents(input).groups.map((g) => g.id)).toEqual(['error', 'needs-you', 'idle']);
    // unseen 记着，但终端又在跑：算 RUNNING，不算没看
    input = setData(setStatus(input, T.shopClaude, { status: 'running' }), 'win-shop-claude', { unseen: true });
    const view = buildAgents(input);
    expect(view.groups.map((g) => g.id)).toEqual(['error', 'needs-you', 'running']);
    expect(view.rows.find((r) => r.id === 'win-shop-claude')!.unseen).toBe(false);
  });

  it('keeps two agents of the same kind apart in board order and lists exited agents under IDLE', async () => {
    const fake = createFakeApi();
    let input = await boardFrom(fake);
    input = setStatus(input, T.loginCodex, { status: 'exited', exitCode: 0 });
    input = setStatus(input, T.loginClaude, { status: 'idle' });
    const view = buildAgents(input);
    expect(view.groups.map((g) => [g.id, g.rows.map((r) => r.id)])).toEqual([['idle', ['win-login-claude', 'win-login-codex', 'win-shop-claude']]]);
  });

  it('writes the time on the right and the title-bar status in the tooltip', () => {
    const base = { since: ago(4 * 60_000), exitCode: null };
    expect(rowStatusText({ ...base, agentGroup: 'needs-you', status: 'needs-approval' }, NOW)).toBe('Waiting · 4m');
    expect(rowStatusText({ ...base, agentGroup: 'running', status: 'running' }, NOW)).toBe('4m');
    expect(rowStatusText({ ...base, agentGroup: 'unseen', status: 'idle', since: ago(5_000) }, NOW)).toBe('Unseen · now');
    expect(rowStatusText({ ...base, agentGroup: 'idle', status: 'idle', since: ago(3 * 3600_000) }, NOW)).toBe('3h');
    expect(rowStatusText({ ...base, agentGroup: 'error', status: 'error', exitCode: 1 }, NOW)).toBe('exit 1 · 4m');
    expect(rowStatusText({ ...base, agentGroup: 'idle', status: 'exited' }, NOW)).toBe('Exited');
    expect(titleStatusText({ ...base, agentGroup: 'unseen', status: 'idle', since: ago(5_000) }, NOW)).toBe('Idle · Unseen · now');
    expect(titleStatusText({ ...base, agentGroup: 'running', status: 'running' }, NOW)).toBe('Running · 4m');
    expect(agentShortcut(0)).toBe('⌥⌘1');
    expect(agentShortcut(8)).toBe('⌥⌘9');
    expect(agentShortcut(9)).toBeNull();
  });
});

describe('last reply from the screen', () => {
  it('finds the last claude reply above the input box', () => {
    const lines = [
      '> Run the load test',
      '',
      '⏺ Bash(pnpm bench)',
      '  ⎿  p50 41ms',
      '',
      '⏺ The p99 spike comes from the cold pool in db/pool.ts:88.',
      '  I can raise idleTimeout or add a keep-alive.',
      '',
      '╭────────────────────────────────────────╮',
      '│ >                                      │',
      '╰────────────────────────────────────────╯',
      '  ? for shortcuts',
    ];
    expect(replyFromScreen(lines)).toEqual({
      text: 'The p99 spike comes from the cold pool in db/pool.ts:88.\nI can raise idleTimeout or add a keep-alive.',
      source: 'screen',
      kind: 'reply',
    });
  });

  it('finds a codex reply above a plain prompt line and falls back to the last lines', () => {
    expect(replyFromScreen(['› fix it', '', '• Fixed the off-by-one in cart.ts.', '', '› ', '  ⏎ send   ⇧⏎ newline'])).toMatchObject({
      text: 'Fixed the off-by-one in cart.ts.',
      kind: 'reply',
    });
    expect(replyFromScreen(['one', 'two', 'three', 'four', 'five', ''])).toEqual({ text: 'two\nthree\nfour\nfive', source: 'screen', kind: 'lines' });
    expect(replyFromScreen(['', '  '])).toBeNull();
  });

  it('clips long replies', () => {
    const many = ['● start', ...Array.from({ length: 20 }, (_, i) => `line ${i}`)];
    const r = replyFromScreen(many)!;
    expect(r.text.split('\n')).toHaveLength(8);
    expect(r.text.endsWith('…')).toBe(true);
  });
});

describe('BoardNav · Agents', () => {
  it('switches between Board and Agents and remembers the choice', async () => {
    const fake = createFakeApi();
    const input = await boardFrom(fake);
    const user = userEvent.setup();
    const { unmount } = render(<BoardNav {...input} api={fake} onJump={() => {}} now={NOW} />);
    expect(screen.getByRole('heading', { name: 'BOARD' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Board' }).getAttribute('aria-pressed')).toBe('true');

    await user.click(screen.getByRole('button', { name: 'Agents' }));
    expect(screen.getByRole('heading', { name: 'AGENTS · 3' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Agents' }).getAttribute('aria-pressed')).toBe('true');
    expect(localStorage.getItem(VIEW_STORAGE_KEY)).toBe('agents');
    // 只有 agent 终端
    expect(screen.queryByText('zsh')).toBeNull();
    expect(screen.queryByText('localhost:5173')).toBeNull();
    unmount();

    // 下次打开还是 Agents
    render(<BoardNav {...input} api={fake} onJump={() => {}} now={NOW} />);
    expect(screen.getByRole('heading', { name: 'AGENTS · 3' })).toBeTruthy();
  });

  it('shows the groups with counts, lamps, Unseen in bold, and jumps on click', async () => {
    const fake = createFakeApi();
    let input = await boardFrom(fake);
    input = setData(setStatus(input, T.shopClaude, { since: ago(10_000) }), 'win-shop-claude', { unseen: true });
    input = setStatus(input, T.loginCodex, { since: ago(2 * 60_000) });
    localStorage.setItem(VIEW_STORAGE_KEY, 'agents');
    const onJump = vi.fn();
    render(<BoardNav {...input} api={fake} onJump={onJump} now={NOW} />);

    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(['NEEDS YOU · 1', 'RUNNING · 1', 'DONE · UNSEEN · 1']);

    const waiting = screen.getByRole('region', { name: 'NEEDS YOU' });
    const codex = within(waiting).getByRole('button');
    expect(codex.className).toContain('bnav-row--waiting');
    expect(codex.querySelector('.bnav-lamp')!.className).toContain('bnav-lamp--waiting');
    expect(within(codex).getByText('Waiting · 2m')).toBeTruthy();
    expect(within(codex).getByText('agentdeck · feat/login')).toBeTruthy();

    const unseen = within(screen.getByRole('region', { name: 'DONE · UNSEEN' })).getByRole('button');
    expect(unseen.className).toContain('bnav-row--unseen');
    expect(unseen.getAttribute('aria-label')).toBe('claude, Idle · Unseen, shop · fix/cart-total');
    // 灯还是空心灰（颜色只在灯上，Unseen 不加颜色）
    expect(unseen.querySelector('.bnav-lamp')!.className).toContain('bnav-lamp--idle');
    const status = within(unseen).getByText('Unseen · now');
    expect(status.className).toContain('bnav-agent-status--unseen');
    expect(unseen.getAttribute('data-agent-index')).toBe('3');

    await userEvent.setup().click(unseen);
    expect(onJump).toHaveBeenCalledWith('win-shop-claude' as WindowId);
  });

  it('says so when there are no agents', async () => {
    const fake = createFakeApi();
    const input = await boardFrom(fake);
    localStorage.setItem(VIEW_STORAGE_KEY, 'agents');
    render(<BoardNav {...input} windows={input.windows.filter((w) => (w.data as TerminalWindowData)?.agent === 'shell')} api={fake} onJump={() => {}} />);
    expect(screen.getByRole('heading', { name: 'AGENTS · 0' })).toBeTruthy();
    expect(screen.getByText('No agents on the board.')).toBeTruthy();
  });

  it('shows the last reply from the screen and the shortcut on hover', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fake = createFakeApi();
    let input = await boardFrom(fake);
    input = setData(setStatus(input, T.shopClaude, { since: ago(10_000) }), 'win-shop-claude', { unseen: true });
    localStorage.setItem(VIEW_STORAGE_KEY, 'agents');
    const lastLines = vi.spyOn(fake.terminals, 'lastLines');
    render(<BoardNav {...input} api={fake} onJump={() => {}} now={NOW} />);

    const row = within(screen.getByRole('region', { name: 'DONE · UNSEEN' })).getByRole('button');
    fireEvent.mouseEnter(row);
    expect(screen.queryByRole('tooltip')).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(TIP_DELAY_MS);
    });
    await act(async () => {
      await Promise.resolve();
    });
    const tip = await vi.waitFor(() => {
      const t = screen.getByRole('tooltip');
      expect(t.textContent).toContain('rounding');
      return t;
    });
    expect(lastLines).toHaveBeenCalledWith(T.shopClaude, 60);
    expect(row.getAttribute('aria-describedby')).toBe(tip.id);
    expect(within(tip).getByText('claude · shop · fix/cart-total · Idle · Unseen · now')).toBeTruthy();
    expect(within(tip).getByText('Last reply')).toBeTruthy();
    expect(within(tip).getByText('The total was rounding before the discount. Fixed in web/src/cart.ts:14 and added a test.')).toBeTruthy();
    expect(within(tip).getByText('Click to jump · ⌥⌘3')).toBeTruthy();

    fireEvent.mouseLeave(row);
    expect(screen.queryByRole('tooltip')).toBeNull();
    // 状态没变：再悬停不再读一次
    fireEvent.mouseEnter(row);
    await act(async () => {
      vi.advanceTimersByTime(TIP_DELAY_MS);
    });
    expect(screen.getByRole('tooltip')).toBeTruthy();
    expect(lastLines).toHaveBeenCalledTimes(1);
  });

  it('uses the reader the assembler passes, and says On screen when no reply was recognised', async () => {
    const fake = createFakeApi();
    const input = await boardFrom(fake);
    localStorage.setItem(VIEW_STORAGE_KEY, 'agents');
    const reader: LastReplyReader = vi.fn(async () => ({ text: 'npm ERR! missing script', source: 'screen' as const, kind: 'lines' as const }));
    render(<BoardNav {...input} api={fake} onJump={() => {}} now={NOW} lastReply={reader} />);
    const row = within(screen.getByRole('region', { name: 'RUNNING' })).getByRole('button');
    // 键盘聚焦也出提示（不等）
    row.focus();
    fireEvent.mouseEnter(row);
    const tip = await screen.findByRole('tooltip', {}, { timeout: 2000 });
    await vi.waitFor(() => expect(within(tip).getByText('npm ERR! missing script')).toBeTruthy());
    expect(within(tip).getByText('On screen')).toBeTruthy();
    expect(reader).toHaveBeenCalledWith(T.loginClaude);
    expect(within(tip).getByText('Click to jump · ⌥⌘2')).toBeTruthy();
  });
});

describe('agentReplyReader (contracts 0.1.22)', () => {
  const screenLines = ['⏺ From the screen.', '', '╭──────────╮', '│ >        │', '╰──────────╯'];
  const api = (lastReply?: (id: TerminalId) => Promise<{ text: string | null; source: 'transcript' | 'screen'; at: string | null }>) => ({
    terminals: { lastLines: vi.fn(async () => screenLines) } as never,
    agents: (lastReply ? { lastReply } : {}) as never,
  });

  it('uses the transcript when agents.lastReply reads one (blank lines merged)', async () => {
    const a = api(async () => ({ text: 'Fixed it.\n\n\n\nAll tests pass.', source: 'transcript', at: null }));
    expect(await agentReplyReader(a)('t1' as TerminalId)).toEqual({ text: 'Fixed it.\n\nAll tests pass.', source: 'transcript', kind: 'reply' });
  });

  it('falls back to reading the screen: no lastReply (fakes, old builds), a screen-only answer, or an error', async () => {
    const fromScreen = { text: 'From the screen.', source: 'screen', kind: 'reply' };
    expect(await agentReplyReader(api())('t1' as TerminalId)).toEqual(fromScreen);
    expect(await agentReplyReader(api(async () => ({ text: 'x', source: 'screen', at: null })))('t1' as TerminalId)).toEqual(fromScreen);
    expect(await agentReplyReader(api(async () => Promise.reject(new Error('boom'))))('t1' as TerminalId)).toEqual(fromScreen);
    expect(await agentReplyReader(api(async () => ({ text: '  ', source: 'transcript', at: null })))('t1' as TerminalId)).toEqual(fromScreen);
  });
});
