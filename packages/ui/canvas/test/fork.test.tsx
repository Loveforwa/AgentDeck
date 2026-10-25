// X4 · Fork 对话：能不能 Fork 和原因（forkCheck）、controller 开出来的 fork 请求、W5 对话框的 Fork 按钮、
// 终端标题栏菜单的 Fork conversation into…（灰掉时写原因）。

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInfo, AgentSessionId, TerminalWindowData, WindowComponentProps, WindowId } from '@agentdeck/contracts';
import { createFakeApi, SAMPLE, type FakeApi } from '@agentdeck/fakes';
import type { MenuEntry, MenuItem } from '@agentdeck/ui-kit';
import { BoardController } from '../src/controller.ts';
import { forkCheck } from '../src/model/fork.ts';
import { menuItems } from '../src/react/BoardMenu.tsx';
import { BoardProvider } from '../src/react/context.tsx';
import { BoardDialogs } from '../src/react/dialogs.tsx';
import { createWindowRegistry } from '../src/registry.ts';

const W = SAMPLE.workspaces;
const T = SAMPLE.terminals;
const id = (s: string) => s as WindowId;
const Nothing = (_p: WindowComponentProps<any>) => null; // eslint-disable-line @typescript-eslint/no-explicit-any

let api: FakeApi;
let c: BoardController;
let notify: ReturnType<typeof vi.fn<(message: string) => void>>;

beforeEach(async () => {
  const registry = createWindowRegistry();
  registry.register<TerminalWindowData>({
    type: 'terminal',
    label: 'Terminal',
    defaultSize: { w: 560, h: 360 },
    minSize: { w: 110, h: 60 },
    component: Nothing,
    create: (init) => ({ terminalId: null, agent: 'shell', cmd: 'zsh', args: [], cwd: '~', sessionId: null, startCommand: null, ...init }),
  });
  api = createFakeApi();
  notify = vi.fn<(message: string) => void>();
  c = new BoardController({ api, registry, homeDir: SAMPLE.home, notify });
  c.setPane({ w: 1200, h: 800 });
  await c.start();
});

afterEach(() => {
  c.dispose();
  api.dispose();
});

const win = (wid: string) => c.windowById(id(wid))!;
const setAgents = (patch: (a: AgentInfo) => AgentInfo) => c.store.setState((s) => ({ agents: s.agents.map(patch) }));
const isItem = (e: MenuEntry | undefined): e is MenuItem => !!e && e.type !== 'separator' && e.type !== 'heading';
const windowMenu = (wid: string) =>
  menuItems(c, { screen: { x: 0, y: 0 }, flow: { x: 0, y: 0 }, target: { kind: 'window', windowId: id(wid) } }, { terminal: true, browser: true });
const forkItem = (wid: string) => windowMenu(wid).find((e) => isItem(e) && e.id === 'fork') as MenuItem | undefined;

describe('forkCheck (X4)', () => {
  it('agent terminals with a session id can fork; shell terminals are not offered fork at all', () => {
    expect(forkCheck(win('win-shop-claude'), c.state.agents, c.state.statuses)).toEqual({ ok: true, sessionId: 'session-cart' });
    expect(forkCheck(win('win-shop-shell'), c.state.agents, c.state.statuses)).toBeNull();
  });

  it('no session id yet (codex before its first message): disabled with a reason; the status snapshot’s id counts', () => {
    expect(forkCheck(win('win-login-codex'), c.state.agents, c.state.statuses)).toEqual({ ok: false, reason: 'No conversation to fork yet' });
    const statuses = { ...c.state.statuses, [T.loginCodex]: { ...c.state.statuses[T.loginCodex]!, sessionId: 'th-9' as AgentSessionId } };
    expect(forkCheck(win('win-login-codex'), c.state.agents, statuses)).toEqual({ ok: true, sessionId: 'th-9' });
  });

  it('agents that can’t fork (kimi) or are not installed say so', () => {
    const kimi = { ...win('win-shop-claude'), data: { ...(win('win-shop-claude').data as TerminalWindowData), agent: 'kimi' } };
    const agents: AgentInfo[] = [
      ...c.state.agents,
      { id: 'kimi', label: 'Kimi', installed: true, version: '2.3.1', capabilities: { hooks: false, resume: true, fork: false, askTool: false } },
    ];
    expect(forkCheck(kimi, agents, {})).toEqual({ ok: false, reason: "Kimi can't fork a conversation" });
    const gone = agents.map((a) => (a.id === 'claude' ? { ...a, installed: false } : a));
    expect(forkCheck(win('win-shop-claude'), gone, {})).toEqual({ ok: false, reason: 'Claude Code is not installed' });
  });
});

describe('forkInWorkspace (X4)', () => {
  it('opens the same agent in the target frame with mode fork; the original terminal stays where it is', async () => {
    const before = { ...win('win-shop-claude') };
    const terminalsBefore = api.fakes.agents.started.length;
    const created = await c.forkInWorkspace(id('win-shop-claude'), W.agentdeckMain, null);
    expect(api.fakes.agents.started).toHaveLength(terminalsBefore + 1);
    expect(api.fakes.agents.started.at(-1)!.request).toMatchObject({
      agent: 'claude',
      cwd: SAMPLE.paths.agentdeck,
      workspaceId: W.agentdeckMain,
      mode: { kind: 'fork', sessionId: 'session-cart' },
    });
    const forked = win(created!);
    expect(forked.workspaceId).toBe(W.agentdeckMain);
    expect((forked.data as TerminalWindowData).sessionId).not.toBe('session-cart'); // 新会话的 id
    // 原来的终端还在原来的框里、同一个进程和会话（框长大挤开别的框时位置可能跟着动，V3）
    expect(win('win-shop-claude').workspaceId).toBe(before.workspaceId);
    expect(win('win-shop-claude').data).toEqual(before.data);
    expect(c.state.focusedId).toBe(created);
  });

  it('when fork is not possible it says why and does not start anything', async () => {
    const n = api.fakes.agents.started.length;
    expect(await c.forkInWorkspace(id('win-login-codex'), W.shopCart, null)).toBeNull();
    expect(notify).toHaveBeenCalledWith('No conversation to fork yet');
    expect(await c.forkInWorkspace(id('win-shop-shell'), W.agentdeckMain, null)).toBeNull();
    expect(api.fakes.agents.started).toHaveLength(n);
  });

  it('an error from agents.start (no saved conversation yet) is shown, no window is added', async () => {
    const windows = c.state.windows.length;
    vi.spyOn(api.agents, 'start').mockRejectedValueOnce(
      Object.assign(new Error('No conversation to fork yet. Send Claude Code a message first.'), { code: 'not-found' }),
    );
    expect(await c.forkInWorkspace(id('win-shop-claude'), W.agentdeckMain, null)).toBeNull();
    expect(notify).toHaveBeenCalledWith('No conversation to fork yet. Send Claude Code a message first.');
    expect(c.state.windows).toHaveLength(windows);
  });
});

describe('terminal title bar menu: Fork conversation into… (X4)', () => {
  it('lists the other frames and forks into the picked one', async () => {
    const item = forkItem('win-shop-claude')!;
    expect(item.label).toBe('Fork conversation into…');
    expect(item.disabled).toBe(false);
    expect(item.items!.filter(isItem).map((i) => i.label)).toEqual(['agentdeck · main', 'agentdeck · feat/login']);
    const labels = windowMenu('win-shop-claude').map((e) => (isItem(e) ? e.label : '-'));
    expect(labels.indexOf('Fork conversation into…')).toBe(labels.indexOf('Open in another workspace') + 1);
    item.items!.filter(isItem)[0]!.onSelect!();
    await vi.waitFor(() => expect(api.fakes.agents.started.at(-1)!.request.mode).toEqual({ kind: 'fork', sessionId: 'session-cart' }));
  });

  it('is disabled with the reason when there is no session id or the agent can’t fork; absent for shells', () => {
    expect(forkItem('win-login-codex')).toMatchObject({ disabled: true, hint: 'No conversation to fork yet' });
    setAgents((a) => (a.id === 'claude' ? { ...a, capabilities: { ...a.capabilities, fork: false } } : a));
    expect(forkItem('win-shop-claude')).toMatchObject({ disabled: true, hint: "Claude Code can't fork a conversation" });
    expect(forkItem('win-shop-shell')).toBeUndefined();
  });
});

describe('W5 dialog: Fork button (X4)', () => {
  const show = (wid: string, to = W.agentdeckMain) => {
    c.openDialog({ kind: 'move-terminal', windowId: id(wid), to, at: { x: 0, y: 0 } });
    return render(
      <BoardProvider controller={c}>
        <BoardDialogs />
      </BoardProvider>,
    );
  };

  it('offers Fork next to Open new and forks into the drop target', async () => {
    show('win-shop-claude');
    expect(screen.getByText(/or fork this conversation there\? The original keeps running\./)).toBeTruthy();
    const fork = screen.getByRole('button', { name: 'Fork conversation into agentdeck · main' }) as HTMLButtonElement;
    expect(fork.textContent).toBe('Fork');
    expect(fork.disabled).toBe(false);
    expect(screen.getByRole('button', { name: 'Open new' })).toBeTruthy();
    fireEvent.click(fork);
    expect(c.state.dialog).toBeNull();
    await vi.waitFor(() =>
      expect(api.fakes.agents.started.at(-1)!.request).toMatchObject({ workspaceId: W.agentdeckMain, mode: { kind: 'fork', sessionId: 'session-cart' } }),
    );
  });

  it('Fork is disabled with the reason when there is no conversation yet', () => {
    show('win-login-codex', W.shopCart);
    const fork = screen.getByRole('button', { name: /Fork conversation into/ }) as HTMLButtonElement;
    expect(fork.disabled).toBe(true);
    expect(fork.title).toBe('No conversation to fork yet');
    expect(screen.getByText('Can’t fork: No conversation to fork yet.')).toBeTruthy();
    expect(screen.queryByText(/or fork this conversation/)).toBeNull();
  });

  it('shell terminals only get Cancel and Open new', () => {
    show('win-shop-shell');
    expect(screen.queryByRole('button', { name: /Fork/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open new' })).toBeTruthy();
  });
});
