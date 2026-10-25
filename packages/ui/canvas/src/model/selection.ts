// X10：多选窗口。框选（Shift + 左键拖空白处）、⌘ / Shift + 单击标题栏加减，选中的窗口一起拖动。纯函数。

import type { Rect, WindowId, WindowNode, WorkspaceId } from '@agentdeck/contracts';
import { bounds, intersects, type Point } from './geometry.ts';

/** 两个点（白板坐标）围出来的矩形，哪个方向拖都行。 */
export function boxFrom(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

/**
 * 框选碰到的窗口（碰到一点就算，和访达、Figma 一样）。skip：不能选的（收起的子终端）。按白板里的先后排。
 * 宽和高都为 0（只是按了一下）时什么都不选。
 */
export function windowsInBox(box: Rect, windows: readonly WindowNode[], skip: ReadonlySet<WindowId> = new Set()): WindowId[] {
  if (box.w <= 0 && box.h <= 0) return [];
  return windows.filter((w) => !skip.has(w.id) && intersects(box, w.rect)).map((w) => w.id);
}

/** 框选的结果：additive（按着 ⌘）时加在原来的选择上，否则换成框到的。 */
export function boxSelection(base: readonly WindowId[], hit: readonly WindowId[], additive: boolean): WindowId[] {
  if (!additive) return [...hit];
  const out = [...base];
  for (const id of hit) if (!out.includes(id)) out.push(id);
  return out;
}

/**
 * ⌘ / Shift + 单击标题栏：选上或去掉。原来什么都没选、有一个聚焦的别的窗口时，把聚焦的也算进来
 * （聚焦的边框看起来就像选中了一个，点第二个应该是“两个”）。
 */
export function toggleSelection(sel: readonly WindowId[], id: WindowId, focused: WindowId | null): WindowId[] {
  if (sel.includes(id)) return sel.filter((x) => x !== id);
  if (sel.length === 0 && focused && focused !== id) return [focused, id];
  return [...sel, id];
}

/** 选中的窗口按所在的框分开（散放的是 null）：松手避让时每个框里的那一批算一块。 */
export function byWorkspace(windows: readonly WindowNode[], ids: readonly WindowId[]): Map<WorkspaceId | null, WindowNode[]> {
  const set = new Set(ids);
  const out = new Map<WorkspaceId | null, WindowNode[]>();
  for (const w of windows) {
    if (!set.has(w.id)) continue;
    const list = out.get(w.workspaceId) ?? [];
    list.push(w);
    out.set(w.workspaceId, list);
  }
  return out;
}

/** 一起拖动时吸附看的那一块：所有选中窗口的外接矩形。 */
export function groupBounds(rects: readonly Rect[]): Rect | null {
  return bounds(rects);
}

export function translate(r: Rect, dx: number, dy: number): Rect {
  return { ...r, x: r.x + dx, y: r.y + dy };
}
