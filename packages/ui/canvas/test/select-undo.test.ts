// X10：框选多选、一起拖动（吸附看外接矩形、松手整块避让、跨框各自长、不弹 W5），⌘Z / ⌘⇧Z 撤销白板上的操作
// （移动、改大小、放大 / 还原、关闭、框的移动和改大小、窗口组的显示方式、改名），一次拖动一步、最多 100 步。
// 对着 createFakeApi() 的示例白板：agentdeck · main（dev-server、browser）、feat/login（claude、codex）、shop · fix/cart-total（claude、shell）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BrowserWindowData,
  Rect,
  TerminalId,
  TerminalWindowData,
  WindowComponentProps,
  WindowGroupMemberRequest,
  WindowId,
  WindowNode,
} from '@agentdeck/contracts';
import { createFakeApi, SAMPLE, type FakeApi } from '@agentdeck/fakes';
import { BoardController } from '../src/controller.ts';
import { innerArea, intersects } from '../src/model/geometry.ts';
import { groupView, listGroups } from '../src/model/groups.ts';
import { BoardHistory, HISTORY_LIMIT, applyStep, diffLayout, type HistoryStep } from '../src/model/history.ts';
import { boxFrom, boxSelection, byWorkspace, toggleSelection, windowsInBox } from '../src/model/selection.ts';
import { createWindowRegistry } from '../src/registry.ts';

const W = SAMPLE.workspaces;
const T = SAMPLE.terminals;
const id = (s: string) => s as WindowId;
const Nothing = (_p: WindowComponentProps<any>) => null; // eslint-disable-line @typescript-eslint/no-explicit-any

function makeController(api: FakeApi, notify?: (m: string) => void) {
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
  const c = new BoardController({ api, registry, homeDir: SAMPLE.home, ...(notify ? { notify } : {}) });
  c.setPane({ w: 1200, h: 800 });
  return c;
}

let api: FakeApi;
let c: BoardController;
let notify: ReturnType<typeof vi.fn<(m: string) => void>>;

beforeEach(async () => {
  api = createFakeApi();
  notify = vi.fn<(m: string) => void>();
  c = makeController(api, notify);
  await c.start();
});

afterEach(() => {
  c.dispose();
  api.dispose();
});

const win = (wid: string) => c.windowById(id(wid))!;
const frame = (ws: string) => c.state.frames.find((f) => f.workspaceId === ws)!.rect;
const pointerIn = (ws: string) => ({ x: frame(ws).x + 40, y: frame(ws).y + 60 });

/** 拖一个窗口：按下、分几次移动（模拟一次拖动里很多个 pointermove）、松手。 */
function drag(wid: string, dx: number, dy: number, opts: { snap?: boolean; steps?: number; pointer?: { x: number; y: number } } = {}) {
  const w = win(wid);
  const pointer = opts.pointer ?? pointerIn(w.workspaceId!);
  c.moveWindowStart(id(wid));
  const steps = opts.steps ?? 4;
  for (let i = 1; i <= steps; i++) c.moveWindow(id(wid), (dx * i) / steps, (dy * i) / steps, pointer, { snap: opts.snap ?? false });
  c.moveWindowEnd(id(wid));
}

function shiftOf(before: Rect, after: Rect) {
  return { dx: after.x - before.x, dy: after.y - before.y };
}

describe('selection · pure functions', () => {
  const node = (wid: string, rect: Rect): WindowNode => ({ id: id(wid), type: 'terminal', workspaceId: null, rect, z: 1, title: null, restoreRect: null, data: {} });
  const a = node('a', { x: 0, y: 0, w: 100, h: 100 });
  const b = node('b', { x: 200, y: 0, w: 100, h: 100 });
  const cc = node('c', { x: 0, y: 300, w: 100, h: 100 });

  it('boxFrom works in any drag direction', () => {
    expect(boxFrom({ x: 50, y: 80 }, { x: 10, y: 20 })).toEqual({ x: 10, y: 20, w: 40, h: 60 });
  });

  it('a window is hit when the box touches it (not only when fully inside); skipped and empty boxes select nothing', () => {
    expect(windowsInBox({ x: 90, y: 90, w: 150, h: 20 }, [a, b, cc])).toEqual([id('a'), id('b')]);
    expect(windowsInBox({ x: 120, y: 120, w: 50, h: 50 }, [a, b, cc])).toEqual([]);
    expect(windowsInBox({ x: -10, y: -10, w: 500, h: 500 }, [a, b, cc], new Set([id('b')]))).toEqual([id('a'), id('c')]);
    expect(windowsInBox({ x: 50, y: 50, w: 0, h: 0 }, [a])).toEqual([]);
  });

  it('⌘ + box adds to the selection; a plain box replaces it', () => {
    expect(boxSelection([id('a')], [id('b')], false)).toEqual([id('b')]);
    expect(boxSelection([id('a')], [id('a'), id('b')], true)).toEqual([id('a'), id('b')]);
  });

  it('⌘-click toggles; the focused window counts as already picked when nothing is selected yet', () => {
    expect(toggleSelection([], id('b'), id('a'))).toEqual([id('a'), id('b')]);
    expect(toggleSelection([], id('a'), id('a'))).toEqual([id('a')]);
    expect(toggleSelection([id('a'), id('b')], id('a'), null)).toEqual([id('b')]);
    expect([...byWorkspace([a, b, { ...cc, workspaceId: W.shopCart }], [id('a'), id('c')]).keys()]).toEqual([null, W.shopCart]);
  });
});

describe('box select (controller)', () => {
  it('selects every window the box touches and unfocuses, so Esc and ⌘Z go to the board', () => {
    c.focusWindow(id('win-login-claude'));
    c.boxSelectStart({ x: 40, y: 80 });
    expect(c.state.focusedId).toBeNull();
    c.boxSelectMove({ x: 700, y: 120 });
    expect(c.state.selectionBox).toEqual({ x: 40, y: 80, w: 660, h: 40 });
    expect(c.state.selection).toEqual([id('win-dev-server'), id('win-browser')]);
    // 框缩回去：碰不到的去掉
    c.boxSelectMove({ x: 300, y: 120 });
    expect(c.state.selection).toEqual([id('win-dev-server')]);
    c.boxSelectEnd();
    expect(c.state.selectionBox).toBeNull();
    expect(c.state.selection).toEqual([id('win-dev-server')]);
    expect(c.runShortcut('escape')).toBe(true);
    expect(c.state.selection).toEqual([]);
  });

  it('⌘ + box adds; a box across frames picks windows from all of them', () => {
    c.setSelection([id('win-shop-shell')]);
    c.boxSelectStart({ x: 640, y: 100 }, true);
    c.boxSelectMove({ x: 1300, y: 110 });
    c.boxSelectEnd();
    expect(c.state.selection).toEqual([id('win-shop-shell'), id('win-browser'), id('win-login-claude')]);
  });

  it('closing a selected window drops it from the selection; selecting a frame clears it', () => {
    c.setSelection([id('win-shop-shell'), id('win-shop-claude')]);
    c.closeWindow(id('win-shop-shell')); // 已退出的终端直接关
    expect(c.state.selection).toEqual([id('win-shop-claude')]);
    c.selectFrame(W.agentdeckMain);
    expect(c.state.selection).toEqual([]);
  });
});

describe('moving the selection together', () => {
  it('dragging one selected window moves all selected by the same delta; the frame grows; one undo step', () => {
    const dev = win('win-dev-server').rect;
    const br = win('win-browser').rect;
    const f0 = frame(W.agentdeckMain);
    c.setSelection([id('win-dev-server'), id('win-browser')]);
    drag('win-browser', 30, 200);
    expect(shiftOf(dev, win('win-dev-server').rect)).toEqual({ dx: 30, dy: 200 });
    expect(shiftOf(br, win('win-browser').rect)).toEqual({ dx: 30, dy: 200 });
    // 框跟着长（下边、右边），装得下两个窗口
    const f1 = frame(W.agentdeckMain);
    expect(f1.y + f1.h).toBeGreaterThanOrEqual(win('win-browser').rect.y + win('win-browser').rect.h);
    expect(f1.h).toBeGreaterThan(f0.h);
    expect(c.history.size.undo).toBe(1);
    expect(c.undo()).toBe(true);
    expect(win('win-dev-server').rect).toEqual(dev);
    expect(win('win-browser').rect).toEqual(br);
    expect(frame(W.agentdeckMain)).toEqual(f0);
  });

  it('snapping looks at the bounding box of the selection: its left edge snaps to the frame’s inner edge', () => {
    const dev = win('win-dev-server').rect;
    const br = win('win-browser').rect;
    const inner = innerArea(frame(W.agentdeckMain));
    c.setSelection([id('win-dev-server'), id('win-browser')]);
    c.moveWindowStart(id('win-browser'));
    // 外接矩形左边离框的内边差 3（阈值 6 / 0.6 = 10）
    c.moveWindow(id('win-browser'), inner.x - dev.x + 3, 0, pointerIn(W.agentdeckMain), { snap: true });
    expect(win('win-dev-server').rect.x).toBe(inner.x);
    expect(win('win-browser').rect.x - win('win-dev-server').rect.x).toBe(br.x - dev.x);
    expect(c.state.guides.length).toBeGreaterThan(0);
    c.moveWindowEnd(id('win-browser'));
    expect(c.state.guides).toEqual([]);
  });

  it('on release the group moves as one block to the nearest free spot (keeps its own layout, covers nobody)', () => {
    // main 框里再放一个网页窗口，在两个选中的窗口下面
    const extra = c.addWindow({ type: 'browser', workspaceId: W.agentdeckMain, rect: { x: 64, y: 500, w: 520, h: 300 }, data: { url: 'http://localhost:1/', mode: 'frame' } });
    const dev = win('win-dev-server').rect;
    const br = win('win-browser').rect;
    c.setSelection([id('win-dev-server'), id('win-browser')]);
    drag('win-dev-server', 0, 380);
    const d1 = win('win-dev-server').rect;
    const b1 = win('win-browser').rect;
    expect(shiftOf(dev, d1)).toEqual(shiftOf(br, b1));
    for (const r of [d1, b1]) expect(intersects(r, win(extra).rect)).toBe(false);
    // 窗口都还在框里
    const f = frame(W.agentdeckMain);
    for (const r of [d1, b1, win(extra).rect]) expect(r.y + r.h).toBeLessThanOrEqual(f.y + f.h);
  });

  it('windows from different frames stay in their frames (no “move to another workspace” dialog); each frame grows', () => {
    const fMain = frame(W.agentdeckMain);
    c.setSelection([id('win-browser'), id('win-login-claude')]);
    // 指针落在 shop 框里：一个人拖时这会弹 W5，一起拖不弹
    drag('win-login-claude', 0, 120, { pointer: { x: frame(W.shopCart).x + 300, y: frame(W.shopCart).y + 100 } });
    expect(c.state.dialog).toBeNull();
    expect(win('win-browser').workspaceId).toBe(W.agentdeckMain);
    expect(win('win-login-claude').workspaceId).toBe(W.agentdeckLogin);
    const b = win('win-browser').rect;
    const fm = frame(W.agentdeckMain);
    expect(fm.h).toBeGreaterThan(fMain.h);
    expect(b.y + b.h).toBeLessThanOrEqual(fm.y + fm.h);
    const l = win('win-login-claude').rect;
    const fl = frame(W.agentdeckLogin);
    expect(l.y + l.h).toBeLessThanOrEqual(fl.y + fl.h);
    // 框之间仍然不重叠
    expect(intersects(fm, frame(W.shopCart))).toBe(false);
  });

  it('dragging a window that is not in the selection moves only that window', () => {
    const dev = win('win-dev-server').rect;
    c.setSelection([id('win-dev-server'), id('win-shop-claude')]);
    drag('win-browser', 0, 40);
    expect(win('win-dev-server').rect).toEqual(dev);
  });
});

describe('undo / redo', () => {
  it('window move: undo puts it back, redo moves it again; a drag of many pointer moves is one step', () => {
    const r0 = win('win-shop-claude').rect;
    drag('win-shop-claude', 0, 300, { steps: 12 });
    const r1 = win('win-shop-claude').rect;
    expect(r1).not.toEqual(r0);
    expect(c.history.size.undo).toBe(1);
    expect(c.runShortcut('undo')).toBe(true);
    expect(win('win-shop-claude').rect).toEqual(r0);
    expect(c.runShortcut('redo')).toBe(true);
    expect(win('win-shop-claude').rect).toEqual(r1);
  });

  it('a move that ends where it started (W5 bounce) is not a step', () => {
    c.moveWindowStart(id('win-shop-claude'));
    c.moveWindow(id('win-shop-claude'), 0, -500, { x: frame(W.agentdeckMain).x + 300, y: frame(W.agentdeckMain).y + 100 });
    c.moveWindowEnd(id('win-shop-claude'));
    expect(c.state.dialog?.kind).toBe('move-terminal');
    expect(c.history.size.undo).toBe(0);
  });

  it('resize window (and the frame that grew with it)', () => {
    const r0 = win('win-login-codex').rect;
    const f0 = frame(W.agentdeckLogin);
    c.resizeWindowStart(id('win-login-codex'), 'se');
    c.resizeWindow(id('win-login-codex'), 100, 200);
    c.resizeWindow(id('win-login-codex'), 200, 300);
    c.resizeWindowEnd(id('win-login-codex'));
    expect(win('win-login-codex').rect.h).toBe(r0.h + 300);
    expect(frame(W.agentdeckLogin).h).toBeGreaterThan(f0.h);
    c.undo();
    expect(win('win-login-codex').rect).toEqual(r0);
    expect(frame(W.agentdeckLogin)).toEqual(f0);
  });

  it('maximize and restore', () => {
    const r0 = win('win-dev-server').rect;
    c.toggleMaximize(id('win-dev-server'));
    expect(c.isMaximized(win('win-dev-server'))).toBe(true);
    c.undo();
    expect(win('win-dev-server').rect).toEqual(r0);
    expect(win('win-dev-server').restoreRect).toBeNull();
    c.redo();
    expect(c.isMaximized(win('win-dev-server'))).toBe(true);
    c.toggleMaximize(id('win-dev-server'));
    expect(c.isMaximized(win('win-dev-server'))).toBe(false);
    c.undo();
    expect(c.isMaximized(win('win-dev-server'))).toBe(true);
  });

  it('close window: undo puts the same window back in place (same id and terminal); the process is not touched', async () => {
    const before = win('win-login-claude');
    c.closeWindow(id('win-login-claude')); // 运行中：先确认
    await c.stopAndClose(id('win-login-claude'));
    expect(c.windowById(id('win-login-claude'))).toBeUndefined();
    const alive = () => api.terminals.list().then((l) => l.find((t) => t.id === T.loginClaude)?.alive ?? false);
    expect(await alive()).toBe(false);
    expect(c.undo()).toBe(true);
    const back = win('win-login-claude');
    expect(back.rect).toEqual(before.rect);
    expect(back.workspaceId).toBe(before.workspaceId);
    expect(back.data).toEqual(before.data);
    expect(back.z).toBeGreaterThan(before.z - 1);
    // 撤销不重启进程：终端窗口自己按 terminalId 去接，接不上就显示 Previous session ended
    expect(await alive()).toBe(false);
    expect(c.state.flash[back.id]).toBe(1);
    // 重做：再拿掉
    expect(c.redo()).toBe(true);
    expect(c.windowById(id('win-login-claude'))).toBeUndefined();
  });

  it('closing an exited terminal and a browser window are undoable too', () => {
    const shell = win('win-shop-shell');
    const browser = win('win-browser');
    c.closeWindow(shell.id);
    c.closeWindow(browser.id);
    expect(c.windowById(shell.id)).toBeUndefined();
    c.undo();
    expect(win('win-browser').rect).toEqual(browser.rect);
    expect(c.windowById(shell.id)).toBeUndefined();
    c.undo();
    expect(win('win-shop-shell').rect).toEqual(shell.rect);
  });

  it('redo of a close is refused when the terminal was restarted after the undo', async () => {
    c.closeWindow(id('win-shop-shell'));
    c.undo();
    c.updateData(id('win-shop-shell'), { terminalId: 'term-restarted' as TerminalId });
    expect(c.redo()).toBe(false);
    expect(c.windowById(id('win-shop-shell'))).toBeDefined();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Can’t redo'));
    expect(c.history.canRedo()).toBe(true);
  });

  it('frame move and frame resize (with the frames they pushed away)', () => {
    const f0 = frame(W.shopCart);
    const shop0 = win('win-shop-claude').rect;
    c.moveFrameStart(W.shopCart);
    c.moveFrame(W.shopCart, 0, 200);
    c.moveFrameEnd();
    expect(frame(W.shopCart).y).toBe(f0.y + 200);
    expect(win('win-shop-claude').rect.y).toBe(shop0.y + 200);
    const login0 = frame(W.agentdeckLogin);
    c.resizeFrameStart(W.agentdeckMain, 'e');
    c.resizeFrame(W.agentdeckMain, 300, 0);
    c.resizeFrameEnd();
    expect(frame(W.agentdeckLogin).x).toBeGreaterThan(login0.x); // 挤开了
    c.undo();
    expect(frame(W.agentdeckLogin)).toEqual(login0);
    c.undo();
    expect(frame(W.shopCart)).toEqual(f0);
    expect(win('win-shop-claude').rect).toEqual(shop0);
  });

  it('group view changes (collapse, show all, pick a sub-terminal)', () => {
    const member = (tid: string, label: string): WindowGroupMemberRequest => ({
      request: {
        type: 'terminal',
        data: { terminalId: tid as TerminalId, agent: 'claude', cmd: 'claude', args: [], cwd: SAMPLE.paths.agentdeckLogin, sessionId: null, startCommand: null },
        workspaceId: W.agentdeckLogin,
      },
      label,
    });
    api.bus.emit({ type: 'board.open-group', lead: T.loginClaude, members: [member('sub-1', 'api'), member('sub-2', 'ui')], highlight: false });
    expect(c.history.size.undo).toBe(0); // 服务开的不记
    const g = () => listGroups(c.state.windows)[0]!;
    const one = groupView(g());
    c.collapseGroup(g().id);
    expect(groupView(g()).mode).toBe('collapsed');
    c.showAllGroup(g().id);
    expect(groupView(g()).mode).toBe('all');
    c.undo();
    expect(groupView(g()).mode).toBe('collapsed');
    c.undo();
    expect(groupView(g())).toEqual(one);
    const second = g().members[1]!.id;
    c.selectGroupMember(second);
    expect(groupView(g())).toEqual({ mode: 'one', shown: second });
    c.undo();
    expect(groupView(g())).toEqual(one);
  });

  it('rename window and rename workspace', async () => {
    c.renameWindow(id('win-dev-server'), 'dev');
    expect(win('win-dev-server').title).toBe('dev');
    const oldName = c.state.workspaces[W.agentdeckLogin]!.name;
    await c.renameWorkspace(W.agentdeckLogin, 'Login work');
    expect(c.state.workspaces[W.agentdeckLogin]!.name).toBe('Login work');
    c.undo();
    await vi.waitFor(() => expect(c.state.workspaces[W.agentdeckLogin]!.name).toBe(oldName));
    c.undo();
    expect(win('win-dev-server').title).toBeNull();
    c.redo();
    expect(win('win-dev-server').title).toBe('dev');
  });

  it('a new step clears redo; history is capped at 100 steps; nothing to undo returns false', () => {
    expect(c.undo()).toBe(false);
    c.renameWindow(id('win-dev-server'), 'a');
    c.undo();
    expect(c.history.canRedo()).toBe(true);
    c.renameWindow(id('win-dev-server'), 'b');
    expect(c.history.canRedo()).toBe(false);
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) c.renameWindow(id('win-dev-server'), `n${i}`);
    expect(c.history.size.undo).toBe(HISTORY_LIMIT);
  });

  it('undo is ignored in the middle of a drag', () => {
    c.renameWindow(id('win-dev-server'), 'x');
    c.moveWindowStart(id('win-shop-claude'));
    c.moveWindow(id('win-shop-claude'), 0, 50, pointerIn(W.shopCart));
    expect(c.undo()).toBe(false);
    c.moveWindowEnd(id('win-shop-claude'));
    expect(win('win-dev-server').title).toBe('x');
  });

  it('undo only touches what that step changed: windows opened by a service later stay, and their data is kept', () => {
    drag('win-shop-claude', 0, 300);
    const opened = c.openWindowFromService({ type: 'browser', workspaceId: W.shopCart, data: { url: 'http://localhost:9/', mode: 'frame' } }, false);
    c.updateData(id('win-shop-claude'), { title: 'kept' });
    c.undo();
    expect(c.windowById(opened!)).toBeDefined();
    expect((win('win-shop-claude').data as { title?: string }).title).toBe('kept');
  });

  it('a step whose windows and frames are all gone (workspace removed) is skipped', async () => {
    drag('win-shop-claude', 0, 100);
    c.renameWindow(id('win-dev-server'), 'dev');
    c.undo(); // rename
    api.bus.emit({ type: 'workspace.removed', id: W.shopCart });
    expect(c.undo()).toBe(false);
    expect(c.windowById(id('win-shop-claude'))).toBeUndefined();
  });
});

describe('history · pure functions', () => {
  const n = (wid: string, x: number, extra: Partial<WindowNode> = {}): WindowNode => ({
    id: id(wid),
    type: 'terminal',
    workspaceId: null,
    rect: { x, y: 0, w: 100, h: 100 },
    z: 1,
    title: null,
    restoreRect: null,
    data: { v: 1 },
    ...extra,
  });

  it('diff ignores data and z, new windows; records closed windows and frame rects', () => {
    const before = { frames: [], windows: [n('a', 0), n('b', 0), n('c', 0)] };
    const after = { frames: [], windows: [n('a', 0, { data: { v: 2 }, z: 9 }), n('b', 50), n('d', 0)] };
    const step = diffLayout(before, after, 'x')!;
    expect(step.windows.map((w) => [w.id, w.after?.rect.x ?? null])).toEqual([
      [id('b'), 50],
      [id('c'), null],
    ]);
    expect(diffLayout(before, before, 'x')).toBeNull();
  });

  it('applyStep keeps current data, restores closed windows on top, and returns the same arrays when nothing changes', () => {
    const step: HistoryStep = {
      label: 'x',
      windows: [
        { id: id('b'), before: n('b', 0), after: n('b', 50) },
        { id: id('c'), before: n('c', 0, { z: 3 }), after: null },
      ],
      frames: [],
    };
    const cur = { frames: [], windows: [n('a', 0, { z: 5 }), n('b', 50, { data: { v: 7 } })] };
    const res = applyStep(cur, step, 'undo');
    expect(res.windows.find((w) => w.id === 'b')).toMatchObject({ rect: { x: 0 }, data: { v: 7 } });
    expect(res.restored.map((w) => [w.id, w.z])).toEqual([[id('c'), 6]]);
    const redo = applyStep({ frames: [], windows: res.windows }, step, 'redo');
    expect(redo.removed.map((w) => w.id)).toEqual([id('c')]);
    const none = applyStep(cur, { label: 'y', windows: [], frames: [] }, 'undo');
    expect(none.changed).toBe(false);
    expect(none.windows).toBe(cur.windows);
  });

  it('BoardHistory caps, clears redo on push, and moves steps between stacks', () => {
    const h = new BoardHistory(2);
    const s = (label: string): HistoryStep => ({ label, windows: [], frames: [] });
    h.push(s('1'));
    h.push(s('2'));
    h.push(s('3'));
    expect(h.size).toEqual({ undo: 2, redo: 0 });
    const top = h.take('undo')!;
    expect(top.label).toBe('3');
    h.done('undo', top);
    expect(h.canRedo()).toBe(true);
    h.push(s('4'));
    expect(h.canRedo()).toBe(false);
  });
});
