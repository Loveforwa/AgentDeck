// 白板坐标的几何计算。白板坐标 = React Flow 的 flow 坐标，屏幕坐标 = 白板坐标 × zoom + 视口偏移。

import type { Rect, Size, Viewport } from '@agentdeck/contracts';
import type { ResizeEdge } from '@agentdeck/ui-window-shell';

export interface Point {
  x: number;
  y: number;
}

/** 框的标题栏高度。 */
export const FRAME_HEADER = 36;
/** 框里的窗口离框边至少这么远（需求「4 · 工作区框」：不能小于里面窗口占的范围再加 16px）。 */
export const FRAME_PAD = 16;
export const FRAME_MIN: Size = { w: 240, h: 140 };

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2;

export function containsPoint(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export function bounds(rects: readonly Rect[]): Rect | null {
  return rects.reduce<Rect | null>((acc, r) => (acc ? union(acc, r) : { ...r }), null);
}

export function center(r: Rect): Point {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

export function sameRect(a: Rect | null | undefined, b: Rect | null | undefined): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/** 框要装下这个窗口时的最小外框：窗口四周留 FRAME_PAD，上面再留标题栏。 */
export function frameAround(win: Rect): Rect {
  return {
    x: win.x - FRAME_PAD,
    y: win.y - FRAME_HEADER,
    w: win.w + FRAME_PAD * 2,
    h: win.h + FRAME_HEADER + FRAME_PAD,
  };
}

/** 框里放窗口的区域：四周留 FRAME_PAD，上面留标题栏。对齐线吸附的“框的内边”就是它的边。 */
export function innerArea(frame: Rect): Rect {
  return { x: frame.x + FRAME_PAD, y: frame.y + FRAME_HEADER, w: frame.w - FRAME_PAD * 2, h: frame.h - FRAME_HEADER - FRAME_PAD };
}

/** 框跟着窗口变大（只变大，不变小）。拖窗口到框边时用：窗口出不去，框跟着长。 */
export function growFrame(frame: Rect, win: Rect): Rect {
  return union(frame, frameAround(win));
}

/**
 * 拖框的边或角改大小。不能小于里面窗口占的范围（content：里面所有窗口的外接矩形，没有窗口为 null）再加边距，也不能小于 FRAME_MIN。
 */
export function resizeFrame(start: Rect, edge: ResizeEdge, dx: number, dy: number, content: Rect | null): Rect {
  const need = content ? frameAround(content) : null;
  let left = start.x;
  let top = start.y;
  let right = start.x + start.w;
  let bottom = start.y + start.h;
  if (edge.includes('w')) left = Math.min(left + dx, right - FRAME_MIN.w, need ? need.x : Infinity);
  if (edge.includes('e')) right = Math.max(right + dx, left + FRAME_MIN.w, need ? need.x + need.w : -Infinity);
  if (edge.includes('n')) top = Math.min(top + dy, bottom - FRAME_MIN.h, need ? need.y : Infinity);
  if (edge.includes('s')) bottom = Math.max(bottom + dy, top + FRAME_MIN.h, need ? need.y + need.h : -Infinity);
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** 视口里看得见的白板区域。 */
export function visibleRect(vp: Viewport, pane: Size): Rect {
  return { x: -vp.x / vp.zoom, y: -vp.y / vp.zoom, w: pane.w / vp.zoom, h: pane.h / vp.zoom };
}

export function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

/** 让 target 在视口里居中、完整显示的视口。maxZoom 默认 1（“Show all”最大 100%）。 */
export function fitViewport(target: Rect, pane: Size, opts: { padding?: number; maxZoom?: number } = {}): Viewport {
  const pad = opts.padding ?? 48;
  const maxZoom = opts.maxZoom ?? 1;
  const zoom = clampZoom(Math.min((pane.w - pad * 2) / target.w, (pane.h - pad * 2) / target.h, maxZoom));
  const c = center(target);
  return { x: pane.w / 2 - c.x * zoom, y: pane.h / 2 - c.y * zoom, zoom };
}

/** 以视口中心为不动点改缩放比例（⌘0、⌘= ⌘−、缩放菜单）。 */
export function zoomAroundCenter(vp: Viewport, pane: Size, zoom: number): Viewport {
  const z = clampZoom(zoom);
  const cx = (pane.w / 2 - vp.x) / vp.zoom;
  const cy = (pane.h / 2 - vp.y) / vp.zoom;
  return { x: pane.w / 2 - cx * z, y: pane.h / 2 - cy * z, zoom: z };
}

/** 屏幕坐标（相对白板左上角）→ 白板坐标。 */
export function toFlow(vp: Viewport, p: Point): Point {
  return { x: (p.x - vp.x) / vp.zoom, y: (p.y - vp.y) / vp.zoom };
}
