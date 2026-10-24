// N6（IS-59，DR-53）：白板的平移和缩放手势。React Flow 的真实拖动在 jsdom 里测不了，这里测规则：
// 类名、给 React Flow 的参数、盖层把滚轮交给内容、窗口上的捏合缩放、空格平移什么时候拿什么时候不拿。

import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { WindowComponentProps, WindowId } from '@agentdeck/contracts';
import { createFakeApi } from '@agentdeck/fakes';
import { BoardController } from '../src/controller.ts';
import { Workbench } from '../src/react/Workbench.tsx';
import { createWindowRegistry } from '../src/registry.ts';
import {
  FLOW_GESTURES,
  WINDOW_NODE_CLASS,
  isZoomWheel,
  spaceBelongsTo,
  startsSpacePan,
  wheelZoomDelta,
  zoomAtPoint,
} from '../src/model/gestures.ts';
import { COVER_PASS_MS } from '../src/react/gestures.ts';
import css from '../src/canvas.css?raw';

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

afterEach(() => {
  vi.useRealTimers();
  delete (document as { elementFromPoint?: unknown }).elementFromPoint;
});

/** 终端：一个“屏幕”div（像 xterm 那样自己听 wheel）+ 一个 textarea。 */
function FakeTerminal(props: WindowComponentProps<{ terminalId: string | null }>) {
  return (
    <div className="xterm" data-testid={`screen ${props.window.id}`}>
      <textarea aria-label={`input ${props.window.id}`} />
    </div>
  );
}

function FakeBrowser(props: WindowComponentProps<{ url: string }>) {
  return <iframe title={`page ${props.window.id}`} />;
}

function setup() {
  const registry = createWindowRegistry();
  registry.register({
    type: 'terminal',
    label: 'Terminal',
    defaultSize: { w: 560, h: 360 },
    minSize: { w: 110, h: 60 },
    component: FakeTerminal,
    create: (init: Partial<{ terminalId: string | null }>) => ({ terminalId: null, ...init }),
  });
  registry.register({
    type: 'browser',
    label: 'Browser',
    defaultSize: { w: 560, h: 360 },
    minSize: { w: 110, h: 60 },
    component: FakeBrowser,
    create: (init: Partial<{ url: string }>) => ({ url: 'http://localhost:3000', ...init }),
  });
  const api = createFakeApi();
  const c = new BoardController({ api, registry });
  render(<Workbench api={api} controller={c} />);
  return { api, c };
}

function node(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`);
  if (!el) throw new Error(`no node ${id}`);
  return el;
}

function board(): HTMLElement {
  const el = document.querySelector<HTMLElement>('.ad-board');
  if (!el) throw new Error('no board');
  return el;
}

const CLAUDE = 'win-login-claude' as WindowId;
const BROWSER = 'win-browser' as WindowId;

describe('React Flow gesture props', () => {
  it('pans on two-finger scroll, zooms on pinch and ⌘ + wheel, pans on left / middle drag; Space is ours', () => {
    expect(FLOW_GESTURES).toEqual({
      panOnScroll: true,
      zoomOnScroll: false,
      zoomOnPinch: true,
      zoomActivationKeyCode: 'Meta',
      zoomOnDoubleClick: false,
      panOnDrag: [0, 1],
      panActivationKeyCode: null,
    });
    expect(WINDOW_NODE_CLASS.split(' ').sort()).toEqual(['nopan', 'nowheel']);
  });
});

describe('two-finger scroll over windows', () => {
  it('every window node and window body is nowheel, focused or not (IS-59)', async () => {
    const { c } = setup();
    await waitFor(() => expect(c.state.loaded).toBe(true));
    const check = () => {
      const nodes = [...document.querySelectorAll<HTMLElement>('.react-flow__node')].filter((n) => n.querySelector('.ad-window-node'));
      expect(nodes.length).toBe(c.state.windows.length);
      for (const n of nodes) {
        expect(n.classList.contains('nowheel')).toBe(true);
        expect(n.classList.contains('nopan')).toBe(true);
        expect(n.querySelector('.ad-window-content')?.classList.contains('nowheel')).toBe(true);
      }
    };
    check();
    act(() => c.focusWindow(CLAUDE));
    check();
    // 框不是窗口：在框里的空白处滚动照样平移白板
    const frame = document.querySelector<HTMLElement>('.react-flow__node[data-id^="frame:"]');
    expect(frame?.classList.contains('nowheel')).toBe(false);
  });

  it('a wheel on an unfocused terminal goes to the terminal, the board does not move, a click still only focuses', async () => {
    const { c } = setup();
    await waitFor(() => expect(c.state.loaded).toBe(true));
    const vp = c.state.viewport;
    const screenEl = node(CLAUDE).querySelector<HTMLElement>('.xterm')!;
    const cover = node(CLAUDE).querySelector<HTMLElement>('.ad-window-cover')!;
    expect(cover).toBeTruthy();
    document.elementFromPoint = vi.fn(() => screenEl);
    const got: WheelEvent[] = [];
    screenEl.addEventListener('wheel', (e) => got.push(e));
    fireEvent.wheel(cover, { deltaX: 0, deltaY: 42, deltaMode: 0, clientX: 300, clientY: 200 });
    expect(got).toHaveLength(1);
    expect(got[0]?.deltaY).toBe(42);
    expect(got[0]?.clientX).toBe(300);
    expect(c.state.viewport).toEqual(vp);
    // 盖层还在、照样接指针：第一下单击只聚焦
    expect(cover.style.pointerEvents).toBe('');
    fireEvent.click(cover);
    expect(c.state.focusedId).toBe(CLAUDE);
  });

  it('content that does not handle the wheel itself (no preventDefault) is scrolled by its nearest overflow box', async () => {
    const { c } = setup();
    await waitFor(() => expect(c.state.loaded).toBe(true));
    const content = node(CLAUDE).querySelector<HTMLElement>('.ad-window-content')!;
    const cover = content.querySelector<HTMLElement>('.ad-window-cover')!;
    const box = document.createElement('div');
    box.style.overflowY = 'auto';
    const line = document.createElement('p');
    box.append(line);
    content.prepend(box);
    let top = 0;
    Object.defineProperty(box, 'scrollHeight', { value: 1000 });
    Object.defineProperty(box, 'clientHeight', { value: 100 });
    Object.defineProperty(box, 'scrollTop', { get: () => top, set: (v: number) => (top = v) });
    document.elementFromPoint = vi.fn(() => line);
    fireEvent.wheel(cover, { deltaY: 40 });
    expect(top).toBe(40);
    fireEvent.wheel(cover, { deltaY: 2, deltaMode: 1 });
    expect(top).toBe(72);
    // 处理了的（像 xterm 那样 preventDefault）就不再滚
    line.addEventListener('wheel', (e) => e.preventDefault());
    fireEvent.wheel(cover, { deltaY: 40 });
    expect(top).toBe(72);
  });

  it('a wheel on a focused terminal scrolls it and leaves the board alone', async () => {
    const { c } = setup();
    await waitFor(() => expect(c.state.loaded).toBe(true));
    act(() => c.focusWindow(CLAUDE));
    const vp = c.state.viewport;
    const screenEl = node(CLAUDE).querySelector<HTMLElement>('.xterm')!;
    expect(node(CLAUDE).querySelector('.ad-window-cover')).toBeNull();
    const got: WheelEvent[] = [];
    screenEl.addEventListener('wheel', (e) => got.push(e));
    fireEvent.wheel(screenEl, { deltaY: 30 });
    expect(got).toHaveLength(1);
    expect(got[0]?.defaultPrevented).toBe(false);
    expect(c.state.viewport).toEqual(vp);
    // 对照：同样的滚动落在空白处就平移白板
    const pane = document.querySelector<HTMLElement>('.react-flow__pane')!;
    act(() => void fireEvent.wheel(pane, { deltaY: 30 }));
    expect(c.state.viewport.y).not.toBe(vp.y);
    expect(c.state.viewport.zoom).toBe(vp.zoom);
  });

  it('over an unfocused web page the cover steps aside for a moment so the scroll reaches the page', async () => {
    const { c } = setup();
    await waitFor(() => expect(c.state.loaded).toBe(true));
    const frame = node(BROWSER).querySelector('iframe')!;
    const cover = node(BROWSER).querySelector<HTMLElement>('.ad-window-cover')!;
    document.elementFromPoint = vi.fn(() => frame);
    vi.useFakeTimers();
    fireEvent.wheel(cover, { deltaY: 20 });
    expect(cover.style.pointerEvents).toBe('none');
    vi.advanceTimersByTime(COVER_PASS_MS - 50);
    expect(cover.style.pointerEvents).toBe('none');
    vi.advanceTimersByTime(100);
    expect(cover.style.pointerEvents).toBe('');
  });
});

describe('pinch and ⌘ + wheel over windows zoom the board', () => {
  it('zooms around the pointer; a plain wheel over the same window does not', async () => {
    const { c } = setup();
    await waitFor(() => expect(c.state.loaded).toBe(true));
    act(() => c.viewportChanged({ x: 0, y: 0, zoom: 1 }));
    const cover = node(CLAUDE).querySelector<HTMLElement>('.ad-window-cover')!;
    document.elementFromPoint = vi.fn(() => null);
    fireEvent.wheel(cover, { deltaY: 10 });
    expect(c.state.viewport).toEqual({ x: 0, y: 0, zoom: 1 });
    act(() => void fireEvent.wheel(cover, { deltaY: -100, ctrlKey: true, clientX: 200, clientY: 100 }));
    const vp = c.state.viewport;
    expect(vp.zoom).toBeGreaterThan(1);
    // 指针下的白板点不动
    expect((200 - vp.x) / vp.zoom).toBeCloseTo(200);
    expect((100 - vp.y) / vp.zoom).toBeCloseTo(100);
    // ⌘ + 滚轮，在聚焦的终端上也一样；终端收不到
    act(() => c.focusWindow(CLAUDE));
    const screenEl = node(CLAUDE).querySelector<HTMLElement>('.xterm')!;
    const got: WheelEvent[] = [];
    screenEl.addEventListener('wheel', (e) => got.push(e));
    act(() => void fireEvent.wheel(screenEl, { deltaY: 100, metaKey: true, clientX: 200, clientY: 100 }));
    expect(c.state.viewport.zoom).toBeLessThan(vp.zoom);
    expect(got).toHaveLength(0);
  });
});

describe('hold Space to pan', () => {
  const space = { code: 'Space', key: ' ' };

  it('on the board: takes Space, lets drags through windows and frames to the pane until released', async () => {
    const { c } = setup();
    await waitFor(() => expect(c.state.loaded).toBe(true));
    expect(board().classList.contains('ad-board--space-pan')).toBe(false);
    let notPrevented = true;
    act(() => {
      notPrevented = fireEvent.keyDown(document.body, space);
    });
    expect(notPrevented).toBe(false);
    expect(board().classList.contains('ad-board--space-pan')).toBe(true);
    act(() => void fireEvent.keyUp(document.body, space));
    expect(board().classList.contains('ad-board--space-pan')).toBe(false);
    // 按住时切走窗口也松开
    act(() => void fireEvent.keyDown(document.body, space));
    act(() => void fireEvent.blur(window));
    expect(board().classList.contains('ad-board--space-pan')).toBe(false);
    // CSS：按住时节点和里面的东西都不接指针
    const rule = /\.ad-board--space-pan \.react-flow__node \*\s*\{[^}]*pointer-events:\s*none !important/;
    expect(rule.test(css.replace(/\.ad-board--space-pan \.react-flow__node,\s*/g, ''))).toBe(true);
  });

  it('never steals Space while typing in a terminal or an input', async () => {
    const { c } = setup();
    await waitFor(() => expect(c.state.loaded).toBe(true));
    act(() => c.focusWindow(CLAUDE));
    const input = node(CLAUDE).querySelector('textarea')!;
    for (const init of [space, { ...space, shiftKey: true }, { ...space, ctrlKey: true }]) {
      let notPrevented = false;
      act(() => {
        notPrevented = fireEvent.keyDown(input, init);
      });
      expect(notPrevented).toBe(true);
      expect(board().classList.contains('ad-board--space-pan')).toBe(false);
      fireEvent.keyUp(input, init);
    }
  });
});

describe('gesture rules (pure)', () => {
  it('zoomAtPoint keeps the point under the pointer and clamps to 25%–200%', () => {
    const vp = { x: 40, y: -20, zoom: 0.8 };
    const next = zoomAtPoint(vp, { x: 300, y: 200 }, 1.2);
    expect((300 - next.x) / next.zoom).toBeCloseTo((300 - vp.x) / vp.zoom);
    expect((200 - next.y) / next.zoom).toBeCloseTo((200 - vp.y) / vp.zoom);
    expect(zoomAtPoint(vp, { x: 0, y: 0 }, 10).zoom).toBe(2);
    expect(zoomAtPoint(vp, { x: 0, y: 0 }, 0.01).zoom).toBe(0.25);
  });

  it('wheelZoomDelta matches React Flow: pixels × 0.002, lines × 0.05, Mac pinch × 10', () => {
    expect(wheelZoomDelta({ deltaY: 100, deltaMode: 0, ctrlKey: false }, true)).toBeCloseTo(-0.2);
    expect(wheelZoomDelta({ deltaY: -2, deltaMode: 1, ctrlKey: false }, false)).toBeCloseTo(0.1);
    expect(wheelZoomDelta({ deltaY: -10, deltaMode: 0, ctrlKey: true }, true)).toBeCloseTo(0.2);
    expect(wheelZoomDelta({ deltaY: -10, deltaMode: 0, ctrlKey: true }, false)).toBeCloseTo(0.02);
    expect(isZoomWheel({ ctrlKey: true, metaKey: false })).toBe(true);
    expect(isZoomWheel({ ctrlKey: false, metaKey: true })).toBe(true);
    expect(isZoomWheel({ ctrlKey: false, metaKey: false })).toBe(false);
  });

  it('Space belongs to editables, terminals, web pages, buttons, menus and dialogs', () => {
    const host = document.createElement('div');
    host.innerHTML = `
      <input id="i" /><textarea id="t"></textarea><select id="s"></select><button id="b"></button>
      <div contenteditable="true"><span id="ce"></span></div>
      <div class="xterm"><div id="x" tabindex="0"></div></div>
      <iframe id="f"></iframe>
      <div role="menu"><div id="m" role="menuitem" tabindex="0"></div></div>
      <div class="ad-dialog"><div id="d" tabindex="0"></div></div>
      <div class="nokey"><div id="nk"></div></div>
      <div id="plain"></div>`;
    document.body.append(host);
    const $ = (id: string) => host.querySelector(`#${id}`);
    for (const id of ['i', 't', 's', 'b', 'ce', 'x', 'f', 'm', 'd', 'nk']) expect(spaceBelongsTo($(id))).toBe(true);
    expect(spaceBelongsTo($('plain'))).toBe(false);
    expect(spaceBelongsTo(document.body)).toBe(false);
    const ev = { code: 'Space', key: ' ', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false };
    expect(startsSpacePan(ev, document.body)).toBe(true);
    expect(startsSpacePan(ev, $('x'))).toBe(false);
    expect(startsSpacePan({ ...ev, isComposing: true }, document.body)).toBe(false);
    expect(startsSpacePan({ ...ev, altKey: true }, document.body)).toBe(false);
    expect(startsSpacePan({ ...ev, code: 'KeyA', key: 'a' }, document.body)).toBe(false);
    host.remove();
  });
});
