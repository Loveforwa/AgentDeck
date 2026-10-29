// CO3 · Send selection to ▸ 在白板这边的部分：子菜单列哪些终端、怎么分组排序（sendTargets），内容区右键菜单和标题栏菜单的项，
// 选了以后跳过去、聚焦、把文字交给目标窗口登记的句柄（只粘贴、去掉末尾换行），New terminal here…，
// 以及窗口内容发 CONTENT_MENU_EVENT 时 Workbench 打开 Copy · Paste · Send selection to ▸。

import { act, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalWindowData, WindowComponentProps, WindowId } from '@agentdeck/contracts';
import { createFakeApi, SAMPLE, type FakeApi } from '@agentdeck/fakes';
import type { MenuEntry, MenuItem } from '@agentdeck/ui-kit';
import { BoardController } from '../src/controller.ts';
import { sendTargets, trimForSend } from '../src/model/send.ts';
import { menuItems } from '../src/react/BoardMenu.tsx';
import { Workbench } from '../src/react/Workbench.tsx';
import {
  CONTENT_MENU_EVENT,
  createWindowContentRegistry,
  createWindowRegistry,
  type PasteOptions,
  type WindowContentHandle,
  type WindowContentRegistry,
} from '../src/registry.ts';

const W = SAMPLE.workspaces;
const id = (s: string) => s as WindowId;
const Nothing = (_p: WindowComponentProps<any>) => null; // eslint-disable-line @typescript-eslint/no-explicit-any
const SQL = "SELECT o.id\nFROM orders o\n-- only last week\nWHERE o.created_at > now() - interval '7 days';";

let api: FakeApi;
let c: BoardController;
let contents: WindowContentRegistry;
let notify: ReturnType<typeof vi.fn<(message: string) => void>>;

function terminalRegistry(component: (p: WindowComponentProps<any>) => unknown = Nothing) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const registry = createWindowRegistry();
  registry.register<TerminalWindowData>({
    type: 'terminal',
    label: 'Terminal',
    defaultSize: { w: 560, h: 360 },
    minSize: { w: 110, h: 60 },
    summaryBelow: { w: 320, h: 200 },
    component: component as never,
    create: (init) => ({ terminalId: null, agent: 'shell', cmd: 'zsh', args: [], cwd: '~', sessionId: null, startCommand: null, ...init }),
  });
  return registry;
}

/** 一个假的窗口内容句柄：记下粘贴。 */
function fakeHandle(selection = ''): WindowContentHandle & { pasted: { text: string; opts: PasteOptions | undefined }[] } {
  const pasted: { text: string; opts: PasteOptions | undefined }[] = [];
  return {
    pasted,
    selectionText: () => selection,
    paste: async (text, opts) => {
      pasted.push({ text, opts });
      return { ok: true };
    },
  };
}

beforeEach(async () => {
  api = createFakeApi();
  notify = vi.fn<(message: string) => void>();
  contents = createWindowContentRegistry();
  c = new BoardController({ api, registry: terminalRegistry(), contents, homeDir: SAMPLE.home, notify });
  c.setPane({ w: 1200, h: 800 });
  await c.start();
});

afterEach(() => {
  c.dispose();
  api.dispose();
  vi.useRealTimers();
});

const isItem = (e: MenuEntry | undefined): e is MenuItem => !!e && e.type !== 'separator' && e.type !== 'heading';
const menu = (kind: 'window' | 'window-content', wid: string) =>
  menuItems(c, { screen: { x: 0, y: 0 }, flow: { x: 0, y: 0 }, target: { kind, windowId: id(wid) } }, { terminal: true, browser: true });
const item = (entries: readonly MenuEntry[], itemId: string) => entries.find((e) => isItem(e) && e.id === itemId) as MenuItem | undefined;
/** 子菜单读成一行行文字，方便对照设计稿。 */
const describeMenu = (entries: readonly MenuEntry[]) =>
  entries.map((e) => (e.type === 'separator' ? '---' : e.type === 'heading' ? `# ${e.label}` : `${e.label}${e.hint ? ` (${e.hint})` : ''}${e.disabled ? ' [disabled]' : ''}`));

describe('sendTargets (CO3)', () => {
  it('lists other terminals grouped by frame, the source frame first, loose ones last; skips waiting and exited ones', async () => {
    const loose = await c.newTerminal({ agent: 'shell', workspaceId: null, at: { x: 3000, y: 3000 } });
    const list = sendTargets(c.state, id('win-dev-server'));
    expect(list.groups.map((g) => [g.workspaceId, g.targets.map((t) => t.windowId)])).toEqual([
      // 源终端的框（agentdeck · main）里没有别的终端，所以第一组是下一个框
      [W.agentdeckLogin, ['win-login-claude']], // codex 在等批准，不列
      [W.shopCart, ['win-shop-claude']], // zsh 已经退出（exit 2），不列
      [null, [loose]],
    ]);
    expect(list.skippedWaiting).toBe(1);
    expect(list.groups[0]!.targets[0]).toMatchObject({ name: 'claude', lamp: 'running', label: null });
  });

  it('the frame the source is in comes first; browsers and the source itself are never targets', async () => {
    const shell = await c.newTerminal({ agent: 'shell', workspaceId: W.agentdeckLogin });
    const list = sendTargets(c.state, id('win-login-claude'));
    expect(list.groups[0]).toMatchObject({ workspaceId: W.agentdeckLogin, targets: [{ windowId: shell, name: 'zsh' }] });
    const all = list.groups.flatMap((g) => g.targets.map((t) => t.windowId));
    expect(all).not.toContain('win-login-claude');
    expect(all).not.toContain('win-browser');
  });

  it('a renamed window shows its name as the grey label', () => {
    act(() => c.renameWindow(id('win-shop-claude'), 'cart fix'));
    const t = sendTargets(c.state, id('win-dev-server')).groups.flatMap((g) => g.targets).find((x) => x.windowId === 'win-shop-claude');
    expect(t?.label).toBe('cart fix');
  });

  it('trimForSend drops trailing newlines only', () => {
    expect(trimForSend(`${SQL}\n\n`)).toBe(SQL);
    expect(trimForSend('  indented\r\n')).toBe('  indented');
  });
});

describe('menus (CO3)', () => {
  it('terminal content: Copy ⌘C · Paste ⌘V · Send selection to ▸, Copy and Send greyed without a selection', () => {
    contents.register(id('win-shop-claude'), fakeHandle(''));
    const entries = menu('window-content', 'win-shop-claude');
    expect(describeMenu(entries)).toEqual(['Copy [disabled]', 'Paste', '---', 'Send selection to [disabled]']);
    expect(item(entries, 'copy')!.shortcut).toBe('⌘C');
    expect(item(entries, 'paste')!.shortcut).toBe('⌘V');
  });

  it('the submenu: frame headings, lamp + mono name, the skipped line, New terminal here… last', () => {
    contents.register(id('win-shop-claude'), fakeHandle(SQL));
    const send = item(menu('window-content', 'win-shop-claude'), 'send-selection')!;
    expect(send.disabled).toBe(false);
    expect(describeMenu(send.items!)).toEqual([
      '# AGENTDECK · MAIN',
      'zsh',
      '# AGENTDECK · FEAT/LOGIN',
      'claude',
      '---',
      'Waiting terminals are skipped [disabled]',
      '---',
      'New terminal here…',
    ]);
    const claude = item(send.items!, 'send-win-login-claude')!;
    expect(claude.mono).toBe(true);
    render(<>{claude.icon}</>);
    expect(document.querySelector('.ad-group-lamp.ad-group-lamp--running')).not.toBeNull();
    expect(item(send.items!, 'send-new')!.items!.map((e) => (isItem(e) ? e.label : '---'))).toContain('Shell');
  });

  it('the title bar menu has the same item right after Maximize, usable only with a selection', () => {
    contents.register(id('win-login-claude'), fakeHandle(''));
    const ids = menu('window', 'win-login-claude').map((e) => (isItem(e) ? e.id : e.type));
    expect(ids.slice(0, 3)).toEqual(['rename', 'maximize', 'send-selection']);
    expect(item(menu('window', 'win-login-claude'), 'send-selection')!.disabled).toBe(true);
    contents.register(id('win-login-claude'), fakeHandle('npm test'));
    expect(item(menu('window', 'win-login-claude'), 'send-selection')!.disabled).toBe(false);
    // 网页窗口没有这一项
    expect(item(menu('window', 'win-browser'), 'send-selection')).toBeUndefined();
  });
});

describe('sending (CO3, TC-147)', () => {
  it('jumps to and focuses the target, then pastes the text once, trailing newline dropped, bracketed paste required', async () => {
    const target = fakeHandle();
    contents.register(id('win-dev-server'), target);
    const item0 = item(item(menu('window-content', 'win-shop-claude'), 'send-selection')?.items ?? [], 'send-win-dev-server');
    expect(item0).toBeDefined();
    await expect(c.sendSelection(id('win-shop-claude'), id('win-dev-server'), `${SQL}\n`)).resolves.toBe(true);
    expect(target.pasted).toEqual([{ text: SQL, opts: { requireBracketed: true } }]);
    expect(c.state.focusedId).toBe('win-dev-server');
  });

  it('waits for a target that renders only after the jump (a collapsed group member, a window scrolled away)', async () => {
    const target = fakeHandle();
    const done = c.sendSelection(id('win-shop-claude'), id('win-login-claude'), 'git status');
    await new Promise((r) => setTimeout(r, 30));
    contents.register(id('win-login-claude'), target);
    await expect(done).resolves.toBe(true);
    expect(target.pasted.map((p) => p.text)).toEqual(['git status']);
  });

  it('a summary-size target is restored to its size first, so it can attach', async () => {
    const w = c.windowById(id('win-dev-server'))!;
    c.store.setState((s) => ({
      windows: s.windows.map((n) => (n.id === w.id ? { ...n, rect: { ...n.rect, w: 200, h: 120 }, restoreRect: w.rect } : n)),
    }));
    contents.register(id('win-dev-server'), fakeHandle());
    await c.sendSelection(id('win-shop-claude'), id('win-dev-server'), 'x');
    expect(c.windowById(id('win-dev-server'))!.rect).toMatchObject({ w: w.rect.w, h: w.rect.h });
  });

  it('says why when the target refuses (no bracketed paste) or never shows up', async () => {
    contents.register(id('win-dev-server'), { selectionText: () => '', paste: async () => ({ ok: false, reason: 'Nothing was sent: zsh would run each line as a command' }) });
    await expect(c.sendSelection(id('win-shop-claude'), id('win-dev-server'), SQL)).resolves.toBe(false);
    expect(notify).toHaveBeenCalledWith('Nothing was sent: zsh would run each line as a command');
    vi.useFakeTimers();
    const done = c.sendSelection(id('win-shop-claude'), id('win-login-claude'), SQL);
    await vi.advanceTimersByTimeAsync(3100);
    await expect(done).resolves.toBe(false);
    expect(notify).toHaveBeenLastCalledWith('Couldn’t send to claude: the window isn’t open');
  });

  it('an empty selection sends nothing', async () => {
    const target = fakeHandle();
    contents.register(id('win-dev-server'), target);
    await expect(c.sendSelection(id('win-shop-claude'), id('win-dev-server'), '\n')).resolves.toBe(false);
    expect(target.pasted).toEqual([]);
  });

  it('New terminal here… opens the picked terminal next to the source, in its frame, and pastes once the program is ready', async () => {
    const before = c.state.windows.length;
    const pending = c.sendSelectionToNew(id('win-shop-claude'), 'shell', SQL);
    await waitFor(() => expect(c.state.windows.length).toBe(before + 1));
    const created = c.state.windows.at(-1)!;
    expect(created.workspaceId).toBe(W.shopCart);
    expect(api.fakes.agents.started.at(-1)!.request).toMatchObject({ agent: 'shell', workspaceId: W.shopCart });
    const target = fakeHandle();
    contents.register(created.id, target);
    await expect(pending).resolves.toBe(created.id);
    expect(target.pasted).toEqual([{ text: SQL, opts: { requireBracketed: true, fresh: true } }]);
    expect(c.state.focusedId).toBe(created.id);
  });

  it('Paste reads the clipboard and pastes like ⌘V (multi-line allowed)', async () => {
    const target = fakeHandle();
    contents.register(id('win-dev-server'), target);
    Object.defineProperty(navigator, 'clipboard', { value: { readText: async () => 'a\nb', writeText: async () => {} }, configurable: true });
    await expect(c.pasteClipboard(id('win-dev-server'))).resolves.toBe(true);
    expect(target.pasted).toEqual([{ text: 'a\nb', opts: { requireBracketed: false } }]);
  });
});

describe('Workbench: the content menu (CO3)', () => {
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

  /** 像终端窗口一样：登记句柄，屏幕上右键时发 CONTENT_MENU_EVENT。 */
  function FakeScreen(props: WindowComponentProps<any>) { // eslint-disable-line @typescript-eslint/no-explicit-any
    useEffect(() => contentsForUi.register(props.window.id, fakeHandle(props.window.id === 'win-shop-claude' ? 'SELECT 1;' : '')), [props.window.id]);
    return (
      <div
        data-testid={`screen ${props.window.id}`}
        onContextMenu={(e) => {
          e.preventDefault();
          e.currentTarget.dispatchEvent(new CustomEvent(CONTENT_MENU_EVENT, { bubbles: true, detail: { clientX: e.clientX, clientY: e.clientY } }));
        }}
      />
    );
  }
  let contentsForUi: WindowContentRegistry;

  it('a right-click in a terminal screen opens Copy · Paste · Send selection to, and focuses that window', async () => {
    contentsForUi = createWindowContentRegistry();
    const uiApi = createFakeApi();
    const board = new BoardController({ api: uiApi, registry: terminalRegistry(FakeScreen), contents: contentsForUi });
    render(<Workbench api={uiApi} controller={board} />);
    await waitFor(() => expect(board.state.loaded).toBe(true));
    const screenEl = await waitFor(() => {
      const el = document.querySelector('[data-testid="screen win-shop-claude"]');
      if (!el) throw new Error('not rendered yet');
      return el;
    });
    act(() => {
      screenEl.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 }));
    });
    expect(board.state.menu?.target).toEqual({ kind: 'window-content', windowId: 'win-shop-claude' });
    expect(board.state.focusedId).toBe('win-shop-claude');
    const m = await screen.findByRole('menu', { name: 'Board' });
    expect([...m.querySelectorAll(':scope > .ad-menu-slot > [role="menuitem"] .ad-menu-label')].map((e) => e.textContent)).toEqual([
      'Copy',
      'Paste',
      'Send selection to',
    ]);
    board.dispose();
    uiApi.dispose();
  });
});
