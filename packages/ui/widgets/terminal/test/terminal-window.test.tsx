// 终端窗口对着 createFakeApi() 的假服务跑：attach / detach、输入、退出和重启、重开应用、摘要卡、状态、链接。

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentSessionId,
  OpenWindowRequest,
  Size,
  StatusSnapshot,
  TerminalId,
  TerminalWindowData,
  WindowCommand,
  WindowId,
  WindowNode,
  WindowStatusBadge,
  Workspace,
  WorkspaceId,
} from '@agentdeck/contracts';
import { createFakeApi, type FakeApi } from '@agentdeck/fakes';
import { TerminalWindow, terminalWindowType } from '../src/index.ts';
import { termSizeFor } from '../src/metrics.ts';

type FakeXterm = {
  focused: boolean;
  resets: number;
  keyHandler: ((e: KeyboardEvent) => boolean) | null;
  linkProviders: { provideLinks(y: number, cb: (links: { text: string; activate(e: unknown, t: string): void }[] | undefined) => void): void }[];
  input(data: string, user?: boolean): void;
  buffer: { active: { getLine(y: number): { translateToString(trim?: boolean): string } | undefined; length: number } };
};

let api: FakeApi;
const flush = () => act(async () => {
  await new Promise((r) => setTimeout(r, 10));
});

function screenText(term: FakeXterm): string {
  const out: string[] = [];
  for (let y = 0; y < term.buffer.active.length; y++) out.push(term.buffer.active.getLine(y)?.translateToString(true) ?? '');
  return out.join('\n').replace(/\n+$/, '');
}

interface Harness {
  setProps(p: Partial<HostProps>): void;
  data(): TerminalWindowData;
  status(): WindowStatusBadge | null;
  /** 每次 setStatus 的参数，按顺序。 */
  statusLog: (WindowStatusBadge | null)[];
  opened: OpenWindowRequest[];
  command(c: WindowCommand): void;
  closed: () => number;
}

interface HostProps {
  visible: boolean;
  summary: boolean;
  focused: boolean;
  contentSize: Size;
  workspace: Workspace | null;
}

function mount(data: Partial<TerminalWindowData>, initial: Partial<HostProps> = {}): Harness {
  const opened: OpenWindowRequest[] = [];
  const listeners = new Set<(c: WindowCommand) => void>();
  let current: TerminalWindowData = terminalWindowType.create(data);
  let status: WindowStatusBadge | null = null;
  const statusLog: (WindowStatusBadge | null)[] = [];
  let closed = 0;
  let setOuter: (p: Partial<HostProps>) => void = () => {};

  function Host(): ReactNode {
    const [props, setProps] = useState<HostProps>({ visible: true, summary: false, focused: true, contentSize: { w: 560, h: 332 }, workspace: null, ...initial });
    const [d, setD] = useState(current);
    // 和白板一样：setStatus 会让外面重新渲染，每次传进去的回调都是新的（防止来回触发）
    const [, rerender] = useState(0);
    setOuter = (p) => setProps((x) => ({ ...x, ...p }));
    const node: WindowNode<TerminalWindowData> = {
      id: 'w1' as WindowId,
      type: 'terminal',
      workspaceId: props.workspace?.id ?? null,
      rect: { x: 0, y: 0, w: 560, h: 360 },
      z: 0,
      title: null,
      restoreRect: null,
      data: d,
    };
    return (
      <TerminalWindow
        window={node}
        {...props}
        updateData={(patch) => {
          current = { ...current, ...patch };
          setD(current);
        }}
        setStatus={(s) => {
          status = s;
          statusLog.push(s);
          rerender((n) => n + 1);
        }}
        requestFocus={() => {}}
        openWindow={(req) => opened.push(req as OpenWindowRequest)}
        close={() => closed++}
        toggleMaximize={() => {}}
        onCommand={(l) => {
          listeners.add(l);
          return () => listeners.delete(l);
        }}
      />
    );
  }
  render(<Host />);
  return {
    setProps: (p) => act(() => setOuter(p)),
    data: () => current,
    status: () => status,
    statusLog,
    opened,
    command: (c) => act(() => listeners.forEach((l) => l(c))),
    closed: () => closed,
  };
}

function xterm(): FakeXterm {
  const el = document.querySelector('.ad-terminal__screen');
  // TerminalSession 把 Terminal 实例挂在 session.term 上；测试从 DOM 里拿不到，改从模块里记下来的取
  const t = (globalThis as { __lastXterm?: FakeXterm }).__lastXterm;
  if (!el || !t) throw new Error('no xterm');
  return t;
}

beforeEach(async () => {
  api = createFakeApi({ seed: false, silenceMs: 0 });
  window.agentdeck = api;
  // 记下最近创建的 xterm
  const mod = await import('@xterm/xterm');
  const Orig = mod.Terminal as unknown as { prototype: { open(el: HTMLElement): void } };
  const open = Orig.prototype.open;
  vi.spyOn(Orig.prototype, 'open').mockImplementation(function (this: FakeXterm, el: HTMLElement) {
    (globalThis as { __lastXterm?: FakeXterm }).__lastXterm = this;
    open.call(this, el);
  });
});

afterEach(() => {
  api.dispose();
  vi.restoreAllMocks();
});

const T = 'term-a' as TerminalId;
function makeTerminal(opts: { history?: string; exited?: number; cmd?: string } = {}): TerminalId {
  api.fakes.terminals.createWith(
    { cmd: opts.cmd ?? 'claude', args: [], cwd: '/repo' },
    { id: T, ...(opts.history !== undefined ? { history: opts.history } : {}), ...(opts.exited !== undefined ? { exited: opts.exited } : {}) },
  );
  return T;
}

describe('attach and display (T2)', () => {
  it('attaches when visible, shows the redraw, holds input until the first output', async () => {
    makeTerminal({ history: 'hello from tmux\r\n' });
    mount({ terminalId: T, agent: 'claude', cmd: 'claude', cwd: '/repo' });
    await waitFor(() => expect(api.fakes.terminals.views(T)).toHaveLength(1));
    const term = xterm();
    await waitFor(() => expect(screenText(term)).toContain('hello from tmux'));
    term.input('x', true);
    await flush();
    expect(api.fakes.terminals.get(T).inputs).toContain('x');
  });

  it('detaches when scrolled out of view and resets before attaching again', async () => {
    makeTerminal({ history: 'line\r\n' });
    const h = mount({ terminalId: T, agent: 'claude', cmd: 'claude', cwd: '/repo' });
    await waitFor(() => expect(api.fakes.terminals.views(T)).toHaveLength(1));
    const resets = xterm().resets;
    h.setProps({ visible: false });
    await waitFor(() => expect(api.fakes.terminals.views(T)).toHaveLength(0));
    h.setProps({ visible: true });
    await waitFor(() => expect(api.fakes.terminals.views(T)).toHaveLength(1));
    expect(xterm().resets).toBe(resets + 1);
  });

  it('answers XTVERSION and OSC 10/11 for tmux (Esc delay fix)', async () => {
    makeTerminal({ history: '$ ' });
    mount({ terminalId: T, agent: 'shell', cmd: '/bin/zsh', cwd: '/repo' });
    await waitFor(() => expect(api.fakes.terminals.views(T)).toHaveLength(1));
    await waitFor(() => expect(screenText(xterm())).toContain('$'));
    act(() => api.fakes.terminals.feed(T, '\x1b[>q\x1b]10;?\x1b\\\x1b]11;?\x1b\\'));
    await waitFor(() => {
      const inputs = api.fakes.terminals.get(T).inputs.join('');
      expect(inputs).toContain('\x1bP>|xterm.js\x1b\\');
      expect(inputs).toMatch(/\x1b\]10;rgb:[0-9a-f]{4}\/[0-9a-f]{4}\/[0-9a-f]{4}\x1b\\/);
      expect(inputs).toMatch(/\x1b\]11;rgb:/);
    });
  });

  it('Shift+Enter sends CSI 13;2u; ⌘ shortcuts are left to the board', async () => {
    makeTerminal({ history: '> ' });
    mount({ terminalId: T, agent: 'claude', cmd: 'claude', cwd: '/repo' });
    await waitFor(() => expect(screenText(xterm())).toContain('>'));
    const handler = xterm().keyHandler!;
    const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);
    expect(handler(key({ key: 'Enter', shiftKey: true }))).toBe(false);
    expect(handler(key({ key: 'k', metaKey: true }))).toBe(false);
    expect(handler(key({ key: 'Escape' }))).toBe(true);
    expect(handler(key({ key: 'c', ctrlKey: true }))).toBe(true);
    await flush();
    expect(api.fakes.terminals.get(T).inputs).toContain('\x1b[13;2u');
  });

  it('focuses the xterm only while the window is focused', async () => {
    makeTerminal({ history: 'x' });
    const h = mount({ terminalId: T, agent: 'claude', cmd: 'claude', cwd: '/repo' }, { focused: false });
    await waitFor(() => expect(api.fakes.terminals.views(T)).toHaveLength(1));
    expect(xterm().focused).toBe(false);
    h.setProps({ focused: true });
    expect(xterm().focused).toBe(true);
  });

  it('pastes dropped file paths quoted', async () => {
    makeTerminal({ history: '> ' });
    mount({ terminalId: T, agent: 'claude', cmd: 'claude', cwd: '/repo' });
    await waitFor(() => expect(screenText(xterm())).toContain('>'));
    const target = document.querySelector('.ad-terminal')!;
    fireEvent.drop(target, { dataTransfer: { files: [], types: ['text/uri-list'], getData: () => 'file:///Users/me/My%20File.png' } });
    await flush();
    expect(api.fakes.terminals.get(T).inputs.join('')).toContain(`'/Users/me/My File.png' `);
  });
});

describe('exit and restart (T5)', () => {
  it('shows the exit bar and restarts the same command in the same folder', async () => {
    makeTerminal({ history: 'Error: not logged in\r\n', cmd: 'codex' });
    const h = mount({ terminalId: T, agent: 'codex', cmd: 'codex', cwd: '/repo' });
    await waitFor(() => expect(api.fakes.terminals.views(T)).toHaveLength(1));
    act(() => api.fakes.terminals.exit(T, 1));
    expect(await screen.findByText('Process exited (code 1)')).toBeTruthy();
    expect(h.status()).toMatchObject({ text: 'Error · exit 1', tone: 'error' });
    expect(screenText(xterm())).toContain('Error: not logged in');
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    await waitFor(() => expect(h.data().terminalId).not.toBe(T));
    expect(api.fakes.agents.started.at(-1)?.request).toMatchObject({ agent: 'codex', cwd: '/repo', mode: { kind: 'new' } });
    expect(api.fakes.terminals.has(T)).toBe(false);
    await waitFor(() => expect(api.fakes.terminals.views(h.data().terminalId!)).toHaveLength(1));
    expect(screen.queryByText('Process exited (code 1)')).toBeNull();
  });

  it('Close on the exit bar closes the window', async () => {
    makeTerminal({ exited: 0, history: 'done\r\n' });
    const h = mount({ terminalId: T, agent: 'shell', cmd: '/bin/zsh', cwd: '/repo' });
    expect(await screen.findByText('Process exited')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(h.closed()).toBe(1);
  });

  it('command not found: offers Open Settings and Use Shell instead', async () => {
    api.fakes.agents.setAgent('gemini', { installed: false });
    const h = mount({ terminalId: null, agent: 'gemini', cmd: 'gemini', cwd: '/repo' });
    fireEvent.click(await screen.findByRole('button', { name: 'Restart' }));
    expect(await screen.findByText('Command not found: gemini')).toBeTruthy();
    const opened = vi.fn();
    document.addEventListener('agentdeck:open-settings', opened);
    fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }));
    expect(opened).toHaveBeenCalledTimes(1);
    document.removeEventListener('agentdeck:open-settings', opened);
    fireEvent.click(screen.getByRole('button', { name: 'Use Shell instead' }));
    await waitFor(() => expect(h.data().agent).toBe('shell'));
    expect(h.data().terminalId).not.toBeNull();
  });
});

describe('reopening the app (T6)', () => {
  it('reattaches to the saved terminal when it is still in tmux', async () => {
    makeTerminal({ history: 'still running\r\n' });
    mount({ terminalId: T, agent: 'claude', cmd: 'claude', cwd: '/repo' });
    await waitFor(() => expect(screenText(xterm())).toContain('still running'));
  });

  it('shows "Previous session ended" with Restart ▾ (resume / new) when the session is gone', async () => {
    const h = mount({ terminalId: 'gone' as TerminalId, agent: 'claude', cmd: 'claude', cwd: '/repo', sessionId: 's-1' as AgentSessionId });
    expect(await screen.findByText('Previous session ended')).toBeTruthy();
    expect(h.status()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Restart ▾' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Resume conversation' }));
    await waitFor(() => expect(h.data().terminalId).not.toBe('gone'));
    expect(api.fakes.agents.started.at(-1)?.request.mode).toEqual({ kind: 'resume', sessionId: 's-1' });
    expect(h.data().sessionId).toBe('s-1');
  });

  it('a shell without a session id gets a plain Restart', async () => {
    mount({ terminalId: 'gone' as TerminalId, agent: 'shell', cmd: '/bin/zsh', cwd: '/repo' });
    expect(await screen.findByText('Previous session ended')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Restart' })).toBeTruthy();
  });

  it('tmux server lost: "Session ended"', async () => {
    makeTerminal({ history: 'x' });
    mount({ terminalId: T, agent: 'claude', cmd: 'claude', cwd: '/repo' });
    await waitFor(() => expect(api.fakes.terminals.views(T)).toHaveLength(1));
    act(() => api.fakes.terminals.hostLost());
    expect(await screen.findByText('Session ended')).toBeTruthy();
  });
});

describe('summary card (T8)', () => {
  it('dragged small: does not attach; shows the last 3 lines and keeps them fresh', async () => {
    makeTerminal({ history: 'one\r\ntwo\r\nthree\r\nfour\r\n' });
    const h = mount({ terminalId: T, agent: 'claude', cmd: 'claude', cwd: '/repo' }, { summary: true, contentSize: { w: 240, h: 110 } });
    expect(await screen.findByText('four')).toBeTruthy();
    expect(screen.getByText('two')).toBeTruthy();
    expect(screen.queryByText('one')).toBeNull();
    expect(api.fakes.terminals.views(T)).toHaveLength(0);
    act(() => api.fakes.terminals.feed(T, 'five\r\n'));
    expect(await screen.findByText('five', {}, { timeout: 2000 })).toBeTruthy();
    // 恢复原大小：接上显示
    h.setProps({ summary: false });
    await waitFor(() => expect(api.fakes.terminals.views(T)).toHaveLength(1));
  });

  it('board zoomed out: a full-size window shows its whole screen as text, not just 3 lines (IS-41)', async () => {
    makeTerminal({ history: 'one\r\ntwo\r\nthree\r\nfour\r\n' });
    mount({ terminalId: T, agent: 'claude', cmd: 'claude', cwd: '/repo' }, { summary: true, contentSize: { w: 560, h: 332 } });
    expect(await screen.findByText('one')).toBeTruthy();
    expect(screen.getByText('four')).toBeTruthy();
    expect(document.querySelector('.ad-terminal__summary--screen')).not.toBeNull();
    expect(api.fakes.terminals.views(T)).toHaveLength(0);
  });
});

describe('title bar status', () => {
  it('follows status.changed for this terminal and stores the session id', async () => {
    makeTerminal({ history: 'x' });
    const h = mount({ terminalId: T, agent: 'codex', cmd: 'codex', cwd: '/repo' });
    await waitFor(() => expect(api.fakes.terminals.views(T)).toHaveLength(1));
    const snap: StatusSnapshot = {
      terminalId: T,
      status: 'needs-approval',
      since: new Date(Date.now() - 3.5 * 60_000).toISOString(),
      exitCode: null,
      pending: null,
      sessionId: 'codex-thread-1' as AgentSessionId,
    };
    act(() => api.bus.emit({ type: 'status.changed', snapshot: { ...snap, terminalId: 'other' as TerminalId, status: 'idle' } }));
    act(() => api.bus.emit({ type: 'status.changed', snapshot: snap }));
    await waitFor(() => expect(h.status()).toEqual({ text: 'Waiting · 3m', tone: 'attention', dot: 'filled', detail: 'Needs approval' }));
    expect(h.data().sessionId).toBe('codex-thread-1');
  });
});

describe('outside workspace hint (IS-57, N7)', () => {
  const ws: Workspace = {
    id: 'ws-1' as WorkspaceId,
    projectId: 'p-1' as Workspace['projectId'],
    name: 'feat-oauth',
    mode: 'worktree',
    path: '/private/var/repo/feat-oauth',
    branch: 'feat/oauth',
    repos: [],
    createdAt: new Date().toISOString(),
    missing: false,
  };
  const running = (): StatusSnapshot => ({ terminalId: T, status: 'running', since: new Date().toISOString(), exitCode: null, pending: null, sessionId: null });

  /** 假服务的 list() 里 cwd 固定是创建时的目录；改成测试里可变的当前目录。 */
  function fakeCwd(initial: string): { cd(path: string): void } {
    let cwd = initial;
    const list = api.terminals.list.bind(api.terminals);
    vi.spyOn(api.terminals, 'list').mockImplementation(async () => (await list()).map((t) => (t.id === T ? { ...t, cwd } : t)));
    return {
      cd: (path) => {
        cwd = path;
        // 命令跑完、安静下来时重新取一次
        act(() => api.bus.emit({ type: 'terminal.silence', id: T, at: new Date().toISOString() }));
      },
    };
  }

  it('tags the title bar when the terminal cd’s out of its frame’s folder, and clears it on the way back', async () => {
    makeTerminal({ history: 'x' });
    const sh = fakeCwd('/private/var/repo/feat-oauth/');
    const h = mount({ terminalId: T, agent: 'shell', cmd: 'zsh', cwd: ws.path }, { workspace: ws });
    await waitFor(() => expect(api.fakes.terminals.views(T)).toHaveLength(1));
    act(() => api.bus.emit({ type: 'status.changed', snapshot: running() }));
    await waitFor(() => expect(h.status()).toMatchObject({ text: 'Running · now', tone: 'running' }));
    expect(h.status()?.tag).toBeUndefined();

    sh.cd('/Users/me/other-repo');
    await waitFor(() => expect(h.status()?.tag?.text).toBe('outside workspace'));
    // 只是提示：状态灯和文字不变，悬停写实际目录和工作区目录
    expect(h.status()).toMatchObject({ text: 'Running · now', tone: 'running', dot: 'filled' });
    expect(h.status()?.tag?.detail).toBe('Now in /Users/me/other-repo\nWorkspace: /private/var/repo/feat-oauth');

    sh.cd('/private/var/repo/feat-oauth/src');
    await waitFor(() => expect(h.status()?.tag).toBeUndefined());
    expect(h.status()).toMatchObject({ text: 'Running · now', tone: 'running' });
  });

  it('a sibling folder with the same prefix counts as outside', async () => {
    makeTerminal({ history: 'x' });
    fakeCwd('/private/var/repo/feat-oauth-2');
    const h = mount({ terminalId: T, agent: 'shell', cmd: 'zsh', cwd: ws.path }, { workspace: ws });
    act(() => api.bus.emit({ type: 'status.changed', snapshot: running() }));
    await waitFor(() => expect(h.status()?.tag?.text).toBe('outside workspace'));
  });

  it('terminals not in a frame never get the tag', async () => {
    makeTerminal({ history: 'x' });
    fakeCwd('/somewhere/else');
    const h = mount({ terminalId: T, agent: 'shell', cmd: 'zsh', cwd: '/repo' });
    await waitFor(() => expect(api.fakes.terminals.views(T)).toHaveLength(1));
    act(() => api.bus.emit({ type: 'status.changed', snapshot: running() }));
    await waitFor(() => expect(h.status()).toMatchObject({ text: 'Running · now' }));
    await flush();
    expect(h.status()?.tag).toBeUndefined();
  });

  it('pushes the badge again when only the tag changed (the board ignores same text / tone / dot)', async () => {
    makeTerminal({ history: 'x' });
    const sh = fakeCwd(ws.path);
    const h = mount({ terminalId: T, agent: 'shell', cmd: 'zsh', cwd: ws.path }, { workspace: ws });
    act(() => api.bus.emit({ type: 'status.changed', snapshot: running() }));
    await waitFor(() => expect(h.status()).toMatchObject({ text: 'Running · now' }));
    const before = h.statusLog.length;
    sh.cd('/tmp');
    await waitFor(() => expect(h.status()?.tag?.text).toBe('outside workspace'));
    // canvas 的 setBadge 只比 text / tone / dot：先清掉再给，标签才会出现
    expect(h.statusLog.slice(before)).toEqual([null, expect.objectContaining({ text: 'Running · now', tag: expect.objectContaining({ text: 'outside workspace' }) })]);
  });
});

describe('board commands', () => {
  it('clear sends C-l, restart restarts, open in system terminal calls the app', async () => {
    makeTerminal({ history: 'x' });
    const h = mount({ terminalId: T, agent: 'claude', cmd: 'claude', cwd: '/repo' });
    await waitFor(() => expect(api.fakes.terminals.views(T)).toHaveLength(1));
    h.command('clear');
    await flush();
    expect(api.fakes.terminals.get(T).keys).toContainEqual(['C-l']);
    h.command('open-in-system-terminal');
    await flush();
    expect(api.fakes.app.calls).toContainEqual({ method: 'openInSystemTerminal', args: [T] });
    h.command('restart');
    await waitFor(() => expect(h.data().terminalId).not.toBe(T));
  });

  it('restart and resume conversation keeps the session id; without one it starts fresh', async () => {
    makeTerminal({ history: 'x' });
    const h = mount({ terminalId: T, agent: 'claude', cmd: 'claude', cwd: '/repo', sessionId: 's-1' as AgentSessionId });
    await waitFor(() => expect(api.fakes.terminals.views(T)).toHaveLength(1));
    h.command('restart-resume');
    await waitFor(() => expect(h.data().terminalId).not.toBe(T));
    expect(api.fakes.agents.started.at(-1)?.request.mode).toEqual({ kind: 'resume', sessionId: 's-1' });
    expect(h.data().sessionId).toBe('s-1');
  });

  it('restart and resume on a shell (no session id) is a plain restart', async () => {
    makeTerminal({ history: 'x' });
    const h = mount({ terminalId: T, agent: 'shell', cmd: '/bin/zsh', cwd: '/repo' });
    await waitFor(() => expect(api.fakes.terminals.views(T)).toHaveLength(1));
    h.command('restart-resume');
    await waitFor(() => expect(h.data().terminalId).not.toBe(T));
    expect(api.fakes.agents.started.at(-1)?.request.mode).toEqual({ kind: 'new' });
  });
});

describe('links', () => {
  it('localhost opens a browser window next to the terminal; file:line opens the editor', async () => {
    makeTerminal({ history: '  Local:   http://localhost:5173/\r\nsrc/auth/oauth.ts:44 changed\r\n' });
    const h = mount({ terminalId: T, agent: 'shell', cmd: '/bin/zsh', cwd: '/repo', startCommand: 'pnpm dev' });
    await waitFor(() => expect(screenText(xterm())).toContain('oauth.ts'));
    const provider = xterm().linkProviders[0]!;
    const linksAt = (y: number) =>
      new Promise<{ text: string; activate(e: unknown, t: string): void }[]>((resolve) => provider.provideLinks(y, (l) => resolve(l ?? [])));
    const urlLinks = await linksAt(1);
    expect(urlLinks.map((l) => l.text)).toEqual(['http://localhost:5173/']);
    urlLinks[0]!.activate({}, urlLinks[0]!.text);
    expect(h.opened[0]).toEqual({
      type: 'browser',
      data: { url: 'http://localhost:5173/', mode: 'frame', openedBy: { terminalId: T, label: 'zsh · pnpm dev' } },
      reuseKey: 'http://localhost:5173',
    });
    const fileLinks = await linksAt(2);
    expect(fileLinks.map((l) => l.text)).toEqual(['src/auth/oauth.ts:44']);
    fileLinks[0]!.activate({}, fileLinks[0]!.text);
    await flush();
    expect(api.fakes.app.calls).toContainEqual({ method: 'openInEditor', args: ['/repo/src/auth/oauth.ts', 44] });
  });
});

describe('terminalWindowType', () => {
  it('fills the 0.1.3 fields', () => {
    const d = terminalWindowType.create({ terminalId: T, agent: 'claude', cmd: 'claude', cwd: '/repo' });
    expect(terminalWindowType).toMatchObject({ type: 'terminal', pinnedToWorkspace: true, summaryBelow: { w: 320, h: 200 } });
    expect(terminalWindowType.title?.(d)).toBe('claude');
    expect(terminalWindowType.title?.({ ...d, agent: 'shell', cmd: '/bin/zsh' })).toBe('zsh');
    expect(terminalWindowType.closeConfirm?.(d)).toEqual({ title: 'Close claude?', body: 'claude will be stopped. This can’t be undone.', confirm: 'Stop and close' });
    expect(terminalWindowType.closeConfirm?.({ ...d, terminalId: null })).toBeNull();
    expect(terminalWindowType.menu?.map((m) => m.label)).toEqual(['Clear', 'Restart', 'Restart and resume conversation', 'Open in system terminal']);
    expect(terminalWindowType.termSize?.({ w: 560, h: 332 })).toEqual({ cols: 69, rows: 19 });
  });

  it('onClose kills the terminal', async () => {
    makeTerminal();
    await terminalWindowType.onClose?.(terminalWindowType.create({ terminalId: T }));
    expect(api.fakes.terminals.has(T)).toBe(false);
  });
});

describe('size changes while attaching', () => {
  it('sends a resize when the size changed before attach() returned', async () => {
    makeTerminal({ history: 'x' });
    const resize = vi.spyOn(api.terminals, 'resize');
    const attach = api.terminals.attach.bind(api.terminals);
    let release: () => void = () => {};
    vi.spyOn(api.terminals, 'attach').mockImplementation(async (id, size) => {
      await new Promise<void>((r) => (release = r));
      return attach(id, size);
    });
    const h = mount({ terminalId: T, agent: 'claude', cmd: 'claude', cwd: '/repo' }, { contentSize: { w: 560, h: 332 } });
    await flush();
    // attach 还没返回时窗口改了大小
    h.setProps({ contentSize: { w: 400, h: 200 } });
    await flush();
    release();
    await waitFor(() => expect(resize).toHaveBeenCalled());
    expect(resize.mock.calls.at(-1)?.[1]).toEqual({ cols: 49, rows: 11 });
  });
  it('maximize / restore: measures after the board has laid out the new size, for a short while (IS-49)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const observers: { cb: () => void; connected: boolean }[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        entry: { cb: () => void; connected: boolean };
        constructor(cb: () => void) {
          this.entry = { cb, connected: false };
          observers.push(this.entry);
        }
        observe() {
          this.entry.connected = true;
        }
        disconnect() {
          this.entry.connected = false;
        }
      },
    );
    try {
      makeTerminal({ history: 'x' });
      const resize = vi.spyOn(api.terminals, 'resize');
      const h = mount({ terminalId: T, agent: 'claude', cmd: 'claude', cwd: '/repo' }, { contentSize: { w: 560, h: 332 } });
      await waitFor(() => expect(api.fakes.terminals.views(T)).toHaveLength(1));
      resize.mockClear();
      h.setProps({ contentSize: { w: 1070, h: 758 } });
      await flush();
      // 白板把新大小排到页面上之前不量：等观察器报
      expect(resize).not.toHaveBeenCalled();
      const live = observers.filter((o) => o.connected);
      expect(live).toHaveLength(1);
      act(() => live[0]!.cb());
      await waitFor(() => expect(resize).toHaveBeenCalled());
      expect(resize.mock.calls.at(-1)?.[1]).toEqual(termSizeFor({ w: 1070, h: 758 }));
      // 一秒后不再盯着，拖动等别的大小变化不会顺带改 tmux
      act(() => vi.advanceTimersByTime(1100));
      expect(observers.some((o) => o.connected)).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
