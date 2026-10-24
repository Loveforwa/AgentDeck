// ⌘⇧] / ⌘⇧[（任务 S3，TC-05）：在白板上所有窗口（终端、网页……）之间按位置依次切换。
// 顺序：框按位置排（从上到下、同一行从左到右），每个框里的窗口也按位置排，散放的窗口排最后；首尾相接。
// 从聚焦窗口往后数，就是“先本框、再后面的框、最后散放的窗口”。

import type { FrameNode, Rect, WindowId, WindowNode } from '@agentdeck/contracts';

/**
 * 按阅读顺序排：从上到下分行，同一行从左到右。上边沿在当前行第一个的竖直中线以上的算同一行，
 * 免得手动拖过的窗口差几个像素就排乱。
 */
export function readingOrder<T>(items: readonly T[], rectOf: (item: T) => Rect): T[] {
  const byTop = [...items].sort((a, b) => rectOf(a).y - rectOf(b).y || rectOf(a).x - rectOf(b).x);
  const rows: T[][] = [];
  let rowEnd = -Infinity;
  for (const item of byTop) {
    const r = rectOf(item);
    const row = rows[rows.length - 1];
    if (row && r.y < rowEnd) row.push(item);
    else {
      rows.push([item]);
      rowEnd = r.y + r.h / 2;
    }
  }
  return rows.flatMap((row) => row.sort((a, b) => rectOf(a).x - rectOf(b).x));
}

/** 所有窗口的切换顺序。工作区没有框的窗口当散放的算。 */
export function windowOrder(windows: readonly WindowNode[], frames: readonly FrameNode[]): WindowId[] {
  const framed = new Set(frames.map((f) => f.workspaceId));
  const out: WindowId[] = [];
  for (const f of readingOrder(frames, (n) => n.rect)) {
    const inside = windows.filter((w) => w.workspaceId === f.workspaceId);
    out.push(...readingOrder(inside, (w) => w.rect).map((w) => w.id));
  }
  const loose = windows.filter((w) => !w.workspaceId || !framed.has(w.workspaceId));
  out.push(...readingOrder(loose, (w) => w.rect).map((w) => w.id));
  return out;
}

/**
 * 从 current 往后（step 1）或往前（step -1）的下一个窗口。没有聚焦窗口时：往后是第一个，往前是最后一个；
 * 选中了框（没有聚焦窗口）时从这个框开始。只有一个窗口时返回它自己。没有窗口返回 null。
 */
export function adjacentWindow(
  order: readonly WindowId[],
  current: WindowId | null,
  step: 1 | -1,
  startAt?: WindowId | null,
): WindowId | null {
  const n = order.length;
  if (n === 0) return null;
  const i = current ? order.indexOf(current) : -1;
  if (i >= 0) return order[(i + step + n) % n] ?? null;
  if (startAt) {
    const j = order.indexOf(startAt);
    if (j >= 0) return step === 1 ? (order[j] ?? null) : (order[(j - 1 + n) % n] ?? null);
  }
  return (step === 1 ? order[0] : order[n - 1]) ?? null;
}
