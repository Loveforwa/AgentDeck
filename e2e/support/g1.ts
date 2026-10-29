// 验收线 g1（白板、窗口、面板：TC-16 17 18 21 22 25 26 29 31 32 33 37）自己用的小工具。只给这几条用例，别的测试不依赖它。
// - xterm：xterm.js 用 WebGL 画，DOM 里没有字；从窗口里 .xterm 元素的 React fiber 找到终端组件的 sessionRef（TerminalSession.term），
//   读选项、缓冲区（每格的字和宽度）。只读，不改产品代码。
// - 主进程：数 IPC 调用（包一层 ipcMain 的 invoke 处理函数）、触发应用菜单的 accelerator、记下发给界面的 IPC 消息。
// - 状态记录：在页面里听 status.changed，记下每个终端经过的状态。
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Frame, Page } from '@playwright/test';
import type { Deck, Rect } from './deck.ts';
import { E2E_DIR } from './sandbox.ts';

export interface XtermView {
  scrollback: number;
  unicode: string;
  cols: number;
  rows: number;
  /** 屏幕上每一行（translateToString(true)）。 */
  lines: string[];
  /** 屏幕上每一行每一格：[字, 宽度]。 */
  cells: [string, number][][];
  /** xterm 现在的主题色（跟着白板的深浅色）。 */
  theme: { background: string | null; foreground: string | null };
}

/** 读窗口里 xterm 的选项和屏幕内容。找不到（没挂上、摘要卡）时返回 null。 */
export async function xtermOf(page: Page, windowId: string): Promise<XtermView | null> {
  return page.evaluate((id) => {
    type Fiber = { memoizedState: unknown; return: Fiber | null };
    type Hook = { memoizedState: unknown; next: Hook | null };
    type Cell = { getChars(): string; getWidth(): number };
    type Line = { translateToString(trim?: boolean): string; getCell(x: number): Cell | undefined };
    type Term = {
      options: { scrollback: number; theme?: { background?: string; foreground?: string } };
      unicode: { activeVersion: string };
      cols: number;
      rows: number;
      buffer: { active: { viewportY: number; getLine(y: number): Line | undefined } };
    };
    const el = document.querySelector(`.ad-window-node[data-window-id="${id}"] .xterm`);
    if (!el) return null;
    let node: Element | null = el;
    let key: string | undefined;
    while (node && !(key = Object.keys(node).find((k) => k.startsWith('__reactFiber$')))) node = node.parentElement;
    if (!node || !key) return null;
    let f = (node as unknown as Record<string, Fiber>)[key] ?? null;
    let term: Term | null = null;
    for (let depth = 0; f && depth < 80 && !term; depth++, f = f.return) {
      let h = f.memoizedState as Hook | null;
      for (let i = 0; h && i < 80; i++, h = h.next) {
        const v = h.memoizedState as { current?: { term?: Term } } | null;
        if (v && typeof v === 'object' && 'current' in v && v.current && typeof v.current === 'object' && v.current.term) {
          term = v.current.term;
          break;
        }
      }
    }
    if (!term) return null;
    const buf = term.buffer.active;
    const lines: string[] = [];
    const cells: [string, number][][] = [];
    for (let y = 0; y < term.rows; y++) {
      const line = buf.getLine(buf.viewportY + y);
      lines.push(line?.translateToString(true) ?? '');
      const row: [string, number][] = [];
      for (let x = 0; x < term.cols; x++) {
        const c = line?.getCell(x);
        row.push([c?.getChars() ?? '', c?.getWidth() ?? 1]);
      }
      cells.push(row);
    }
    const theme = { background: term.options.theme?.background ?? null, foreground: term.options.theme?.foreground ?? null };
    return { scrollback: term.options.scrollback, unicode: term.unicode.activeVersion, cols: term.cols, rows: term.rows, lines, cells, theme };
  }, windowId);
}

/** 主进程里给 IPC invoke 包一层，记下每次调用的 service.method 和第一个参数。用 invokes() 读。 */
export async function recordInvokes(deck: Deck): Promise<void> {
  await deck.app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { __g1Calls?: { at: number; call: string; arg: unknown }[]; __g1Wrapped?: boolean };
    g.__g1Calls = [];
    if (g.__g1Wrapped) return;
    g.__g1Wrapped = true;
    // Electron 的 ipcMain 把 handle() 注册的函数放在 _invokeHandlers 里（内部字段）；包一层只记录，照常转给原来的处理函数
    const m = ipcMain as unknown as { _invokeHandlers: Map<string, (e: unknown, raw: unknown) => unknown> };
    const orig = m._invokeHandlers.get('agentdeck:invoke');
    if (!orig) throw new Error('no agentdeck:invoke handler');
    m._invokeHandlers.set('agentdeck:invoke', (e, raw) => {
      const r = raw as { service?: string; method?: string; args?: unknown[] };
      g.__g1Calls!.push({ at: Date.now(), call: `${r.service}.${r.method}`, arg: r.args?.[0] ?? null });
      return orig(e, raw);
    });
  });
}

export async function invokes(deck: Deck): Promise<{ at: number; call: string; arg: unknown }[]> {
  return deck.app.evaluate(() => (globalThis as unknown as { __g1Calls?: { at: number; call: string; arg: unknown }[] }).__g1Calls ?? []);
}

export async function clearInvokes(deck: Deck): Promise<void> {
  await deck.app.evaluate(() => {
    (globalThis as unknown as { __g1Calls?: unknown[] }).__g1Calls = [];
  });
}

/**
 * 触发应用菜单里 accelerator 为 accel（如 'CmdOrCtrl+B'）的那一项：和系统把一个没人处理的 ⌘ 组合键交给菜单时一样，
 * 调这一项的 click（菜单的回调不看参数）。真键盘 → 菜单这一段测试里按不出来：Playwright 的按键（CDP）浏览器端不处理，
 * webContents.sendInputEvent 直接送进顶层页面、不经过焦点所在的网页 iframe。
 */
export async function clickMenuAccelerator(deck: Deck, accel: string): Promise<void> {
  await deck.app.evaluate(({ Menu, BrowserWindow }, accel) => {
    const find = (items: Electron.MenuItem[]): Electron.MenuItem | null => {
      for (const i of items) {
        if (i.accelerator === accel) return i;
        const sub = i.submenu ? find(i.submenu.items) : null;
        if (sub) return sub;
      }
      return null;
    };
    const item = find(Menu.getApplicationMenu()?.items ?? []);
    if (!item) throw new Error(`no menu item with ${accel}`);
    const win = BrowserWindow.getAllWindows()[0];
    (item.click as unknown as (i: unknown, w: unknown, e: unknown) => void)(item, win, { triggeredByAccelerator: true });
  }, accel);
}

/**
 * 在网页窗口的 iframe 里按一个 ⌘ 组合键：CDP 会话直接连到这个 frame（跨源 iframe 是单独的渲染进程），按键送到它自己，
 * 和焦点在网页里时真键盘按下去一样由网页先收到。（page.keyboard 连的是顶层页面，按键进的是白板页面。）
 * key 是单个字母或数字。
 */
export async function pressInFrame(page: Page, frame: Frame, key: string): Promise<void> {
  const session = await page.context().newCDPSession(frame);
  const upper = key.toUpperCase();
  const code = /[0-9]/.test(key) ? `Digit${key}` : `Key${upper}`;
  const base = { modifiers: 4, key, code, windowsVirtualKeyCode: upper.charCodeAt(0), nativeVirtualKeyCode: upper.charCodeAt(0) };
  await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await session.detach();
}

/** 在主进程记下发给白板页面的 IPC 消息（webContents.send 的频道名），看菜单快捷键是不是从主进程过来的。 */
export async function recordSends(deck: Deck): Promise<void> {
  await deck.app.evaluate(({ webContents }) => {
    const g = globalThis as unknown as { __g1Sends?: { channel: string; arg: unknown }[] };
    g.__g1Sends = [];
    const wc = webContents.getAllWebContents().find((w) => w.getType() === 'window');
    if (!wc) throw new Error('no app window');
    const orig = wc.send.bind(wc);
    wc.send = (channel: string, ...args: unknown[]) => {
      g.__g1Sends!.push({ channel, arg: args[0] ?? null });
      orig(channel, ...args);
    };
  });
}

export async function sends(deck: Deck): Promise<{ channel: string; arg: unknown }[]> {
  return deck.app.evaluate(() => (globalThis as unknown as { __g1Sends?: { channel: string; arg: unknown }[] }).__g1Sends ?? []);
}

/** 页面里听 status.changed，记下每个终端经过的状态（去掉连续重复）。 */
export async function recordStatuses(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      agentdeck: { on(t: string, l: (e: { snapshot: { terminalId: string; status: string } }) => void): void };
      __g1Status?: Record<string, string[]>;
    };
    if (w.__g1Status) return;
    w.__g1Status = {};
    w.agentdeck.on('status.changed', (e) => {
      const list = (w.__g1Status![e.snapshot.terminalId] ??= []);
      if (list[list.length - 1] !== e.snapshot.status) list.push(e.snapshot.status);
    });
  });
}

export async function statusHistory(page: Page, terminalId: string): Promise<string[]> {
  return page.evaluate((id) => (window as unknown as { __g1Status?: Record<string, string[]> }).__g1Status?.[id] ?? [], terminalId);
}

/** 屏幕上一个元素的中心。 */
export async function centerOf(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`${selector} is not visible`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** 真的鼠标拖动：按下、分几步移到 to、（可选）停在那里做点事、松开。 */
export async function drag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  opts: { steps?: number; beforeUp?: () => Promise<void> } = {},
): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 3, from.y + 3, { steps: 2 });
  await page.mouse.move(to.x, to.y, { steps: opts.steps ?? 15 });
  if (opts.beforeUp) await opts.beforeUp();
  await page.mouse.up();
}

export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * 沙盒的 fakebin（PATH 最前面）里放一个假命令：以 name 的名字运行 e2e/fake-agent/<script>。
 * 要在 deck.launch() 之前放（AgentDeck 启动时检测 agent）。
 */
export function installFake(sb: { root: string }, name: string, script: string): string {
  const file = join(sb.root, 'fakebin', name);
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  writeFileSync(file, `#!/bin/sh\nexec ${q(process.execPath)} ${q(join(E2E_DIR, 'fake-agent', script))} "$@"\n`);
  chmodSync(file, 0o755);
  return file;
}

/** 跑 e2e/fake-agent 里一个脚本的命令行（给 Shell 终端打字用）。 */
export function fakeScript(script: string, ...args: string[]): string {
  return ['node', join(E2E_DIR, 'fake-agent', script), ...args].join(' ');
}
