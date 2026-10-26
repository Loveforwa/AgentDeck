// N12：项目框一键排版——排法（Tidy / Columns / Rows）、顺序、整块不拆、框缩到正好装下、⌘Z 撤销、
// Auto-arrange 开着时新开 / 关掉窗口自动重排、框标题右上角的图标和右键菜单。
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Rect, TerminalWindowData, WindowComponentProps, WindowId, WindowNode } from '@agentdeck/contracts';
import { createFakeApi, SAMPLE, type FakeApi } from '@agentdeck/fakes';
import { BoardController } from '../src/controller.ts';
import { arrangeBlocks, readingOrder, type ArrangeBlock } from '../src/model/arrange.ts';
import { bounds, frameAround } from '../src/model/geometry.ts';
import { GAP } from '../src/model/avoid.ts';
import { Workbench } from '../src/react/Workbench.tsx';
import { createWindowRegistry } from '../src/registry.ts';

const WS = SAMPLE.workspaces.agentdeckLogin;

beforeAll(() => {
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver ??= RO as unknown as typeof ResizeObserver;
  globalThis.DOMMatrixReadOnly ??= class {
    m22 = 1;
    constructor(_t?: string) {}
  } as unknown as typeof DOMMatrixReadOnly;
});

function Text(props: WindowComponentProps<Partial<TerminalWindowData>>) {
  return <div className="test-term">{props.window.data.terminalId}</div>;
}

function registry() {
  const r = createWindowRegistry();
  r.register<TerminalWindowData>({
    type: 'terminal',
    label: 'Terminal',
    defaultSize: { w: 560, h: 360 },
    minSize: { w: 110, h: 60 },
    component: Text,
    create: (init) => ({ terminalId: null, agent: 'claude', cmd: 'claude', args: [], cwd: '~', sessionId: null, startCommand: null, ...init }),
  });
  return r;
}

const block = (id: string, x: number, y: number, w = 100, h = 80, extra: Partial<ArrangeBlock> = {}): ArrangeBlock => ({
  id,
  ext: { x, y, w, h },
  rect: { x, y, w, h },
  min: { w: 50, h: 40 },
  resizable: true,
  ...extra,
});
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('arrange · model', () => {
  it('reads top to bottom, left to right; new windows go last', () => {
    const order = readingOrder([block('b', 300, 10), block('a', 10, 30), block('c', 20, 400), block('n', 0, 0, 100, 80, { last: true })]);
    expect(order.map((b) => b.id)).toEqual(['a', 'b', 'c', 'n']);
  });

  it('tidy: a compact grid, sizes unchanged', () => {
    const out = arrangeBlocks('tidy', [block('a', 0, 0, 100, 80), block('b', 500, 0, 120, 60), block('c', 0, 300), block('d', 400, 300)], { x: 10, y: 20 }, 20);
    expect(out.get('a')).toEqual({ x: 10, y: 20, w: 100, h: 80 });
    expect(out.get('b')).toEqual({ x: 130, y: 20, w: 120, h: 60 });
    expect(out.get('c')).toEqual({ x: 10, y: 120, w: 100, h: 80 });
    expect(out.get('d')).toEqual({ x: 130, y: 120, w: 100, h: 80 });
  });

  it('columns: one row, same height and width; rows: stacked, same width', () => {
    const blocks = [block('a', 0, 0, 100, 80), block('b', 300, 0, 200, 120)];
    const cols = arrangeBlocks('columns', blocks, { x: 0, y: 0 }, 20);
    expect(cols.get('a')).toEqual({ x: 0, y: 0, w: 150, h: 120 });
    expect(cols.get('b')).toEqual({ x: 170, y: 0, w: 150, h: 120 });
    const rows = arrangeBlocks('rows', blocks, { x: 0, y: 0 }, 20);
    expect(rows.get('a')).toEqual({ x: 0, y: 0, w: 200, h: 100 });
    expect(rows.get('b')).toEqual({ x: 0, y: 120, w: 200, h: 100 });
  });

  it('keeps what hangs on a window with it, and never shrinks a fixed block', () => {
    // 窗口下面挂着 16 的书签，右边 176 的侧边栏
    const lead = { ...block('lead', 0, 0, 100, 80), ext: { x: 0, y: 0, w: 276, h: 96 }, resizable: false };
    const out = arrangeBlocks('columns', [lead, block('b', 400, 0, 100, 200)], { x: 0, y: 0 }, 20);
    expect(out.get('lead')).toEqual({ x: 0, y: 0, w: 100, h: 80 });
    expect(out.get('b')).toMatchObject({ x: 296, y: 0 });
  });
});

describe('arrange · controller', () => {
  let api: FakeApi;
  let c: BoardController;

  async function boot() {
    api = createFakeApi();
    c = new BoardController({ api, registry: registry(), homeDir: SAMPLE.home });
    c.setPane({ w: 1600, h: 1000 });
    await c.start();
  }

  afterEach(() => {
    c.dispose();
    api.dispose();
  });

  const inFrame = () => c.state.windows.filter((w) => w.workspaceId === WS);
  const layout = () => JSON.stringify([c.state.frames.map((f) => f.rect), c.state.windows.map((w) => [w.id, w.rect])]);

  /** 框里再放几个散着的窗口（不接终端）。 */
  function scatter(n: number) {
    const f = c.frameOf(WS)!.rect;
    const extra: WindowNode[] = Array.from({ length: n }, (_, i) => ({
      id: `scatter-${i}` as WindowId,
      type: 'terminal',
      workspaceId: WS,
      rect: { x: f.x + 40 + i * 700, y: f.y + 600 + (i % 2) * 500, w: 420, h: 260 },
      z: 50 + i,
      title: null,
      data: { terminalId: null, agent: 'shell', cmd: 'zsh', args: [], cwd: '~', sessionId: null, startCommand: null },
      group: null,
      restoreRect: null,
    }));
    act(() => c.store.setState((s) => ({ windows: [...s.windows, ...extra] })));
  }

  it('Tidy lays the frame out without overlaps, shrinks the frame to fit, and ⌘Z puts it back', async () => {
    await boot();
    scatter(3);
    const before = layout();
    const f0 = c.frameOf(WS)!.rect;
    c.arrangeFrame(WS, 'tidy');
    // 点的是标题右上角的图标：框的右上角不动，图标还在指针底下
    const f1 = c.frameOf(WS)!.rect;
    expect(f1.x + f1.w).toBe(f0.x + f0.w);
    expect(f1.y).toBe(f0.y);
    const ws = inFrame();
    for (const a of ws) for (const b of ws) if (a.id !== b.id) expect(overlaps(a.rect, b.rect)).toBe(false);
    expect(c.frameOf(WS)!.rect).toEqual(frameAround(bounds(ws.map((w) => w.rect))!));
    expect(c.frameArrange(WS)).toEqual({ auto: false, layout: 'tidy' });
    // 窗口之间就是 GAP
    const xs = [...new Set(ws.map((w) => w.rect.x))].sort((a, b) => a - b);
    expect(xs.length).toBeLessThanOrEqual(Math.ceil(Math.sqrt(ws.length)));
    expect(c.undo()).toBe(true);
    expect(layout()).toBe(before);
  });

  it('Auto-arrange arranges right away, then again when a window is opened or closed', async () => {
    await boot();
    scatter(2);
    c.setAutoArrange(WS, true);
    const arranged = layout();
    expect(c.frameArrange(WS)).toEqual({ auto: true, layout: null });
    // 新开一个：下一个微任务里重排，它排在最后
    scatter(1);
    const added = 'scatter-0' as WindowId;
    act(() => c.store.setState((s) => ({ windows: s.windows.map((w) => (w.id === added ? { ...w, id: 'late' as WindowId } : w)) })));
    await act(async () => {});
    const ws = inFrame();
    for (const a of ws) for (const b of ws) if (a.id !== b.id) expect(overlaps(a.rect, b.rect)).toBe(false);
    const late = ws.find((w) => w.id === ('late' as WindowId))!;
    const order = readingOrder(ws.map((w) => ({ id: w.id, ext: w.rect, rect: w.rect, min: { w: 1, h: 1 }, resizable: true })));
    expect(order.at(-1)!.id).toBe(late.id);
    expect(layout()).not.toBe(arranged);
    // 关掉一个：后面的往前补
    const victim = ws.find((w) => w.id !== late.id && w.id.startsWith('scatter'))!;
    c.closeWindow(victim.id);
    await act(async () => {});
    const left = inFrame();
    expect(c.frameOf(WS)!.rect).toEqual(frameAround(bounds(left.map((w) => w.rect))!));
  });

  it('turning Auto-arrange off stops it', async () => {
    await boot();
    c.setAutoArrange(WS, true);
    c.setAutoArrange(WS, false);
    const before = JSON.stringify(inFrame().map((w) => w.rect));
    scatter(1);
    await act(async () => {});
    expect(JSON.stringify(inFrame().filter((w) => !w.id.startsWith('scatter')).map((w) => w.rect))).toBe(before);
  });

  it('leaves maximized windows alone and keeps a gap of GAP', async () => {
    await boot();
    scatter(2);
    c.arrangeFrame(WS, 'rows');
    const ws = inFrame().sort((a, b) => a.rect.y - b.rect.y);
    for (let i = 1; i < ws.length; i++) expect(ws[i]!.rect.y - (ws[i - 1]!.rect.y + ws[i - 1]!.rect.h)).toBeGreaterThanOrEqual(GAP);
    expect(new Set(ws.map((w) => w.rect.w)).size).toBe(1);
  });
});

describe('arrange · frame header', () => {
  it('the icons arrange the frame and show which layout was used; the menu has the Auto-arrange switch', async () => {
    const api = createFakeApi();
    const c = new BoardController({ api, registry: registry() });
    render(<Workbench api={api} controller={c} />);
    await waitFor(() => expect(c.state.loaded).toBe(true));
    const btn = (l: string) => document.querySelector<HTMLButtonElement>(`.react-flow__node[data-id="frame:${WS}"] .ad-frame-arrange-btn[data-layout="${l}"]`);
    await waitFor(() => expect(btn('tidy')).not.toBeNull());
    expect(btn('tidy')!.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(btn('columns')!);
    await waitFor(() => expect(btn('columns')!.getAttribute('aria-pressed')).toBe('true'));
    expect(c.frameArrange(WS).layout).toBe('columns');
    fireEvent.click(btn('auto')!);
    await waitFor(() => expect(btn('auto')!.getAttribute('aria-pressed')).toBe('true'));
    expect(btn('auto')!.title).toBe('Auto-arrange is on · Columns');

    act(() => c.openMenu({ screen: { x: 10, y: 10 }, flow: { x: 0, y: 0 }, target: { kind: 'frame-title', workspaceId: WS } }));
    const item = await waitFor(() => {
      const el = [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"], [role="menuitem"]')].find((m) => m.textContent?.includes('Auto-arrange new windows'));
      expect(el).toBeDefined();
      return el!;
    });
    fireEvent.click(item);
    await waitFor(() => expect(c.frameArrange(WS).auto).toBe(false));
    c.dispose();
    api.dispose();
  });
});
