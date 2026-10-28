// CO3 · Send selection to ▸ 在终端窗口这边的部分：右键出白板菜单的事件、选中的文字（xterm 的选中 / tmux 松手复制的那段）、
// 粘贴的路径（按 bracketed paste 加标记、不按回车、多行遇到没开 bracketed paste 的程序不贴）、等接上显示再贴、
// 拖动没选上时的一次性提示。TC-147 / TC-109：多行带 -- 注释的 SQL 原样到达、不执行。

import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalId, TerminalWindowData, WindowId, WindowNode } from '@agentdeck/contracts';
import { createFakeApi, type FakeApi } from '@agentdeck/fakes';
import { CONTENT_MENU_EVENT, windowContents, type ContentMenuDetail } from '@agentdeck/ui-canvas/registry';
import { ToastProvider } from '@agentdeck/ui-kit';
import { TerminalWindow, terminalWindowType } from '../src/index.ts';
import { OPTION_SELECT_HINT_KEY } from '../src/TerminalWindow.tsx';

type FakeXterm = {
  selection: string;
  pressKey(): void;
  modes: { bracketedPasteMode: boolean };
};
type ClipboardProvider = { writeText(sel: string, text: string): Promise<void> | void };

const T = 'term-db' as TerminalId;
const WID = 'w-db' as WindowId;
/** TC-147 / TC-109：agent 写的 SQL，带 -- 注释（send_to_terminal 把换行变空格后注释会吃掉 WHERE）。 */
const SQL = [
  'SELECT o.id, o.total, c.email',
  'FROM orders o',
  'JOIN customers c ON c.id = o.customer_id',
  '-- only last week',
  "WHERE o.created_at > now() - interval '7 days';",
].join('\n');

let api: FakeApi;
const xterm = () => (globalThis as { __lastXterm?: FakeXterm }).__lastXterm!;
const clipboard = () => (globalThis as { __lastClipboard?: ClipboardProvider }).__lastClipboard!;
const handle = () => windowContents.get(WID)!;
const inputs = () => api.fakes.terminals.get(T).inputs.join('');
const sleep = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

beforeEach(async () => {
  api = createFakeApi({ seed: false, silenceMs: 0 });
  window.agentdeck = api;
  localStorage.removeItem(OPTION_SELECT_HINT_KEY);
  const mod = await import('@xterm/xterm');
  const Orig = mod.Terminal as unknown as { prototype: { open(el: HTMLElement): void } };
  const open = Orig.prototype.open;
  vi.spyOn(Orig.prototype, 'open').mockImplementation(function (this: FakeXterm, el: HTMLElement) {
    (globalThis as { __lastXterm?: FakeXterm }).__lastXterm = this;
    open.call(this, el);
  });
  // 真的剪贴板在 jsdom 里没有
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => {}), readText: vi.fn(async () => '') }, configurable: true });
});

afterEach(() => {
  api.dispose();
  vi.restoreAllMocks();
});

function mount(opts: { visible?: boolean; cmd?: string; agent?: TerminalWindowData['agent']; toasts?: boolean } = {}) {
  api.fakes.terminals.createWith({ cmd: opts.cmd ?? '/bin/zsh', args: [], cwd: '/repo' }, { id: T, history: '$ ' });
  let setVisible: (v: boolean) => void = () => {};
  const data = terminalWindowType.create({ terminalId: T, agent: opts.agent ?? 'shell', cmd: opts.cmd ?? '/bin/zsh', cwd: '/repo' });
  function Host(): ReactNode {
    const [visible, setV] = useState(opts.visible ?? true);
    setVisible = setV;
    const node: WindowNode<TerminalWindowData> = { id: WID, type: 'terminal', workspaceId: null, rect: { x: 0, y: 0, w: 560, h: 360 }, z: 0, title: null, restoreRect: null, data };
    return (
      <TerminalWindow
        window={node}
        workspace={null}
        focused
        visible={visible}
        summary={false}
        contentSize={{ w: 560, h: 332 }}
        updateData={() => {}}
        setStatus={() => {}}
        requestFocus={() => {}}
        openWindow={() => {}}
        close={() => {}}
        toggleMaximize={() => {}}
        onCommand={() => () => {}}
      />
    );
  }
  render(opts.toasts ? <ToastProvider><Host /></ToastProvider> : <Host />);
  return { setVisible: (v: boolean) => act(() => setVisible(v)) };
}

async function live(bracketed: boolean) {
  await waitFor(() => expect(api.fakes.terminals.views(T)).toHaveLength(1));
  if (bracketed) act(() => api.fakes.terminals.feed(T, '\x1b[?2004h'));
  await waitFor(() => expect(xterm().modes.bracketedPasteMode).toBe(bracketed));
}

describe('right-click in the terminal screen (CO3)', () => {
  it('asks the board for its content menu at the pointer and keeps the browser menu away', async () => {
    mount();
    await live(false);
    const screenEl = document.querySelector('.ad-terminal__screen')!;
    const seen: ContentMenuDetail[] = [];
    document.addEventListener(CONTENT_MENU_EVENT, (e) => seen.push((e as CustomEvent<ContentMenuDetail>).detail), { once: true });
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 80 });
    screenEl.querySelector('.xterm')!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(seen).toEqual([{ clientX: 120, clientY: 80 }]);
  });

  it('⌃-click is the same contextmenu event (macOS), so it opens the same menu', async () => {
    mount();
    await live(false);
    let n = 0;
    document.addEventListener(CONTENT_MENU_EVENT, () => n++, { once: true });
    fireEvent.contextMenu(document.querySelector('.ad-terminal__xterm')!, { ctrlKey: true, button: 0 });
    expect(n).toBe(1);
  });
});

describe('the selection the board sees (CO3)', () => {
  it('xterm’s own selection (Option-drag) is the selection', async () => {
    mount();
    await live(false);
    expect(handle().selectionText()).toBe('');
    xterm().selection = 'SELECT 1';
    expect(handle().selectionText()).toBe('SELECT 1');
  });

  it('text tmux copied right after a mouse selection counts (copy-pipe-and-cancel clears the highlight); typing or a new click clears it', async () => {
    mount();
    await live(false);
    const el = document.querySelector('.ad-terminal__xterm')!;
    fireEvent.pointerDown(el, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(el, { button: 0, clientX: 90, clientY: 40 });
    await clipboard().writeText('c', SQL);
    expect(handle().selectionText()).toBe(SQL);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(SQL); // 照样进系统剪贴板
    act(() => xterm().pressKey());
    expect(handle().selectionText()).toBe('');
    fireEvent.pointerDown(el, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(el, { button: 0, clientX: 90, clientY: 40 });
    await clipboard().writeText('c', 'again');
    expect(handle().selectionText()).toBe('again');
    // 右键不清（右键就是要对它出菜单）；左键单击清
    fireEvent.pointerDown(el, { button: 2 });
    expect(handle().selectionText()).toBe('again');
    fireEvent.pointerDown(el, { button: 0, clientX: 10, clientY: 10 });
    expect(handle().selectionText()).toBe('');
  });

  it('an OSC 52 the program sends by itself (claude’s /copy) is not a selection', async () => {
    mount();
    await live(false);
    await clipboard().writeText('c', 'copied by the agent');
    expect(handle().selectionText()).toBe('');
  });
});

describe('pasting into the target (TC-147, TC-109)', () => {
  it('multi-line SQL with -- comments arrives unchanged as one bracketed paste, with no Enter', async () => {
    mount();
    await live(true);
    const before = inputs();
    await expect(handle().paste(SQL)).resolves.toEqual({ ok: true });
    const sent = inputs().slice(before.length);
    expect(sent).toBe(`\x1b[200~${SQL.replace(/\n/g, '\r')}\x1b[201~`);
    expect(sent.endsWith('\r')).toBe(false);
    expect(sent).toContain('-- only last week\rWHERE');
  });

  it('a program without bracketed paste would run each line: nothing is sent and the reason says so', async () => {
    mount();
    await live(false);
    const before = inputs();
    await expect(handle().paste(SQL)).resolves.toEqual({ ok: false, reason: 'Nothing was sent: zsh would run each line as a command' });
    expect(inputs()).toBe(before);
    // 一行的照贴；菜单的 Paste（requireBracketed: false）和 ⌘V 一样照贴
    await expect(handle().paste('SELECT 1;')).resolves.toEqual({ ok: true });
    expect(inputs().endsWith('SELECT 1;')).toBe(true);
    await expect(handle().paste('a\nb', { requireBracketed: false })).resolves.toEqual({ ok: true });
    expect(inputs().endsWith('a\rb')).toBe(true);
  });

  it('a target that is not attached yet (just jumped to) gets the paste once it attaches and settles', async () => {
    const h = mount({ visible: false });
    await waitFor(() => expect(handle()).toBeTruthy());
    const done = handle().paste(SQL);
    await sleep(100);
    expect(inputs()).toBe('');
    h.setVisible(true);
    await waitFor(() => expect(api.fakes.terminals.views(T)).toHaveLength(1));
    act(() => api.fakes.terminals.feed(T, '\x1b[?2004h'));
    await expect(done).resolves.toEqual({ ok: true });
    expect(inputs()).toContain(`\x1b[200~${SQL.replace(/\n/g, '\r')}\x1b[201~`);
  });
});

describe('“Hold Option to select text” (CO3)', () => {
  const drag = (el: Element) => {
    fireEvent.pointerDown(el, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(el, { button: 0, clientX: 120, clientY: 40 });
  };

  it('a drag that selected nothing (the program took the mouse) shows the hint once per user', async () => {
    mount({ agent: 'codex', cmd: 'codex', toasts: true });
    await live(false);
    const el = document.querySelector('.ad-terminal__xterm')!;
    drag(el);
    await sleep(800);
    // macOS 上是 Option（xterm 的 macOptionClickForcesSelection），别的系统是 Shift；jsdom 不是 Mac
    expect(document.body.textContent).toMatch(/Hold (Option|Shift) to select text/);
    expect(localStorage.getItem(OPTION_SELECT_HINT_KEY)).toBe('1');
  });

  it('no hint when tmux copied the drag (claude, shell), for a plain click, or after it was shown once', async () => {
    mount({ toasts: true });
    await live(false);
    const el = document.querySelector('.ad-terminal__xterm')!;
    drag(el);
    await clipboard().writeText('c', 'selected');
    fireEvent.pointerDown(el, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(el, { button: 0, clientX: 11, clientY: 10 });
    await sleep(800);
    expect(document.body.textContent).not.toMatch(/to select text/);
    localStorage.setItem(OPTION_SELECT_HINT_KEY, '1');
    drag(el);
    await sleep(800);
    expect(document.body.textContent).not.toMatch(/to select text/);
  });
});
