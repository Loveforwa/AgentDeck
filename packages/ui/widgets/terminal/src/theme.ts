// xterm 的颜色：只从 design-tokens 的 CSS 变量读（组件里不写颜色值）。
// 16 色调色板用 xterm.js 自带的；tokens 里还没有终端调色板，见 packages/tmux-host/CONTRACT_NOTES.md。

import type { ITheme } from '@xterm/xterm';

export interface TermColors {
  /** xterm 主题。 */
  theme: ITheme;
  /** 回答 OSC 10/11 用的 rgb:rrrr/gggg/bbbb。 */
  fg: string;
  bg: string;
  dark: boolean;
}

function cssVar(el: Element, name: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim();
}

/** 六位或三位的十六进制颜色 → [r, g, b]；认不出返回 null。 */
export function parseHex(value: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!m?.[1]) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

/** xterm 查询回答的格式：每个分量 16 位。 */
export function xtermRgb(value: string, fallback: [number, number, number]): string {
  const [r, g, b] = parseHex(value) ?? fallback;
  const c = (n: number) => (n * 257).toString(16).padStart(4, '0');
  return `rgb:${c(r)}/${c(g)}/${c(b)}`;
}

function luminance([r, g, b]: [number, number, number]): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

export function readColors(el: Element): TermColors {
  const bg = cssVar(el, '--surface');
  const fg = cssVar(el, '--ink');
  const muted = cssVar(el, '--muted');
  const hover = cssVar(el, '--hover');
  const bgRgb = parseHex(bg);
  const dark = bgRgb !== null && luminance(bgRgb) < 0.5;
  const theme: ITheme = {};
  if (bg) theme.background = bg;
  if (fg) {
    theme.foreground = fg;
    theme.cursor = fg;
  }
  if (bg) theme.cursorAccent = bg;
  if (hover) theme.selectionBackground = hover;
  if (muted) theme.scrollbarSliderBackground = muted;
  return { theme, fg: xtermRgb(fg, dark ? [237, 237, 234] : [26, 26, 26]), bg: xtermRgb(bg, dark ? [30, 30, 28] : [255, 255, 255]), dark };
}
