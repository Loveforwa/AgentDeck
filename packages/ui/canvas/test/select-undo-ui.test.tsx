// X10 在 Workbench 里：⌘Z / ⌘⇧Z 的焦点规则（白板上和终端里撤销白板，输入框、网页里不拿）、Shift + 拖空白处框选、
// ⌘ / Shift + 单击标题栏加减选择、选中的边框（只用 tokens）。React Flow 的真实拖动 jsdom 测不了，一起拖动见 select-undo.test.ts。

import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import type { WindowComponentProps, WindowId } from '@agentdeck/contracts';
import { createFakeApi } from '@agentdeck/fakes';
import { BoardController } from '../src/controller.ts';
import { matchShortcut, resolveShortcut, shouldHandle, textUndoTarget } from '../src/model/shortcuts.ts';
import { Workbench } from '../src/react/Workbench.tsx';
import { isEmptyBoardTarget, startsBoxSelect } from '../src/react/selection.tsx';
import { createWindowRegistry } from '../src/registry.ts';
import css from '../src/selection.css?raw';

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

const id = (s: string) => s as WindowId;
const key = (k: string, mods: Partial<KeyboardEventInit> = {}) => ({ key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods });

/** 像终端：xterm 的隐藏 textarea 在 .xterm 里。 */
function FakeTerm(props: WindowComponentProps<{ terminalId: string | null }>) {
  return (
    <div className="xterm">
      <textarea className="xterm-helper-textarea" aria-label={`term ${props.window.id}`} />
    </div>
  );
}

/** 像网页窗口：有地址栏。 */
function FakeBrowser(props: WindowComponentProps<{ url: string }>) {
  return <input aria-label={`address ${props.window.id}`} defaultValue={props.window.data.url} />;
}

function setup() {
  const registry = createWindowRegistry();
  registry.register({
    type: 'terminal',
    label: 'Terminal',
    defaultSize: { w: 560, h: 360 },
    minSize: { w: 110, h: 60 },
    component: FakeTerm,
    create: (init: Partial<{ terminalId: string | null }>) => ({ terminalId: null, ...init }),
  });
  registry.register({
    type: 'browser',
    label: 'Browser',
    defaultSize: { w: 520, h: 360 },
    minSize: { w: 110, h: 60 },
    component: FakeBrowser,
    create: (init: Partial<{ url: string }>) => ({ url: 'http://localhost/', ...init }),
  });
  const api = createFakeApi();
  const c = new BoardController({ api, registry });
  render(<Workbench api={api} controller={c} />);
  return { api, c };
}

const node = (wid: string) => document.querySelector<HTMLElement>(`.ad-window-node[data-window-id="${wid}"]`)!;
const title = (wid: string) => node(wid).querySelector<HTMLElement>('.ad-window-titlebar')!;

describe('⌘Z / ⌘⇧Z · key rules', () => {
  it('⌘Z is undo, ⌘⇧Z is redo; Ctrl+Z (suspend in the shell) and ⌥⌘Z are not the board’s', () => {
    expect(matchShortcut(key('z', { metaKey: true }))).toBe('undo');
    expect(matchShortcut(key('Z', { metaKey: true, shiftKey: true }))).toBe('redo');
    expect(matchShortcut(key('z', { ctrlKey: true }))).toBeNull();
    expect(matchShortcut(key('z', { metaKey: true, altKey: true }))).toBeNull();
  });

  it('handled on the board and while a terminal is focused; not in text fields, dialogs or web pages', () => {
    const z = key('z', { metaKey: true });
    expect(resolveShortcut(z, { windowFocused: false, inEditable: false })).toBe('undo');
    expect(resolveShortcut(z, { windowFocused: true, inEditable: false, inTextField: false })).toBe('undo');
    expect(resolveShortcut(z, { windowFocused: true, inEditable: false, inTextField: true })).toBeNull();
    expect(shouldHandle('redo', { windowFocused: false, inEditable: true })).toBe(false);
  });

  it('textUndoTarget: inputs (also inside windows), contenteditable and iframes yes; xterm and plain elements no', () => {
    document.body.innerHTML = `
      <div class="ad-window-content"><div class="xterm"><textarea id="xt"></textarea></div></div>
      <div class="ad-window-content"><input id="addr" /></div>
      <div contenteditable="true"><span id="ce">x</span></div>
      <iframe id="fr"></iframe>
      <div id="plain"></div>`;
    const el = (x: string) => document.getElementById(x);
    expect(textUndoTarget(el('xt'))).toBe(false);
    expect(textUndoTarget(el('addr'))).toBe(true);
    expect(textUndoTarget(el('ce'))).toBe(true);
    expect(textUndoTarget(el('fr'))).toBe(true);
    expect(textUndoTarget(el('plain'))).toBe(false);
    expect(textUndoTarget(null)).toBe(false);
    document.body.innerHTML = '';
  });
});

describe('Workbench · undo keys', () => {
  it('⌘Z on the board and in a terminal undoes the board; in a browser window’s address field it is left to the field', async () => {
    const { c } = setup();
    await waitFor(() => expect(c.state.loaded).toBe(true));
    act(() => c.renameWindow(id('win-dev-server'), 'one'));
    act(() => c.renameWindow(id('win-dev-server'), 'two'));
    act(() => c.renameWindow(id('win-dev-server'), 'three'));
    // 网页窗口的地址栏
    const address = await waitFor(() => node('win-browser').querySelector('input')!);
    const e1 = new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true });
    address.dispatchEvent(e1);
    expect(e1.defaultPrevented).toBe(false);
    expect(c.windowById(id('win-dev-server'))!.title).toBe('three');
    // 终端里（聚焦着）：给白板
    act(() => c.focusWindow(id('win-dev-server')));
    const term = node('win-dev-server').querySelector('textarea')!;
    const e2 = new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true });
    act(() => void term.dispatchEvent(e2));
    expect(e2.defaultPrevented).toBe(true);
    expect(c.windowById(id('win-dev-server'))!.title).toBe('two');
    // 白板上
    act(() => c.focusWindow(null));
    act(() => void fireEvent.keyDown(document.body, { key: 'z', metaKey: true }));
    expect(c.windowById(id('win-dev-server'))!.title).toBe('one');
    act(() => void fireEvent.keyDown(document.body, { key: 'Z', metaKey: true, shiftKey: true }));
    expect(c.windowById(id('win-dev-server'))!.title).toBe('two');
    // Ctrl+Z 是终端的（挂起），白板不管
    act(() => void fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true }));
    expect(c.windowById(id('win-dev-server'))!.title).toBe('two');
  });
});

describe('Workbench · selecting windows', () => {
  it('⌘-click on a title bar adds and removes; the selected window gets the outline attribute; a plain click elsewhere clears', async () => {
    const { c } = setup();
    await waitFor(() => expect(c.state.loaded).toBe(true));
    await waitFor(() => expect(node('win-browser')).toBeTruthy());
    act(() => c.focusWindow(id('win-dev-server')));
    fireEvent.pointerDown(title('win-browser'), { pointerId: 1, button: 0, metaKey: true });
    fireEvent.pointerUp(title('win-browser'), { pointerId: 1, button: 0, metaKey: true });
    // 聚焦的那个也算进来
    expect(c.state.selection).toEqual([id('win-dev-server'), id('win-browser')]);
    expect(node('win-browser').dataset.selected).toBeDefined();
    // ⌘-click 不抢聚焦
    expect(c.state.focusedId).toBe(id('win-dev-server'));
    fireEvent.pointerDown(title('win-browser'), { pointerId: 2, button: 0, shiftKey: true });
    fireEvent.pointerUp(title('win-browser'), { pointerId: 2, button: 0, shiftKey: true });
    expect(c.state.selection).toEqual([id('win-dev-server')]);
    act(() => c.setSelection([id('win-dev-server'), id('win-browser')]));
    // 不带修饰键按在没选中的窗口上：不再多选
    fireEvent.pointerDown(title('win-login-claude'), { pointerId: 3, button: 0 });
    fireEvent.pointerUp(title('win-login-claude'), { pointerId: 3, button: 0 });
    expect(c.state.selection).toEqual([]);
    expect(node('win-browser').dataset.selected).toBeUndefined();
  });

  it('Shift + drag on the empty board draws a box and selects what it touches; the click after it does not clear', async () => {
    const { c } = setup();
    await waitFor(() => expect(c.state.loaded).toBe(true));
    const pane = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('.react-flow__pane');
      if (!el) throw new Error('no pane');
      return el;
    });
    const zoom = c.state.viewport.zoom;
    const screen = (x: number, y: number) => ({ clientX: x * zoom + c.state.viewport.x, clientY: y * zoom + c.state.viewport.y });
    fireEvent.pointerDown(pane, { pointerId: 5, button: 0, shiftKey: true, ...screen(40, 80) });
    fireEvent.pointerMove(pane, { pointerId: 5, shiftKey: true, ...screen(700, 120) });
    expect(document.querySelector('[data-testid="selection-box"]')).toBeTruthy();
    fireEvent.pointerUp(pane, { pointerId: 5, shiftKey: true, ...screen(700, 120) });
    fireEvent.click(pane, { shiftKey: true });
    expect(c.state.selection).toEqual([id('win-dev-server'), id('win-browser')]);
    expect(document.querySelector('[data-testid="selection-box"]')).toBeNull();
    // 不按 Shift 单击空白处：取消
    fireEvent.click(pane);
    expect(c.state.selection).toEqual([]);
  });

  it('box select starts only with Shift + left button on empty board (pane or a frame’s empty area), not on windows or frame titles', () => {
    document.body.innerHTML = `
      <div class="react-flow__pane"><div id="pane-inner"></div>
        <div class="ad-frame"><div class="ad-frame-header" id="fh"></div><div id="fbody"></div><div class="ad-frame-resize" id="fr"></div></div>
        <div class="ad-window-node"><div id="win"></div></div>
      </div>`;
    const el = (x: string) => document.getElementById(x);
    expect(isEmptyBoardTarget(el('pane-inner'))).toBe(true);
    expect(isEmptyBoardTarget(el('fbody'))).toBe(true);
    expect(isEmptyBoardTarget(el('fh'))).toBe(false);
    expect(isEmptyBoardTarget(el('fr'))).toBe(false);
    expect(isEmptyBoardTarget(el('win'))).toBe(false);
    const ev = { button: 0, shiftKey: true, altKey: false, ctrlKey: false };
    expect(startsBoxSelect(ev, el('pane-inner'))).toBe(true);
    expect(startsBoxSelect({ ...ev, shiftKey: false }, el('pane-inner'))).toBe(false);
    expect(startsBoxSelect({ ...ev, button: 1 }, el('pane-inner'))).toBe(false);
    document.body.innerHTML = '';
  });

  it('selection outline and box use tokens only', () => {
    expect(css).toMatch(/\.ad-window-node\[data-selected\] > \.ad-window \{[^}]*outline: 2px solid var\(--guide\)/);
    expect(css).toMatch(/\.ad-selection-box \{[^}]*border: 1px solid var\(--guide\)/);
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  });
});
