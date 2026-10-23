// 窗口外框的几何计算：拖标题栏移动、拖边和角改大小。纯函数，白板和测试都用。

import type { Rect, Size } from '@agentdeck/contracts';

/** 可以拖的边和角。 */
export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export const RESIZE_EDGES: readonly ResizeEdge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

export function moveRect(rect: Rect, dx: number, dy: number): Rect {
  return { ...rect, x: rect.x + dx, y: rect.y + dy };
}

/**
 * 从拖动开始时的 rect 算出新的 rect。dx、dy 是从开始拖到现在的总位移（白板坐标）。
 * 拖左边或上边时，对边不动；小于 min 时停在 min。
 */
export function resizeRect(start: Rect, edge: ResizeEdge, dx: number, dy: number, min: Size): Rect {
  let { x, y, w, h } = start;
  if (edge.includes('e')) w = Math.max(min.w, start.w + dx);
  if (edge.includes('s')) h = Math.max(min.h, start.h + dy);
  if (edge.includes('w')) {
    w = Math.max(min.w, start.w - dx);
    x = start.x + start.w - w;
  }
  if (edge.includes('n')) {
    h = Math.max(min.h, start.h - dy);
    y = start.y + start.h - h;
  }
  return { x, y, w, h };
}
