// V3（TC-31、IS-53、IS-54）：拖动和改大小时吸附、画对齐线；松手时不叠在别的窗口上；框之间至少 20px。
// 对着 createFakeApi() 的示例白板：三个框 agentdeck · main、agentdeck · feat/login、shop · fix/cart-total。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BrowserWindowData, FrameNode, Rect, TerminalWindowData, WindowComponentProps, WindowId, WindowNode, WorkspaceId } from '@agentdeck/contracts';
import { createFakeApi, SAMPLE, type FakeApi } from '@agentdeck/fakes';
import { BoardController } from '../src/controller.ts';
import { tooClose } from '../src/model/avoid.ts';
import { intersects } from '../src/model/geometry.ts';
import { createWindowRegistry } from '../src/registry.ts';

const W = SAMPLE.workspaces;
const id = (s: string) => s as WindowId;
const Nothing = (_p: WindowComponentProps<any>) => null; // eslint-disable-line @typescript-eslint/no-explicit-any

function makeController(api: FakeApi) {
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
  const c = new BoardController({ api, registry, homeDir: SAMPLE.home });
  c.setPane({ w: 1200, h: 800 });
  return c;
}

let api: FakeApi;
let c: BoardController;

beforeEach(async () => {
  api = createFakeApi();
  c = makeController(api);
  await c.start();
});

afterEach(() => {
  c.dispose();
  api.dispose();
});

const win = (wid: string) => c.windowById(id(wid))!;
const frame = (ws: string) => c.state.frames.find((f) => f.workspaceId === ws)!;
const inFrame = (ws: string) => c.state.windows.filter((w) => w.workspaceId === ws);
/** 框里起点（标题栏下面一点），指针放在这里不算进了别的框。 */
const pointerIn = (ws: string) => ({ x: frame(ws).rect.x + 40, y: frame(ws).rect.y + 60 });

function expectNoOverlaps(rects: Rect[]) {
  rects.forEach((a, i) => rects.slice(i + 1).forEach((b) => expect(intersects(a, b)).toBe(false)));
}

function browser(wid: string, ws: WorkspaceId, rect: Rect): WindowNode {
  return { id: id(wid), type: 'browser', workspaceId: ws, rect, z: 1, title: null, restoreRect: null, data: { url: 'http://localhost:3000/', mode: 'frame' } };
}

function layout(frames: [WorkspaceId, Rect][], windows: WindowNode[]) {
  const fs: FrameNode[] = frames.map(([workspaceId, rect]) => ({ workspaceId, rect, z: 0, autoApprove: false }));
  c.store.setState({ frames: fs, windows, viewport: { x: 0, y: 0, zoom: 1 } });
}

describe('snapping while dragging and resizing (V3)', () => {
  it('a window snaps to a neighbour’s top edge and draws a guide; ⌘ (snap off) moves freely', () => {
    const sid = id('win-shop-shell'); // 和 win-shop-claude 顶边对齐（y 624）
    c.moveWindowStart(sid);
    c.moveWindow(sid, 0, 4, pointerIn(W.shopCart), { snap: true });
    expect(win('win-shop-shell').rect.y).toBe(624);
    expect(c.state.guides).toContainEqual(expect.objectContaining({ kind: 'align', axis: 'y', at: 624 }));
    c.moveWindow(sid, 0, 4, pointerIn(W.shopCart), { snap: false });
    expect(win('win-shop-shell').rect.y).toBe(628);
    expect(c.state.guides).toEqual([]);
    c.moveWindow(sid, 0, 4, pointerIn(W.shopCart), { snap: true });
    c.moveWindowEnd(sid);
    expect(c.state.guides).toEqual([]);
    expect(win('win-shop-shell').rect.y).toBe(624);
  });

  it('the snap distance is 6 screen pixels, so it depends on the zoom', () => {
    const sid = id('win-shop-shell');
    // 示例白板 60%：6px = 10 白板单位，偏 8 也吸
    c.moveWindowStart(sid);
    c.moveWindow(sid, 0, 8, pointerIn(W.shopCart), { snap: true });
    expect(win('win-shop-shell').rect.y).toBe(624);
    // 200%：6px = 3 白板单位，偏 4 不吸
    c.viewportChanged({ x: 0, y: 0, zoom: 2 });
    c.moveWindow(sid, 0, 4, pointerIn(W.shopCart), { snap: true });
    expect(win('win-shop-shell').rect.y).toBe(628);
    c.moveWindowEnd(sid);
  });

  it('resizing snaps to the same width as a neighbour and labels the size', () => {
    const cid = id('win-shop-claude'); // 620 宽，旁边的 shell 520 宽
    c.resizeWindowStart(cid, 'e');
    c.resizeWindow(cid, -97, 0, { snap: true });
    expect(c.state.resizing?.rect.w).toBe(520);
    expect(c.state.guides).toContainEqual(expect.objectContaining({ kind: 'size', axis: 'x', size: 520 }));
    c.resizeWindowEnd(cid);
    expect(win('win-shop-claude').rect.w).toBe(520);
    expect(c.state.guides).toEqual([]);
  });

  it('dragging a frame snaps to other frames and stops 20px before them, with the gap labelled', () => {
    c.moveFrameStart(W.agentdeckMain);
    c.moveFrame(W.agentdeckMain, 500, 0, { snap: true });
    // feat/login 在 x 1232：main 的右边停在 1212
    const r = frame(W.agentdeckMain).rect;
    expect(r.x + r.w).toBe(1212);
    expect(c.state.guides).toContainEqual(expect.objectContaining({ kind: 'gap', axis: 'x', size: 20 }));
    c.moveFrameEnd();
    expect(c.state.guides).toEqual([]);
  });
});

describe('no overlapping windows on release (V3)', () => {
  it('a window dropped on another slides to the nearest free spot; the other does not move', () => {
    const claude = win('win-shop-claude').rect;
    c.moveWindowStart(id('win-shop-shell'));
    c.moveWindow(id('win-shop-shell'), -600, 0, pointerIn(W.shopCart));
    expect(intersects(win('win-shop-shell').rect, claude)).toBe(true); // 拖动中可以盖住
    c.moveWindowEnd(id('win-shop-shell'));
    expect(win('win-shop-claude').rect).toEqual(claude);
    expect(tooClose(win('win-shop-shell').rect, claude, 16)).toBe(false);
    expect(win('win-shop-shell').workspaceId).toBe(W.shopCart);
    expect(c.state.dialog).toBeNull();
  });

  it('when the frame has no room, the window goes outside and the frame grows; a frame in the way moves off', () => {
    const main = W.agentdeckMain;
    const login = W.agentdeckLogin;
    layout(
      [
        [main, { x: 0, y: 0, w: 800, h: 300 }],
        [login, { x: -300, y: 0, w: 200, h: 300 }],
      ],
      [
        browser('a', main, { x: 16, y: 36, w: 368, h: 248 }),
        browser('b', main, { x: 400, y: 36, w: 368, h: 248 }),
        browser('c', login, { x: -284, y: 36, w: 168, h: 248 }),
      ],
    );
    c.resizeWindowStart(id('a'), 'e');
    c.resizeWindow(id('a'), 132, 0);
    c.resizeWindowEnd(id('a'));
    // 框里放不下 500 宽的 a：最近的空位在 b 左边隔 16，框往左长，挡路的 feat/login 往左挪，里面的窗口跟着
    expect(win('a').rect).toEqual({ x: -116, y: 36, w: 500, h: 248 });
    expect(win('b').rect).toEqual({ x: 400, y: 36, w: 368, h: 248 });
    expect(frame(main).rect.x).toBe(-132);
    expect(frame(login).rect.x).toBe(-352);
    expect(win('c').rect.x).toBe(-336);
  });

  it('a new window that would land on another goes to a free spot', async () => {
    const wid = await c.newTerminal({ agent: 'claude', workspaceId: W.shopCart, nextTo: id('win-shop-claude') });
    expectNoOverlaps(inFrame(W.shopCart).map((w) => w.rect));
    expect(win(wid!).workspaceId).toBe(W.shopCart);
  });

  it('a browser moved into another frame is placed clear of the windows there', () => {
    c.moveWindowStart(id('win-browser'));
    c.moveWindow(id('win-browser'), -500, 600, pointerIn(W.shopCart));
    c.moveWindowEnd(id('win-browser'));
    expect(win('win-browser').workspaceId).toBe(W.shopCart);
    expectNoOverlaps(inFrame(W.shopCart).map((w) => w.rect));
  });

  it('a maximized window (⌘⇧↩) is exempt: it may cover others and is not moved; others avoid its restored spot', () => {
    c.toggleMaximize(id('win-dev-server'));
    const big = win('win-dev-server').rect;
    expect(intersects(big, win('win-browser').rect)).toBe(true);
    c.moveWindowStart(id('win-dev-server'));
    c.moveWindow(id('win-dev-server'), 5, 5, pointerIn(W.agentdeckMain));
    c.moveWindowEnd(id('win-dev-server'));
    expect(win('win-dev-server').rect).toMatchObject({ x: big.x + 5, y: big.y + 5 });
    // 网页窗口只看 dev-server 还原后的位置，没盖住就不动
    const b = win('win-browser').rect;
    c.moveWindowStart(id('win-browser'));
    c.moveWindow(id('win-browser'), 2, 0, pointerIn(W.agentdeckMain));
    c.moveWindowEnd(id('win-browser'));
    expect(win('win-browser').rect.x).toBe(b.x + 2);
  });
});

describe('frames keep 20px apart (V3)', () => {
  it('a frame dragged into another stops at its edge, windows inside move with it', () => {
    const dev = win('win-dev-server').rect;
    c.moveFrameStart(W.agentdeckMain);
    c.moveFrame(W.agentdeckMain, 500, 0);
    c.moveFrame(W.agentdeckMain, 900, 30); // 指针跳过去也不会穿过
    c.moveFrameEnd();
    const main = frame(W.agentdeckMain).rect;
    const login = frame(W.agentdeckLogin).rect;
    expect(main.x + main.w).toBe(login.x - 20);
    expect(main.y).toBe(62);
    expect(win('win-dev-server').rect).toMatchObject({ x: dev.x + 12, y: dev.y + 30 });
  });

  it('a window dragged out to the edge grows the frame; on release the frame in the way moves off', () => {
    const login = frame(W.agentdeckLogin).rect;
    const loginClaude = win('win-login-claude').rect;
    c.moveWindowStart(id('win-browser'));
    c.moveWindow(id('win-browser'), 300, 0, pointerIn(W.agentdeckMain));
    expect(frame(W.agentdeckLogin).rect).toEqual(login); // 拖动中不挪别的框，指针进了它就是换框（W5）
    c.moveWindowEnd(id('win-browser'));
    const main = frame(W.agentdeckMain).rect;
    expect(main.x + main.w).toBe(648 + 300 + 520 + 16);
    const moved = frame(W.agentdeckLogin).rect;
    expect(moved.x).toBe(main.x + main.w + 20);
    expect(win('win-login-claude').rect.x - moved.x).toBe(loginClaude.x - login.x);
    expectNoOverlaps(c.state.frames.map((f) => f.rect));
  });

  it('resizing a frame into another pushes it away, and shrinking back returns it', () => {
    const login = frame(W.agentdeckLogin).rect;
    const codex = win('win-login-codex').rect;
    c.resizeFrameStart(W.agentdeckMain, 'e');
    c.resizeFrame(W.agentdeckMain, 300, 0);
    expect(frame(W.agentdeckLogin).rect.x).toBe(1500 + 20);
    expect(win('win-login-codex').rect.x).toBe(codex.x + 288);
    c.resizeFrame(W.agentdeckMain, 0, 0);
    expect(frame(W.agentdeckLogin).rect).toEqual(login);
    expect(win('win-login-codex').rect).toEqual(codex);
    c.resizeFrameEnd();
  });
});

describe('IS-54: overlapping frames no longer misjudge a drag as moving to the other workspace', () => {
  it('dragging a terminal inside the overlap keeps it in its workspace without the W5 dialog', () => {
    // 老布局：feat/login 盖住了 main 的右半边
    c.store.setState((s) => ({ frames: s.frames.map((f) => (f.workspaceId === W.agentdeckLogin ? { ...f, rect: { ...f.rect, x: 500 }, z: 1 } : f)) }));
    const dev = id('win-dev-server');
    c.moveWindowStart(dev);
    c.moveWindow(dev, 10, 5, { x: 560, y: 110 }); // 指针在两个框重叠的地方
    expect(c.state.dropTarget).toBeNull();
    c.moveWindowEnd(dev);
    expect(c.state.dialog).toBeNull();
    expect(win('win-dev-server').workspaceId).toBe(W.agentdeckMain);
    // 松手时框按规则重新算过，挡在上面的框被挪开了
    expectNoOverlaps(c.state.frames.map((f) => f.rect));
    // 指针真的出了自己的框、进了别的框，还是照 W5 问
    const login = frame(W.agentdeckLogin).rect;
    c.moveWindowStart(dev);
    c.moveWindow(dev, 700, 200, { x: login.x + login.w / 2, y: login.y + login.h / 2 });
    expect(c.state.dropTarget).toBe(W.agentdeckLogin);
    c.moveWindowEnd(dev);
    expect(c.state.dialog).toMatchObject({ kind: 'move-terminal', to: W.agentdeckLogin });
  });

  it('overlapping frames saved by an older version are pulled apart on start, windows go along', async () => {
    const saved = api.fakes.board.current()!;
    await api.board.save({
      ...saved,
      frames: saved.frames.map((f) => (f.workspaceId === W.agentdeckLogin ? { ...f, rect: { ...f.rect, x: 500 } } : f)),
      windows: saved.windows.map((w) => (w.workspaceId === W.agentdeckLogin ? { ...w, rect: { ...w.rect, x: w.rect.x - 732 } } : w)),
    });
    const again = makeController(api);
    await again.start();
    const frames = again.state.frames;
    expectNoOverlaps(frames.map((f) => f.rect));
    const main = frames.find((f) => f.workspaceId === W.agentdeckMain)!.rect;
    const login = frames.find((f) => f.workspaceId === W.agentdeckLogin)!.rect;
    expect(tooClose(main, login, 20)).toBe(false);
    const claude = again.windowById(id('win-login-claude'))!.rect;
    expect(claude.x - login.x).toBe(1264 - 1232);
    again.dispose();
  });

  it('frames that do not overlap are left exactly as saved', () => {
    expect(frame(W.agentdeckLogin).rect).toEqual({ x: 1232, y: 32, w: 1264, h: 516 });
    expect(frame(W.shopCart).rect).toEqual({ x: 32, y: 560, w: 1224, h: 476 });
  });
});
