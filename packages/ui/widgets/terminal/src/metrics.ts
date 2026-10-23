// 终端的字体和内边距，以及由像素大小算行列数。
// termSize 给白板新开终端时用（agents.start 的 size），窗口 attach 后用 xterm 实际量到的格子大小再校正。

import type { Size, TermSize } from '@agentdeck/contracts';

export const FONT_SIZE = 13;
export const LINE_HEIGHT = 1;
/** 内容区四周的留白（px），和 terminal.css 的 .ad-terminal__screen padding 一致。 */
export const PAD_X = 8;
export const PAD_Y = 4;
/** JetBrains Mono 13px 的格子：宽 0.6em，高约 1.3em。和白板的粗估（canvas estimateTermSize）一致。 */
export const CELL_W = 7.8;
export const CELL_H = 17;

export function termSizeFor(content: Size, cell: { w: number; h: number } = { w: CELL_W, h: CELL_H }): TermSize {
  return {
    cols: Math.max(2, Math.floor((content.w - PAD_X * 2) / cell.w)),
    rows: Math.max(1, Math.floor((content.h - PAD_Y * 2) / cell.h)),
  };
}
