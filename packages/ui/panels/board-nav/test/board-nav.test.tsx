import type { Project, ProjectId, StatusSnapshot, WindowGroupId, WindowId, WindowNode } from '@agentdeck/contracts';
import { SAMPLE, createFakeApi, type FakeApi } from '@agentdeck/fakes';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { BoardNav, type BoardNavInput } from '../src/index.ts';

const T = SAMPLE.terminals;

/** 从假服务里取出一份白板状态，形状和 BoardController.state 里的一样。 */
async function boardFrom(fake: FakeApi): Promise<BoardNavInput> {
  const [projects, workspaces, board, snaps] = await Promise.all([
    fake.projects.list(),
    fake.workspaces.list(),
    fake.board.load(),
    fake.status.snapshot(),
  ]);
  return {
    projects,
    workspaces: Object.fromEntries(workspaces.map((w) => [w.id, w])),
    frames: board.frames,
    windows: board.windows,
    statuses: Object.fromEntries(snaps.map((s: StatusSnapshot) => [s.terminalId, s])),
    badges: {},
  };
}

function row(name: RegExp | string): HTMLElement {
  return screen.getByRole('button', { name });
}

describe('BoardNav', () => {
  it('lists project → workspace (branch) → windows in board order', async () => {
    const fake = createFakeApi();
    const input = await boardFrom(fake);
    render(<BoardNav {...input} api={fake} onJump={() => {}} />);

    expect(screen.getByRole('heading', { name: 'BOARD' })).toBeTruthy();
    const agentdeck = screen.getByRole('region', { name: 'agentdeck' });
    const main = within(agentdeck).getByRole('group', { name: 'agentdeck · main' });
    expect(within(main).getByText('main').className).toContain('bnav-mono');
    const mainRows = within(main).getAllByRole('button').map((b) => b.getAttribute('data-window-id'));
    expect(mainRows).toEqual(['win-dev-server', 'win-browser']);
    expect(within(main).getByText('zsh')).toBeTruthy();
    expect(within(main).getByText('localhost:5173')).toBeTruthy();

    const login = within(agentdeck).getByRole('group', { name: 'agentdeck · feat/login' });
    expect(within(login).getAllByRole('button').map((b) => b.getAttribute('data-window-id'))).toEqual(['win-login-claude', 'win-login-codex']);

    const shop = screen.getByRole('region', { name: 'shop' });
    expect(within(shop).getByRole('group', { name: 'shop · fix/cart-total' })).toBeTruthy();
    expect(screen.queryByText('Not in a workspace')).toBeNull();
  });

  it('shows a lamp per status and an icon for browser windows', async () => {
    const fake = createFakeApi();
    const input = await boardFrom(fake);
    render(<BoardNav {...input} api={fake} onJump={() => {}} />);

    const lamp = (id: string) => document.querySelector(`[data-window-id="${id}"] .bnav-lamp`);
    expect(lamp('win-dev-server')?.className).toContain('bnav-lamp--running');
    expect(lamp('win-login-codex')?.className).toContain('bnav-lamp--waiting');
    expect(lamp('win-login-codex')?.getAttribute('title')).toBe('Needs approval');
    expect(lamp('win-shop-claude')?.className).toContain('bnav-lamp--idle');
    expect(lamp('win-shop-shell')?.className).toContain('bnav-lamp--error');
    // 网页窗口没有灯，是一个窗口图标
    expect(lamp('win-browser')).toBeNull();
    expect(row('localhost:5173').querySelector('[data-icon="window"]')).toBeTruthy();
    // 灯的状态也在按钮的名字里（读屏）
    expect(row('zsh, Running')).toBeTruthy();
    expect(row('codex, Needs approval')).toBeTruthy();
  });

  it('marks exited terminals with a muted bar', async () => {
    const fake = createFakeApi();
    const input = await boardFrom(fake);
    const snap = input.statuses[T.devServer]!;
    input.statuses = { ...input.statuses, [T.devServer]: { ...snap, status: 'exited', exitCode: 0 } };
    render(<BoardNav {...input} api={fake} onJump={() => {}} />);
    expect(document.querySelector('[data-window-id="win-dev-server"] .bnav-lamp')?.className).toContain('bnav-lamp--exited');
  });

  it('shows the conversation topic from TerminalInfo.title and refreshes it', async () => {
    const fake = createFakeApi();
    fake.fakes.terminals.setTitle(T.loginClaude, 'Check local git history');
    const input = await boardFrom(fake);
    render(<BoardNav {...input} api={fake} refreshMs={20} onJump={() => {}} />);

    const claude = await screen.findByText('· Check local git history');
    expect(claude.className).toContain('bnav-topic');
    expect(row('claude, Running, Check local git history').getAttribute('data-window-id')).toBe('win-login-claude');

    fake.fakes.terminals.setTitle(T.loginClaude, 'Fix the login form');
    expect(await screen.findByText('· Fix the login form')).toBeTruthy();
  });

  it('refetches topics when a status changes', async () => {
    const fake = createFakeApi();
    const list = vi.spyOn(fake.terminals, 'list');
    const input = await boardFrom(fake);
    render(<BoardNav {...input} api={fake} refreshMs={60_000} onJump={() => {}} />);
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));

    fake.fakes.terminals.setTitle(T.shopClaude, 'Coupon rounding');
    act(() => {
      fake.fakes.status.askQuestion(T.shopClaude, 'Which coupon?');
    });
    expect(await screen.findByText('· Coupon rounding')).toBeTruthy();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('gives waiting rows the light yellow background and “Waiting”', async () => {
    const fake = createFakeApi();
    const input = await boardFrom(fake);
    render(<BoardNav {...input} api={fake} onJump={() => {}} />);

    const codex = document.querySelector('[data-window-id="win-login-codex"]')!;
    expect(codex.className).toContain('bnav-row--waiting');
    expect(within(codex as HTMLElement).getByText('· Waiting').getAttribute('title')).toBe('Needs approval');
    for (const id of ['win-dev-server', 'win-browser', 'win-login-claude', 'win-shop-claude', 'win-shop-shell']) {
      expect(document.querySelector(`[data-window-id="${id}"]`)!.className).not.toContain('bnav-row--waiting');
    }
  });

  it('treats a non-terminal window with an attention badge as waiting', async () => {
    const fake = createFakeApi();
    const input = await boardFrom(fake);
    input.badges = { ['win-browser' as WindowId]: { text: 'Sign in', tone: 'attention', dot: 'filled', detail: 'Needs sign-in' } };
    render(<BoardNav {...input} api={fake} onJump={() => {}} />);
    const browser = document.querySelector('[data-window-id="win-browser"]')!;
    expect(browser.className).toContain('bnav-row--waiting');
    expect(browser.querySelector('.bnav-lamp--waiting')).toBeTruthy();
  });

  it('calls onJump with the window id when a row is clicked', async () => {
    const fake = createFakeApi();
    const input = await boardFrom(fake);
    const onJump = vi.fn();
    render(<BoardNav {...input} api={fake} onJump={onJump} />);
    await userEvent.click(row(/codex/));
    expect(onJump).toHaveBeenCalledWith('win-login-codex');
    await userEvent.click(row(/localhost:5173/));
    expect(onJump).toHaveBeenLastCalledWith('win-browser');
  });

  it('shows “no workspaces” for a project without frames and lists loose windows last', async () => {
    const fake = createFakeApi();
    const input = await boardFrom(fake);
    const empty: Project = { ...input.projects[0]!, id: 'prj-api' as ProjectId, name: 'api-server' };
    const loose: WindowNode = { ...input.windows[0]!, id: 'win-loose' as WindowId, workspaceId: null, title: 'scratch' };
    render(<BoardNav {...input} projects={[...input.projects, empty]} windows={[...input.windows, loose]} api={fake} onJump={() => {}} />);

    const api = screen.getByRole('region', { name: 'api-server' });
    expect(within(api).getByText('no workspaces')).toBeTruthy();
    const looseGroup = screen.getByRole('region', { name: 'Not in a workspace' });
    expect(within(looseGroup).getByText('scratch')).toBeTruthy();
    const regions = screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'));
    expect(regions).toEqual(['agentdeck', 'shop', 'api-server', 'Not in a workspace']);
  });

  it('IS-70: window-group terminals carry the sidebar’s names (“sub-1 · api”) and the lead is marked “lead”', async () => {
    const fake = createFakeApi();
    const input = await boardFrom(fake);
    const G = 'grp-x' as WindowGroupId;
    const base = input.windows.find((w) => w.type === 'terminal')!;
    const lead: WindowNode = { ...base, group: { id: G, role: 'lead', label: null } };
    const sub = (id: string, label: string | null, agent: string, x: number): WindowNode => ({
      ...base,
      id: id as WindowId,
      rect: { ...base.rect, x: base.rect.x + x },
      group: { id: G, role: 'member', label },
      data: { ...(base.data as object), terminalId: null, agent, cmd: agent === 'shell' ? '/bin/zsh' : agent },
    });
    const windows = input.windows.map((w) => (w.id === base.id ? lead : w));
    windows.push(sub('win-sub-api', 'api', 'shell', 5000), sub('win-sub-ui', 'ui', 'claude', 6000));
    render(<BoardNav {...input} windows={windows} api={fake} onJump={() => {}} />);

    const api = document.querySelector<HTMLElement>('[data-window-id="win-sub-api"]')!;
    expect(api.querySelector('.bnav-name')?.textContent).toBe('zsh');
    expect(api.querySelector('.bnav-group')?.textContent).toBe('sub-1 · api');
    expect(api.getAttribute('aria-label')).toMatch(/^zsh sub-1 · api, /);
    const ui = document.querySelector<HTMLElement>('[data-window-id="win-sub-ui"]')!;
    expect(ui.querySelector('.bnav-group')?.textContent).toBe('sub-2 · ui');
    const leadRow = document.querySelector<HTMLElement>(`[data-window-id="${base.id}"]`)!;
    expect(leadRow.querySelector('.bnav-group')?.textContent).toBe('lead');
    // 不在组里的窗口没有
    const other = input.windows.find((w) => w.id !== base.id)!;
    expect(document.querySelector(`[data-window-id="${other.id}"] .bnav-group`)).toBeNull();
  });

  it('says so when the board is empty', () => {
    const fake = createFakeApi({ seed: false });
    render(<BoardNav projects={[]} workspaces={{}} frames={[]} windows={[]} statuses={{}} badges={{}} api={fake} onJump={() => {}} />);
    expect(screen.getByText('Nothing on the board yet.')).toBeTruthy();
  });

  it('shows the header actions the board gives it (the V4 collapse button)', async () => {
    const fake = createFakeApi();
    const input = await boardFrom(fake);
    render(<BoardNav {...input} api={fake} onJump={() => {}} headerActions={<button type="button" aria-label="Collapse panel">x</button>} />);
    expect(screen.getByRole('button', { name: 'Collapse panel' })).toBeTruthy();
  });
});
