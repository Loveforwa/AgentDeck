// N1：agent 通过 MCP 让白板做的事——网页开在调用者旁边、一组终端（窗口组）挂在调用者旁边、拉到眼前、通知。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindowData, Rect, TerminalId, TerminalWindowData, WindowComponentProps, WindowGroupMemberRequest, WindowId, WorkspaceId } from '@agentdeck/contracts';
import { createFakeApi, SAMPLE, type FakeApi } from '@agentdeck/fakes';
import { BoardController } from '../src/controller.ts';
import { GAP } from '../src/model/avoid.ts';
import { dissolveGroups, listGroups } from '../src/model/groups.ts';
import { createWindowRegistry } from '../src/registry.ts';

const W = SAMPLE.workspaces;
const T = SAMPLE.terminals;
const Nothing = (_p: WindowComponentProps<any>) => null; // eslint-disable-line @typescript-eslint/no-explicit-any

function registry() {
  const r = createWindowRegistry();
  r.register<TerminalWindowData>({
    type: 'terminal',
    label: 'Terminal',
    defaultSize: { w: 560, h: 360 },
    minSize: { w: 110, h: 60 },
    component: Nothing,
    create: (init) => ({ terminalId: null, agent: 'shell', cmd: 'zsh', args: [], cwd: '~', sessionId: null, startCommand: null, ...init }),
  });
  r.register<BrowserWindowData>({
    type: 'browser',
    label: 'Browser',
    defaultSize: { w: 520, h: 360 },
    minSize: { w: 110, h: 60 },
    component: Nothing,
    create: (init) => ({ url: 'http://localhost:3000/', mode: 'frame', ...init }),
  });
  return r;
}

let api: FakeApi;
let c: BoardController;
let notify: ReturnType<typeof vi.fn<(message: string) => void>>;

async function boot(a: FakeApi): Promise<BoardController> {
  const ctl = new BoardController({ api: a, registry: registry(), homeDir: SAMPLE.home, notify });
  ctl.setPane({ w: 1200, h: 800 });
  await ctl.start();
  return ctl;
}

beforeEach(async () => {
  api = createFakeApi();
  notify = vi.fn<(message: string) => void>();
  c = await boot(api);
});

afterEach(() => {
  c.dispose();
  api.dispose();
});

const terminal = (tid: string, agent = 'claude'): TerminalWindowData => ({
  terminalId: tid as TerminalId,
  agent,
  cmd: agent,
  args: [],
  cwd: SAMPLE.paths.agentdeckLogin,
  sessionId: null,
  startCommand: null,
});
const member = (tid: string, label: string | null, workspaceId: WorkspaceId | null = W.agentdeckLogin): WindowGroupMemberRequest => ({
  request: { type: 'terminal', data: terminal(tid), workspaceId },
  label,
});
const byTerminal = (tid: string) => c.state.windows.find((w) => (w.data as Partial<TerminalWindowData>).terminalId === tid)!;
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('open_browser beside the caller (board.open-window nearTerminal)', () => {
  it('puts the page right of the calling terminal, in its frame, without taking focus', () => {
    // 散放的一个终端，右边是空的
    api.bus.emit({ type: 'board.open-window', request: { type: 'terminal', data: terminal('term-lead'), workspaceId: null }, highlight: false });
    const lead = byTerminal('term-lead');
    c.focusWindow(lead.id);
    c.focusWindow(null);
    const viewport = c.state.viewport;
    api.bus.emit({
      type: 'board.open-window',
      request: { type: 'browser', data: { url: 'http://localhost:3000/', mode: 'frame' }, workspaceId: null, reuseKey: 'http://localhost:3000' },
      highlight: true,
      nearTerminal: 'term-lead' as TerminalId,
    });
    const page = c.state.windows.find((w) => w.type === 'browser' && w.workspaceId === null)!;
    expect(page.rect).toMatchObject({ x: lead.rect.x + lead.rect.w + GAP, y: lead.rect.y });
    expect(c.state.focusedId).toBeNull();
    expect(c.state.viewport).toEqual(viewport);
    expect(c.state.flash[page.id]).toBe(1);
  });

  it('in a frame it stays in the caller’s frame next to the caller, not on top of anything', () => {
    const claude = byTerminal(T.loginClaude);
    api.bus.emit({
      type: 'board.open-window',
      request: { type: 'browser', data: { url: 'http://localhost:4000/', mode: 'frame' }, workspaceId: W.agentdeckLogin },
      highlight: true,
      nearTerminal: T.loginClaude,
    });
    const page = c.state.windows.find((w) => w.type === 'browser' && w.workspaceId === W.agentdeckLogin)!;
    expect(page.workspaceId).toBe(W.agentdeckLogin);
    for (const w of c.state.windows.filter((x) => x.id !== page.id && x.workspaceId === W.agentdeckLogin)) expect(overlaps(page.rect, w.rect)).toBe(false);
    // 右边被 codex 占了，挪到最近的空位：仍然挨着 claude（不会跑到视口中心去）
    const dx = Math.max(0, page.rect.x - (claude.rect.x + claude.rect.w), claude.rect.x - (page.rect.x + page.rect.w));
    const dy = Math.max(0, page.rect.y - (claude.rect.y + claude.rect.h), claude.rect.y - (page.rect.y + page.rect.h));
    expect(Math.max(dx, dy)).toBeLessThanOrEqual(GAP * 2);
  });

  it('a caller in another workspace does not pull the page out of its frame', () => {
    api.bus.emit({
      type: 'board.open-window',
      request: { type: 'browser', data: { url: 'http://localhost:4100/', mode: 'frame' }, workspaceId: W.shopCart },
      highlight: false,
      nearTerminal: T.loginClaude,
    });
    const page = c.state.windows.find((w) => w.type === 'browser' && w.workspaceId === W.shopCart)!;
    const shop = c.state.frames.find((f) => f.workspaceId === W.shopCart)!;
    expect(page.rect.x).toBeGreaterThanOrEqual(shop.rect.x);
    expect(page.rect.y).toBeGreaterThanOrEqual(shop.rect.y);
  });

  it('the reuse key is saved with the board, so the same origin reuses the window after a restart', async () => {
    const req = { type: 'browser', data: { url: 'http://localhost:5555/a', mode: 'frame' }, workspaceId: W.agentdeckMain, reuseKey: 'http://localhost:5555' } as const;
    const a = c.openWindowFromService(req, true)!;
    await c.flush();
    c.dispose();
    c = await boot(api);
    const b = c.openWindowFromService({ ...req, data: { url: 'http://localhost:5555/b', mode: 'frame' } }, true);
    expect(b).toBe(a);
    expect((c.windowById(a)!.data as BrowserWindowData).url).toBe('http://localhost:5555/b');
  });
});

describe('window groups (board.open-group)', () => {
  it('puts the terminals next to the lead as a grid, records the group and keeps focus and view', () => {
    c.focusWindow(byTerminal(T.shopClaude).id);
    const viewport = c.state.viewport;
    const lead = byTerminal(T.loginClaude);
    api.bus.emit({ type: 'board.open-group', lead: T.loginClaude, members: [member('sub-1', 'api'), member('sub-2', 'ui'), member('sub-3', 'tests')], highlight: true });
    const subs = ['sub-1', 'sub-2', 'sub-3'].map(byTerminal);
    expect(c.state.focusedId).toBe(byTerminal(T.shopClaude).id);
    expect(c.state.viewport).toEqual(viewport);
    for (const s of subs) {
      expect(s.workspaceId).toBe(W.agentdeckLogin);
      expect(s.rect.x).toBeGreaterThanOrEqual(lead.rect.x + lead.rect.w);
      expect(c.state.flash[s.id]).toBe(1);
    }
    // 互不重叠，也不盖住框里原来的窗口
    const inFrame = c.state.windows.filter((w) => w.workspaceId === W.agentdeckLogin);
    for (const a of inFrame) for (const b of inFrame) if (a.id !== b.id) expect(overlaps(a.rect, b.rect)).toBe(false);
    // 框跟着长，装得下
    const f = c.state.frames.find((x) => x.workspaceId === W.agentdeckLogin)!;
    for (const s of subs) expect(s.rect.x + s.rect.w).toBeLessThanOrEqual(f.rect.x + f.rect.w);

    const lead2 = byTerminal(T.loginClaude);
    expect(lead2.group).toMatchObject({ role: 'lead', label: null });
    expect(subs.map((s) => s.group)).toEqual(['api', 'ui', 'tests'].map((label) => ({ id: lead2.group!.id, role: 'member', label })));
    const [g] = listGroups(c.state.windows);
    expect(g!.lead.id).toBe(lead.id);
    expect(g!.members.map((m) => m.group!.label)).toEqual(['api', 'ui', 'tests']);
  });

  it('is saved with the board and restored after a restart', async () => {
    api.bus.emit({ type: 'board.open-group', lead: T.loginClaude, members: [member('sub-1', 'api'), member('sub-2', null)], highlight: true });
    await c.flush();
    const saved = api.fakes.board.current()!;
    expect(saved.windows.filter((w) => w.group?.role === 'member').map((w) => w.group!.label)).toEqual(['api', null]);
    c.dispose();
    c = await boot(api);
    const [g] = listGroups(c.state.windows);
    expect(g!.lead.id).toBe(byTerminal(T.loginClaude).id);
    expect(g!.members.map((m) => (m.data as TerminalWindowData).terminalId)).toEqual(['sub-1', 'sub-2']);
  });

  it('a second call joins the same group; a member opening more puts them in that group too', () => {
    api.bus.emit({ type: 'board.open-group', lead: T.loginClaude, members: [member('sub-1', 'api')], highlight: false });
    api.bus.emit({ type: 'board.open-group', lead: T.loginClaude, members: [member('sub-2', 'ui')], highlight: false });
    api.bus.emit({ type: 'board.open-group', lead: 'sub-1' as TerminalId, members: [member('sub-1a', 'api-db')], highlight: false });
    const groups = listGroups(c.state.windows);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.members.map((m) => m.group!.label)).toEqual(['api', 'ui', 'api-db']);
    expect(byTerminal('sub-1').group!.role).toBe('member');
  });

  it('closing the lead leaves the sub-terminals as normal windows', async () => {
    api.bus.emit({ type: 'board.open-group', lead: T.loginClaude, members: [member('sub-1', 'api'), member('sub-2', 'ui')], highlight: false });
    await c.stopAndClose(byTerminal(T.loginClaude).id);
    expect(c.windowById(byTerminal('sub-1').id)).toBeDefined();
    expect(byTerminal('sub-1').group).toBeNull();
    expect(byTerminal('sub-2').group).toBeNull();
    expect(listGroups(c.state.windows)).toEqual([]);
  });

  it('closing every sub-terminal ends the group on the lead too', async () => {
    api.bus.emit({ type: 'board.open-group', lead: T.loginClaude, members: [member('sub-1', 'api'), member('sub-2', 'ui')], highlight: false });
    await c.stopAndClose(byTerminal('sub-1').id);
    expect(byTerminal(T.loginClaude).group?.role).toBe('lead');
    await c.stopAndClose(byTerminal('sub-2').id);
    expect(byTerminal(T.loginClaude).group).toBeNull();
  });

  it('without a lead window on the board they are just opened, no group', () => {
    api.bus.emit({ type: 'board.open-group', lead: null, members: [member('loose-1', null, null), member('loose-2', null, null)], highlight: true });
    expect(byTerminal('loose-1').group ?? null).toBeNull();
    expect(byTerminal('loose-2').workspaceId).toBeNull();
    expect(overlaps(byTerminal('loose-1').rect, byTerminal('loose-2').rect)).toBe(false);
  });

  it('dissolveGroups keeps the array when nothing changes', () => {
    const ws = c.state.windows;
    expect(dissolveGroups(ws)).toBe(ws);
  });
});

describe('focus_window and notify (board.focus-window, board.notify)', () => {
  it('focus brings the window into view and focuses it; while the user types it only flashes', () => {
    const shop = byTerminal(T.shopClaude);
    api.bus.emit({ type: 'board.focus-window', target: { terminalId: T.shopClaude } });
    expect(c.state.focusedId).toBe(shop.id);
    expect(c.state.flash[shop.id]).toBe(1);

    c.focusWindow(byTerminal(T.loginClaude).id);
    const viewport = c.state.viewport;
    c.noteKeyboardInput();
    api.bus.emit({ type: 'board.focus-window', target: { windowId: 'win-browser' as WindowId } });
    expect(c.state.focusedId).toBe(byTerminal(T.loginClaude).id);
    expect(c.state.viewport).toEqual(viewport);
    expect(c.state.flash['win-browser']).toBe(1);
  });

  it('keydown anywhere in the app counts as typing', () => {
    expect(c.isUserTyping()).toBe(false);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    expect(c.isUserTyping()).toBe(true);
    expect(c.isUserTyping(Date.now() + 5000)).toBe(false);
  });

  it('notify flashes the caller and shows a notice; while the user types only the flash', () => {
    const claude = byTerminal(T.loginClaude);
    api.bus.emit({ type: 'board.notify', from: T.loginClaude, message: 'Tests passed' });
    expect(c.state.flash[claude.id]).toBe(1);
    expect(notify).toHaveBeenCalledWith('claude · agentdeck · feat/login: Tests passed');

    notify.mockClear();
    c.noteKeyboardInput();
    api.bus.emit({ type: 'board.notify', from: T.loginClaude, message: 'Ready for review' });
    expect(c.state.flash[claude.id]).toBe(2);
    expect(notify).not.toHaveBeenCalled();
    expect(c.state.focusedId).not.toBe(claude.id);
  });
});
