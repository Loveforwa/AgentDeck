import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindowData, TerminalWindowData, WindowComponentProps, WindowId } from '@agentdeck/contracts';
import { createFakeApi, SAMPLE, type FakeApi } from '@agentdeck/fakes';
import { BoardController } from '../src/controller.ts';
import { createWindowRegistry } from '../src/registry.ts';

const W = SAMPLE.workspaces;
const T = SAMPLE.terminals;
const id = (s: string) => s as WindowId;
const Nothing = (_p: WindowComponentProps<any>) => null; // eslint-disable-line @typescript-eslint/no-explicit-any

function setup() {
  const registry = createWindowRegistry();
  registry.register<TerminalWindowData>({
    type: 'terminal',
    label: 'Terminal',
    defaultSize: { w: 560, h: 360 },
    minSize: { w: 110, h: 60 },
    summaryBelow: { w: 320, h: 200 },
    component: Nothing,
    create: (init) => ({ terminalId: null, agent: 'shell', cmd: 'zsh', args: [], cwd: '~', sessionId: null, startCommand: null, ...init }),
  });
  registry.register<BrowserWindowData>({
    type: 'browser',
    label: 'Browser',
    defaultSize: { w: 520, h: 360 },
    minSize: { w: 110, h: 60 },
    component: Nothing,
    create: (init) => ({ url: 'http://localhost:3000/', mode: 'frame', ...init }),
  });
  const api = createFakeApi();
  const notify = vi.fn();
  const c = new BoardController({ api, registry, homeDir: SAMPLE.home, notify });
  c.setPane({ w: 1200, h: 800 });
  return { api, c, notify };
}

let api: FakeApi;
let c: BoardController;

beforeEach(async () => {
  ({ api, c } = setup());
  await c.start();
});

afterEach(() => {
  c.dispose();
  api.dispose();
  vi.useRealTimers();
});

const win = (wid: string) => c.windowById(id(wid))!;
const frame = (ws: string) => c.state.frames.find((f) => f.workspaceId === ws)!;

describe('start (B5 restore)', () => {
  it('restores the saved board and loads workspaces, projects, agents, statuses', () => {
    expect(c.state.loaded).toBe(true);
    expect(c.state.frames).toHaveLength(3);
    expect(c.state.windows).toHaveLength(6);
    expect(c.state.viewport.zoom).toBe(0.6);
    expect(Object.keys(c.state.workspaces)).toHaveLength(3);
    expect(c.state.projects.map((p) => p.name)).toContain('agentdeck');
    expect(c.state.agents.some((a) => a.id === 'claude')).toBe(true);
    expect(c.state.statuses[T.loginCodex]?.status).toBe('needs-approval');
  });
});

describe('autosave (B5)', () => {
  it('does not save on load, saves once half a second after changes', async () => {
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.fakes.board.saves).toBe(0);
    c.togglePanel();
    c.setPanelWidth(400);
    c.moveFrameStart(W.shopCart);
    c.moveFrame(W.shopCart, 10, 20);
    c.moveFrameEnd();
    await vi.advanceTimersByTimeAsync(499);
    expect(api.fakes.board.saves).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.fakes.board.saves).toBe(1);
    const saved = api.fakes.board.current()!;
    expect(saved.panel).toEqual({ open: false, width: 400 });
    expect(saved.frames.find((f) => f.workspaceId === W.shopCart)!.rect).toMatchObject({ x: 42, y: 580 });
    expect(saved.version).toBe(1);
  });

  it('transient state (focus, badges, menus) does not trigger a save', async () => {
    vi.useFakeTimers();
    c.setBadge(id('win-dev-server'), { text: 'Running', tone: 'default', dot: 'filled' });
    c.openMenu({ screen: { x: 0, y: 0 }, flow: { x: 0, y: 0 }, target: { kind: 'pane' } });
    c.selectFrame(null);
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.fakes.board.saves).toBe(0);
  });

  it('a restarted controller gets back the same layout', async () => {
    c.renameWindow(id('win-shop-shell'), 'build');
    await c.flush();
    const again = new BoardController({ api, registry: c.registry });
    await again.start();
    expect(again.state.windows).toEqual(c.state.windows);
    expect(again.windowById(id('win-shop-shell'))!.title).toBe('build');
    again.dispose();
  });
});

describe('attention (S3) and ⌘J', () => {
  it('counts waiting windows from status.changed, per workspace, and sets the dock badge', () => {
    expect(c.attention().waiting).toEqual(['win-login-codex']);
    api.scenario.agentNeedsApproval(T.loginClaude, { command: 'pnpm test' });
    const a = c.attention();
    expect([...a.waiting].sort()).toEqual(['win-login-claude', 'win-login-codex']);
    expect(a.waitingByWorkspace[W.agentdeckLogin]).toBe(2);
    expect(api.fakes.app.badge).toBe(2);
    api.scenario.agentTurnEnd(T.loginClaude);
    expect(c.attention().waiting).toEqual(['win-login-codex']);
    expect(api.fakes.app.badge).toBe(1);
  });

  it('⌘J jumps through waiting windows in turn and focuses them', () => {
    api.scenario.agentAsks(T.shopClaude);
    expect(c.runShortcut('next-waiting')).toBe(true);
    expect(c.state.focusedId).toBe('win-login-codex');
    c.jumpToNextWaiting();
    expect(c.state.focusedId).toBe('win-shop-claude');
    c.jumpToNextWaiting();
    expect(c.state.focusedId).toBe('win-login-codex');
    // 跳过去时视口把窗口完整放进来，最大 100%
    expect(c.state.viewport.zoom).toBeLessThanOrEqual(1);
  });

  it('⌘J and ⌘⇧J flash the window they land on; ⌘⇧J goes backwards', () => {
    api.scenario.agentAsks(T.shopClaude);
    api.scenario.agentNeedsApproval(T.loginClaude, { command: 'pnpm test' });
    const order = c.attention().waiting;
    expect(order).toHaveLength(3);
    expect(c.runShortcut('prev-waiting')).toBe(true);
    expect(c.state.focusedId).toBe(order[2]);
    expect(c.state.flash[order[2]!]).toBe(1);
    c.jumpToPrevWaiting();
    expect(c.state.focusedId).toBe(order[1]);
    c.jumpToNextWaiting();
    expect(c.state.focusedId).toBe(order[2]);
    expect(c.state.flash[order[2]!]).toBe(2);
    c.jumpToNextWaiting();
    expect(c.state.focusedId).toBe(order[0]);
    expect(c.state.flash[order[0]!]).toBe(1);
  });

  it('nothing waiting: ⌘J and ⌘⇧J do nothing', () => {
    api.scenario.agentTurnEnd(T.loginCodex);
    expect(c.attention().waiting).toEqual([]);
    c.focusWindow(id('win-browser'));
    expect(c.jumpToNextWaiting()).toBeNull();
    expect(c.jumpToPrevWaiting()).toBeNull();
    expect(c.state.focusedId).toBe('win-browser');
    expect(c.state.flash).toEqual({});
  });
});

describe('⌘⇧] ⌘⇧[ window navigation (S3)', () => {
  it('walks every window by position: within the frame, then the next frames, cycling', () => {
    c.focusWindow(id('win-dev-server'));
    const seen: (string | null)[] = [];
    for (let i = 0; i < 6; i += 1) {
      expect(c.runShortcut('next-window')).toBe(true);
      seen.push(c.state.focusedId);
    }
    expect(seen).toEqual(['win-browser', 'win-login-claude', 'win-login-codex', 'win-shop-claude', 'win-shop-shell', 'win-dev-server']);
    expect(c.runShortcut('prev-window')).toBe(true);
    expect(c.state.focusedId).toBe('win-shop-shell');
    // 不闪：只有 ⌘J 闪
    expect(c.state.flash).toEqual({});
  });

  it('a window already in view keeps the viewport; one off screen brings it in', () => {
    c.viewportChanged({ x: 0, y: 0, zoom: 1 });
    c.focusWindow(id('win-dev-server'));
    c.jumpToAdjacentWindow(1); // 网页窗口 648..1168，在 1200 宽的视口里
    expect(c.state.focusedId).toBe('win-browser');
    expect(c.state.viewport).toEqual({ x: 0, y: 0, zoom: 1 });
    c.jumpToAdjacentWindow(1); // 下一个框里，在视口外
    expect(c.state.focusedId).toBe('win-login-claude');
    expect(c.state.viewport).not.toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it('with a frame selected and no window focused, starts in that frame', () => {
    c.selectFrame(W.shopCart);
    c.jumpToAdjacentWindow(1);
    expect(c.state.focusedId).toBe('win-shop-claude');
    c.focusWindow(null);
    c.jumpToAdjacentWindow(-1);
    expect(c.state.focusedId).toBe('win-shop-shell');
  });

  it('a notification click jumps to that terminal', () => {
    api.scenario.notificationClicked(T.shopShell);
    expect(c.state.focusedId).toBe('win-shop-shell');
  });
});

describe('new windows (B3, W3)', () => {
  it('a terminal made in a frame runs in the workspace folder and stays inside the frame', async () => {
    const wid = await c.newTerminal({ agent: 'claude', workspaceId: W.agentdeckLogin });
    const started = api.fakes.agents.started.at(-1)!;
    expect(started.request).toMatchObject({ agent: 'claude', cwd: SAMPLE.paths.agentdeckLogin, workspaceId: W.agentdeckLogin });
    expect(started.request.size?.cols).toBeGreaterThan(20);
    const w = win(wid!);
    expect(w.workspaceId).toBe(W.agentdeckLogin);
    expect((w.data as TerminalWindowData).terminalId).toBe(started.result.terminalId);
    const f = frame(W.agentdeckLogin).rect;
    expect(w.rect.x + w.rect.w).toBeLessThanOrEqual(f.x + f.w);
    expect(w.rect.y + w.rect.h).toBeLessThanOrEqual(f.y + f.h);
    expect(c.state.focusedId).toBe(wid);
  });

  it('a loose terminal runs in the home folder, placed where the menu was opened', async () => {
    const wid = await c.newTerminal({ agent: 'shell', workspaceId: null, at: { x: 3000, y: 3000 } });
    expect(api.fakes.agents.started.at(-1)!.request.cwd).toBe(SAMPLE.home);
    expect(win(wid!).rect).toMatchObject({ x: 3000, y: 3000, w: 560, h: 360 });
    expect(win(wid!).workspaceId).toBeNull();
  });

  it('⌘N opens the default agent next to the focused window, in its workspace', async () => {
    c.focusWindow(id('win-shop-claude'));
    c.runShortcut('new-terminal');
    await vi.waitFor(() => expect(api.fakes.agents.started).toHaveLength(1));
    const req = api.fakes.agents.started[0]!.request;
    expect(req.workspaceId).toBe(W.shopCart);
    const added = c.state.windows.at(-1)!;
    const near = win('win-shop-claude');
    expect(added.rect.x).toBe(near.rect.x + near.rect.w + 16);
  });

  it('openWindow reuses the window with the same key and flashes it', () => {
    const a = c.openWindow(id('win-dev-server'), { type: 'browser', data: { url: 'http://localhost:5173/a', mode: 'frame' }, reuseKey: 'http://localhost:5173' });
    expect(win(a!).workspaceId).toBe(W.agentdeckMain);
    const b = c.openWindow(id('win-dev-server'), { type: 'browser', data: { url: 'http://localhost:5173/b', mode: 'frame' }, reuseKey: 'http://localhost:5173' });
    expect(b).toBe(a);
    expect((win(a!).data as BrowserWindowData).url).toBe('http://localhost:5173/b');
    expect(c.state.flash[a!]).toBe(1);
  });
});

describe('moving windows between frames (W3, W5)', () => {
  const inside = (ws: string) => {
    const r = frame(ws).rect;
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  };

  it('a terminal dropped into another frame springs back and offers to open a new one there', async () => {
    const start = win('win-shop-claude').rect;
    const shopFrame = frame(W.shopCart).rect;
    c.moveWindowStart(id('win-shop-claude'));
    c.moveWindow(id('win-shop-claude'), 100, -500, inside(W.agentdeckMain));
    expect(c.state.dropTarget).toBe(W.agentdeckMain);
    expect(frame(W.shopCart).rect).toEqual(shopFrame); // 指针在别的框里时自己的框不长
    c.moveWindowEnd(id('win-shop-claude'));
    expect(win('win-shop-claude').rect).toEqual(start);
    expect(win('win-shop-claude').workspaceId).toBe(W.shopCart);
    expect(c.state.dialog).toMatchObject({ kind: 'move-terminal', windowId: 'win-shop-claude', to: W.agentdeckMain });
    expect(c.moveTerminalMessage(id('win-shop-claude'), W.agentdeckMain)).toBe(
      'This terminal runs in shop · fix/cart-total and can’t change folders. Open a new claude in agentdeck · main?',
    );

    const created = await c.openInWorkspace(id('win-shop-claude'), W.agentdeckMain, null);
    expect(c.state.dialog).toBeNull();
    expect(api.fakes.agents.started.at(-1)!.request).toMatchObject({ agent: 'claude', cwd: SAMPLE.paths.agentdeck, workspaceId: W.agentdeckMain });
    expect(win(created!).workspaceId).toBe(W.agentdeckMain);
  });

  it('a loose terminal dragged into a frame also springs back', () => {
    void c.newTerminal({ agent: 'claude', workspaceId: null, at: { x: 3000, y: 3000 } });
    return vi.waitFor(() => {
      const loose = c.state.windows.find((w) => w.workspaceId === null)!;
      c.moveWindowStart(loose.id);
      c.moveWindow(loose.id, -2900, -2900, inside(W.agentdeckMain));
      c.moveWindowEnd(loose.id);
      expect(win(loose.id).rect).toMatchObject({ x: 3000, y: 3000 });
      expect(c.moveTerminalMessage(loose.id, W.agentdeckMain)).toContain('runs in ~');
    });
  });

  it('dragging toward the edge grows the frame instead of leaving it', () => {
    const before = frame(W.shopCart).rect;
    c.moveWindowStart(id('win-shop-shell'));
    c.moveWindow(id('win-shop-shell'), 300, 200, { x: 5000, y: 5000 });
    const grown = frame(W.shopCart).rect;
    const w = win('win-shop-shell').rect;
    expect(grown.x + grown.w).toBe(w.x + w.w + 16);
    expect(grown.y + grown.h).toBe(w.y + w.h + 16);
    c.moveWindowEnd(id('win-shop-shell'));
    expect(win('win-shop-shell').workspaceId).toBe(W.shopCart);
    expect(frame(W.shopCart).rect.w).toBeGreaterThan(before.w);
    expect(c.state.dialog).toBeNull();
  });

  it('a browser window can move to another frame', () => {
    c.moveWindowStart(id('win-browser'));
    c.moveWindow(id('win-browser'), 0, 600, inside(W.shopCart));
    c.moveWindowEnd(id('win-browser'));
    expect(win('win-browser').workspaceId).toBe(W.shopCart);
    expect(c.state.dialog).toBeNull();
  });

  it('dragging a frame title moves the windows inside', () => {
    const before = c.state.windows.filter((w) => w.workspaceId === W.shopCart).map((w) => w.rect);
    c.moveFrameStart(W.shopCart);
    c.moveFrame(W.shopCart, 50, -30);
    c.moveFrameEnd();
    const after = c.state.windows.filter((w) => w.workspaceId === W.shopCart).map((w) => w.rect);
    after.forEach((r, i) => expect(r).toEqual({ ...before[i]!, x: before[i]!.x + 50, y: before[i]!.y - 30 }));
    expect(win('win-dev-server').rect.x).toBe(64); // 别的框里的不动
  });

  it('a frame cannot be resized smaller than its windows plus 16px', () => {
    const f = frame(W.shopCart).rect;
    c.resizeFrameStart(W.shopCart, 'se');
    c.resizeFrame(W.shopCart, -2000, -2000);
    c.resizeFrameEnd();
    const r = frame(W.shopCart).rect;
    const shell = win('win-shop-shell').rect;
    expect(r.x + r.w).toBe(shell.x + shell.w + 16);
    expect(r.y + r.h).toBe(shell.y + shell.h + 16);
    expect(r.x).toBe(f.x);
  });
});

describe('window frame (B2)', () => {
  it('resizing only changes the window when released, and below 320×200 it becomes a summary card', () => {
    const wid = id('win-shop-claude');
    const start = win('win-shop-claude').rect;
    c.resizeWindowStart(wid, 'se');
    c.resizeWindow(wid, -400, -250);
    expect(win('win-shop-claude').rect).toEqual(start); // 松手前不变，组件的 contentSize 不跳
    expect(c.state.resizing?.rect.w).toBe(start.w - 400);
    c.resizeWindowEnd(wid);
    const small = win('win-shop-claude');
    expect(small.rect.w).toBe(start.w - 400);
    expect(c.isSummary(small, small.rect, 1)).toBe(true);
    expect(small.restoreRect).toEqual(start);
    expect(c.isMaximized(small)).toBe(false);
    c.expandSummary(wid);
    expect(win('win-shop-claude').rect).toMatchObject({ w: start.w, h: start.h });
    expect(c.state.focusedId).toBe(wid);
  });

  it('respects the minimum size of the window type', () => {
    c.resizeWindowStart(id('win-shop-claude'), 'nw');
    c.resizeWindow(id('win-shop-claude'), 5000, 5000);
    c.resizeWindowEnd(id('win-shop-claude'));
    expect(win('win-shop-claude').rect).toMatchObject({ w: 110, h: 60 });
  });

  it('maximize fills the viewport at 100% and restores', () => {
    const start = win('win-dev-server').rect;
    c.focusWindow(id('win-dev-server'));
    c.runShortcut('toggle-maximize');
    const big = win('win-dev-server');
    expect(c.isMaximized(big)).toBe(true);
    expect(big.rect).toMatchObject({ w: 1200 - 32, h: 800 - 32 });
    expect(c.state.viewport.zoom).toBe(1);
    c.toggleMaximize(id('win-dev-server'));
    expect(win('win-dev-server').rect).toEqual(start);
    expect(win('win-dev-server').restoreRect).toBeNull();
    // 还原后窗口在屏幕正中（视口 1200×800，缩放 1）
    const vp = c.state.viewport;
    expect(start.x + start.w / 2 + vp.x).toBe(600);
    expect(start.y + start.h / 2 + vp.y).toBe(400);
  });

  it('focus raises the window above the others', () => {
    c.focusWindow(id('win-dev-server'));
    const top = Math.max(...c.state.windows.map((w) => w.z));
    expect(win('win-dev-server').z).toBe(top);
    expect(c.state.windows.filter((w) => w.z === top)).toHaveLength(1);
  });

  it('closing a running terminal asks first, then stops it', async () => {
    c.focusWindow(id('win-login-claude'));
    c.runShortcut('close-window');
    expect(c.state.dialog).toEqual({ kind: 'stop-terminal', windowId: 'win-login-claude' });
    expect(c.windowById(id('win-login-claude'))).toBeDefined();
    await c.stopAndClose(id('win-login-claude'));
    expect(c.windowById(id('win-login-claude'))).toBeUndefined();
    expect((await api.terminals.list()).some((t) => t.id === T.loginClaude)).toBe(false);
    expect(c.state.focusedId).toBeNull();
  });

  it('an exited terminal and a browser window close without asking', () => {
    c.closeWindow(id('win-shop-shell'));
    c.closeWindow(id('win-browser'));
    expect(c.state.dialog).toBeNull();
    expect(c.windowById(id('win-shop-shell'))).toBeUndefined();
    expect(c.windowById(id('win-browser'))).toBeUndefined();
  });
});

describe('workspaces (W3, W4)', () => {
  it('creating a workspace shows a frame at once, then runs the setup command in a Shell inside it', async () => {
    const at = { x: 3000, y: 100 };
    const promise = c.createWorkspace(
      { projectId: SAMPLE.projects.agentdeck, mode: 'worktree', branch: { kind: 'new', name: 'feat/oauth' } },
      at,
    );
    expect(c.state.pending).toHaveLength(1);
    expect(c.state.pending[0]).toMatchObject({ label: 'agentdeck · feat/oauth', rect: { x: 3000, y: 100 } });
    const ws = await promise;
    expect(c.state.pending).toHaveLength(0);
    expect(frame(ws!).rect).toMatchObject({ x: 3000, y: 100 });
    const shell = c.state.windows.find((w) => w.workspaceId === ws)!;
    expect(shell.title).toBe('setup');
    const req = api.fakes.agents.started.at(-1)!.request;
    expect(req).toMatchObject({ agent: 'shell', command: 'pnpm install', workspaceId: ws });
    expect(req.cwd).toBe(c.state.workspaces[ws!]!.path);
  });

  it('a failed create keeps the frame with the error and can retry with the existing branch', async () => {
    const ws = await c.createWorkspace({ projectId: SAMPLE.projects.agentdeck, mode: 'worktree', branch: { kind: 'new', name: 'feat/login' } }, null);
    expect(ws).toBeNull();
    const p = c.state.pending[0]!;
    expect(p.error?.code).toBeTruthy();
    c.dismissPending(p.id);
    expect(c.state.pending).toHaveLength(0);
  });

  it('Main folder is not offered when it is already on the board', () => {
    expect(c.mainFolderOnBoard(SAMPLE.projects.agentdeck)).toBe(true);
    expect(c.mainFolderOnBoard(SAMPLE.projects.shop)).toBe(false);
  });

  it('removing with uncommitted changes asks again, then deletes with force and stops the terminals', async () => {
    c.selectFrame(W.agentdeckLogin);
    expect(c.runShortcut('delete-selection')).toBe(true);
    expect(c.state.dialog).toMatchObject({ kind: 'remove-workspace', workspaceId: W.agentdeckLogin, dirty: false });
    expect(c.runningTerminalNames(W.agentdeckLogin)).toEqual(['claude', 'codex']);

    expect(await c.removeWorkspace(W.agentdeckLogin, true)).toBe(false);
    expect(c.state.dialog).toMatchObject({ kind: 'remove-workspace', dirty: true, busy: false });
    expect(frame(W.agentdeckLogin)).toBeDefined();

    expect(await c.removeWorkspace(W.agentdeckLogin, true, true)).toBe(true);
    expect(c.state.frames.find((f) => f.workspaceId === W.agentdeckLogin)).toBeUndefined();
    expect(c.state.windows.some((w) => w.workspaceId === W.agentdeckLogin)).toBe(false);
    const alive = (await api.terminals.list()).map((t) => t.id);
    expect(alive).not.toContain(T.loginClaude);
    expect(alive).not.toContain(T.loginCodex);
    expect(c.state.dialog).toBeNull();
  });

  it('Remove from board keeps the folder', async () => {
    expect(await c.removeWorkspace(W.shopCart, false)).toBe(true);
    expect(c.state.frames).toHaveLength(2);
  });
});

describe('Add project…', () => {
  it('picks a folder, adds it and opens New workspace for it', async () => {
    api.fakes.app.queuePickFolder(SAMPLE.paths.blog);
    const pid = await c.addProject({ x: 10, y: 20 });
    expect(pid).toBeTruthy();
    expect(c.state.projects.some((p) => p.id === pid)).toBe(true);
    expect(c.state.dialog).toEqual({ kind: 'new-workspace', projectId: pid, at: { x: 10, y: 20 } });
  });

  it('cancelling the folder picker does nothing', async () => {
    api.fakes.app.queuePickFolder(null);
    expect(await c.addProject()).toBeNull();
    expect(c.state.dialog).toBeNull();
  });
});

describe('windows and frames from services (M1: agents through MCP)', () => {
  const terminalData = (terminalId: string): TerminalWindowData => ({
    terminalId: terminalId as TerminalWindowData['terminalId'],
    agent: 'claude',
    cmd: 'claude',
    args: [],
    cwd: SAMPLE.paths.agentdeckLogin,
    sessionId: null,
    startCommand: null,
  });

  it('board.open-window puts the window in the frame without taking focus or moving the view, and flashes it', () => {
    c.focusWindow(id('win-shop-claude'));
    const viewport = c.state.viewport;
    api.bus.emit({ type: 'board.open-window', request: { type: 'terminal', data: terminalData('term-new'), workspaceId: W.agentdeckLogin }, highlight: true });
    const w = c.state.windows.find((n) => (n.data as TerminalWindowData).terminalId === 'term-new')!;
    expect(w.workspaceId).toBe(W.agentdeckLogin);
    expect(c.state.focusedId).toBe('win-shop-claude');
    expect(c.state.viewport).toEqual(viewport);
    expect(c.state.flash[w.id]).toBe(1);
  });

  it('reusing a browser window by origin updates it quietly', () => {
    c.focusWindow(id('win-shop-claude'));
    const req = { type: 'browser', data: { url: 'http://localhost:5173/a', mode: 'frame' }, workspaceId: W.agentdeckMain, reuseKey: 'http://localhost:5173' } as const;
    const a = c.openWindowFromService(req, true)!;
    const viewport = c.state.viewport;
    const b = c.openWindowFromService({ ...req, data: { url: 'http://localhost:5173/b', mode: 'frame' } }, true);
    expect(b).toBe(a);
    expect((win(a).data as BrowserWindowData).url).toBe('http://localhost:5173/b');
    expect(c.state.focusedId).toBe('win-shop-claude');
    expect(c.state.viewport).toEqual(viewport);
  });

  it('a window for a workspace that is not on the board is loose', () => {
    const wid = c.openWindowFromService({ type: 'terminal', data: terminalData('term-x'), workspaceId: 'ws-gone' as never }, false)!;
    expect(win(wid).workspaceId).toBeNull();
    expect(c.state.flash[wid]).toBeUndefined();
  });

  it('board.add-frame adds the workspace and a frame in a free spot, once', async () => {
    const { workspace } = await api.workspaces.create({ projectId: SAMPLE.projects.agentdeck, mode: 'worktree', branch: { kind: 'new', name: 'feat/mcp' } });
    const before = c.state.frames.length;
    api.bus.emit({ type: 'board.add-frame', workspace });
    api.bus.emit({ type: 'board.add-frame', workspace });
    expect(c.state.frames).toHaveLength(before + 1);
    expect(c.state.workspaces[workspace.id]?.branch).toBe('feat/mcp');
    const rect = frame(workspace.id).rect;
    for (const f of c.state.frames.filter((x) => x.workspaceId !== workspace.id)) {
      const overlap = rect.x < f.rect.x + f.rect.w && f.rect.x < rect.x + rect.w && rect.y < f.rect.y + f.rect.h && f.rect.y < rect.y + rect.h;
      expect(overlap).toBe(false);
    }
    api.bus.emit({ type: 'board.open-window', request: { type: 'terminal', data: terminalData('term-y'), workspaceId: workspace.id }, highlight: true });
    expect(c.state.windows.find((n) => (n.data as TerminalWindowData).terminalId === 'term-y')!.workspaceId).toBe(workspace.id);
  });
});
