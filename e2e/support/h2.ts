// 验收线 h2（IS-05 终端手感、IS-16、IS-157、TC-147、TC-148 补充）自己用的小工具。只给这几条用，别的测试不依赖它。
// - key-probe（fake-agent/key-probe.mjs）的日志：程序真正收到的字节、粘贴。
// - xterm：从窗口里 .ad-terminal__xterm 的 agentdeckSession（终端组件挂上的调试入口）读每格的字、宽度、颜色、样式；听响铃和 OSC 9。只读。
// - 系统剪贴板：测试会经 OSC 52 / ⌘C 写系统剪贴板，开始前存下原来的文字，结束时放回去。
// - 截图取色：解 Playwright 截图的 PNG（node:zlib），看某块区域里有没有某个颜色。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { expect, type Page } from '@playwright/test';
import type { Deck } from './deck.ts';
import { openTerminal } from './flows.ts';
import { fakeScript } from './g1.ts';

export interface ProbeEntry {
  kind: string;
  terminal: string | null;
  hex?: string;
  t?: number;
  text?: string;
  line?: string;
}

/** key-probe 的日志（按终端 id）。 */
export function probeLog(deck: Deck, terminalId: string): ProbeEntry[] {
  const dir = deck.sb.agentLogDir;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith('key-probe-'))
    .flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n'))
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ProbeEntry)
    .filter((e) => e.terminal === terminalId);
}

/** 程序收到的每一段字节（hex）。 */
export function probeChunks(deck: Deck, terminalId: string): { hex: string; t: number }[] {
  return probeLog(deck, terminalId)
    .filter((e) => e.kind === 'bytes')
    .map((e) => ({ hex: e.hex!, t: e.t! }));
}

export const hex = (s: string) => Buffer.from(s, 'utf8').toString('hex');

/** 散放开一个跑 key-probe 的自定义命令终端，等它画出提示。 */
export async function openProbe(deck: Deck, at: { x: number; y: number }, ...flags: string[]): Promise<{ windowId: string; terminalId: string }> {
  const t = await openTerminal(deck, null, 'custom', fakeScript('key-probe.mjs', ...flags), at);
  await deck.waitForPane(t.terminalId, /Key probe \(e2e\) ready/);
  return t;
}

export interface CellInfo {
  ch: string;
  width: number;
  /** 'default' | 'palette' | 'rgb' */
  fgMode: string;
  fg: number;
  bgMode: string;
  bg: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
}

/** xterm 屏幕上（视口里）每一行的字和每一格的样式。 */
export async function xtermCells(page: Page, windowId: string): Promise<{ lines: string[]; cells: CellInfo[][]; renderer: string } | null> {
  return page.evaluate((id) => {
    type Cell = {
      getChars(): string;
      getWidth(): number;
      isFgDefault(): boolean;
      isFgRGB(): boolean;
      isBgDefault(): boolean;
      isBgRGB(): boolean;
      getFgColor(): number;
      getBgColor(): number;
      isBold(): number;
      isItalic(): number;
      isUnderline(): number;
    };
    type Line = { translateToString(trim?: boolean): string; getCell(x: number): Cell | undefined };
    const el = document.querySelector(`.ad-window-node[data-window-id="${id}"] .ad-terminal__xterm`) as
      | (Element & { agentdeckSession?: { term: { cols: number; rows: number; buffer: { active: { viewportY: number; getLine(y: number): Line | undefined } } } } })
      | null;
    const term = el?.agentdeckSession?.term;
    if (!term) return null;
    const buf = term.buffer.active;
    const lines: string[] = [];
    const cells: CellInfo[][] = [];
    for (let y = 0; y < term.rows; y++) {
      const line = buf.getLine(buf.viewportY + y);
      lines.push(line?.translateToString(true) ?? '');
      const row: CellInfo[] = [];
      for (let x = 0; x < term.cols; x++) {
        const c = line?.getCell(x);
        if (!c) break;
        row.push({
          ch: c.getChars(),
          width: c.getWidth(),
          fgMode: c.isFgDefault() ? 'default' : c.isFgRGB() ? 'rgb' : 'palette',
          fg: c.getFgColor(),
          bgMode: c.isBgDefault() ? 'default' : c.isBgRGB() ? 'rgb' : 'palette',
          bg: c.getBgColor(),
          bold: c.isBold() !== 0,
          italic: c.isItalic() !== 0,
          underline: c.isUnderline() !== 0,
        });
      }
      cells.push(row);
    }
    // WebGL 画的时候屏幕里是 canvas；DOM 渲染时是 .xterm-rows 里的 span
    const renderer = el?.querySelector('.xterm-screen canvas') ? 'canvas' : 'dom';
    return { lines, cells, renderer };
  }, windowId);
}

/** 在页面里给这个窗口的 xterm 挂上记录：响铃（onBell）和 OSC 9 的内容。用 xtermEvents 读。 */
export async function watchXtermEvents(page: Page, windowId: string): Promise<void> {
  await page.evaluate((id) => {
    type Term = { onBell(cb: () => void): unknown; parser: { registerOscHandler(n: number, cb: (d: string) => boolean): unknown } };
    const el = document.querySelector(`.ad-window-node[data-window-id="${id}"] .ad-terminal__xterm`) as (Element & { agentdeckSession?: { term: Term } }) | null;
    const term = el?.agentdeckSession?.term;
    if (!term) throw new Error(`no xterm in ${id}`);
    const w = window as unknown as { __h2Events?: Record<string, string[]> };
    w.__h2Events ??= {};
    const list = (w.__h2Events[id] = [] as string[]);
    term.onBell(() => list.push('bell'));
    term.parser.registerOscHandler(9, (d) => {
      list.push(`osc9:${d}`);
      return false;
    });
  }, windowId);
}

export async function xtermEvents(page: Page, windowId: string): Promise<string[]> {
  return page.evaluate((id) => (window as unknown as { __h2Events?: Record<string, string[]> }).__h2Events?.[id] ?? [], windowId);
}

/** 终端画面上第 row 行、第 col 列那一格的中心（屏幕坐标）。行列从 tmux 的画面算，和 xterm 一格对一格。 */
export async function cellCenter(deck: Deck, windowId: string, terminalId: string, row: number, col: number): Promise<{ x: number; y: number; w: number; h: number }> {
  const [cols, rows] = deck.sb
    .tmux(['display-message', '-p', '-t', `=${terminalId}:`, '#{pane_width} #{pane_height}'])
    .stdout.trim()
    .split(' ')
    .map(Number) as [number, number];
  const box = await deck.windowEl(windowId).locator('.xterm-screen').boundingBox();
  if (!box) throw new Error('terminal screen not visible');
  const w = box.width / cols;
  const h = box.height / rows;
  return { x: box.x + (col + 0.5) * w, y: box.y + (row + 0.5) * h, w, h };
}

/**
 * 单击聚焦终端窗口，并等 xterm 的输入框真的拿到焦点（白板的 focusedId 先变，xterm 的 textarea 稍后才 focus；
 * 这之间按下的键落在白板页面上，谁也不收，测试里一按就丢：真人不会在点下去的几毫秒内打字）。
 */
export async function focusTerminal(deck: Deck, windowId: string): Promise<void> {
  await deck.focusWindow(windowId);
  await expect
    .poll(() =>
      deck.page.evaluate((id) => {
        const a = document.activeElement;
        return !!a && a.tagName === 'TEXTAREA' && !!a.closest(`.ad-window-node[data-window-id="${id}"] .ad-terminal__xterm`);
      }, windowId),
    )
    .toBe(true);
}

/** 系统剪贴板（主进程的 clipboard）。 */
export async function readClipboard(deck: Deck): Promise<string> {
  return deck.app.evaluate(({ clipboard }) => clipboard.readText());
}

export async function writeClipboard(deck: Deck, text: string): Promise<void> {
  await deck.app.evaluate(({ clipboard }, t) => clipboard.writeText(t), text);
}

/** 存下系统剪贴板里原来的文字，返回放回去的函数（只放回文字；原来是图片等别的格式时放回空）。 */
export async function saveClipboard(deck: Deck): Promise<() => Promise<void>> {
  const before = await readClipboard(deck);
  return async () => {
    await writeClipboard(deck, before).catch(() => undefined);
  };
}

/** tmux 窗格的几个格式变量。 */
export function paneVar(deck: Deck, terminalId: string, fmt: string): string {
  return deck.sb.tmux(['display-message', '-p', '-t', `=${terminalId}:`, fmt]).stdout.trim();
}

// ---- 截图取色 ----

export interface Rgba {
  width: number;
  height: number;
  data: Buffer;
}

/** 解 8 位 RGB / RGBA、不隔行的 PNG（Playwright 截图就是这种）。 */
export function decodePng(png: Buffer): Rgba {
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (pos < png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString('latin1', pos + 4, pos + 8);
    const body = png.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8 || body[12] !== 0) throw new Error('only 8-bit non-interlaced PNG');
      colorType = body[9]!;
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!bpp) throw new Error(`PNG color type ${colorType} not supported`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp]! : 0;
      const b = prev[i]!;
      const c = i >= bpp ? prev[i - bpp]! : 0;
      let v = line[i]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      out[(y * width + x) * 4] = line[x * bpp]!;
      out[(y * width + x) * 4 + 1] = line[x * bpp + 1]!;
      out[(y * width + x) * 4 + 2] = line[x * bpp + 2]!;
      out[(y * width + x) * 4 + 3] = bpp === 4 ? line[x * bpp + 3]! : 255;
    }
    prev = line;
  }
  return { width, height, data: out };
}

/** 截一块屏幕区域（CSS 像素），返回其中离 rgb 最近的那个像素的距离（0 = 有一模一样的颜色）和占比（距离 ≤ tol 的像素）。 */
export async function colorIn(page: Page, clip: { x: number; y: number; width: number; height: number }, rgb: number, tol = 24): Promise<{ best: number; share: number }> {
  const img = decodePng(await page.screenshot({ clip }));
  const r = (rgb >> 16) & 0xff;
  const g = (rgb >> 8) & 0xff;
  const b = rgb & 0xff;
  let best = Infinity;
  let near = 0;
  const n = img.width * img.height;
  for (let i = 0; i < n; i++) {
    const d = Math.max(Math.abs(img.data[i * 4]! - r), Math.abs(img.data[i * 4 + 1]! - g), Math.abs(img.data[i * 4 + 2]! - b));
    if (d < best) best = d;
    if (d <= tol) near++;
  }
  return { best, share: near / n };
}
