// 不重叠（MVP v2 · V3，DR-52）：
// - 窗口：只在松手时处理。盖住了别的窗口就挪到离松手位置最近、放得下的空位；框里放不下就放到框外，框跟着长。不推别的窗口。
// - 框：框之间至少 FRAME_GAP。拖框碰到别的框就停在边上（clampFrameMove）；框变大挤到别的框时，被挤的框整体往外挪（pushFrames）。
// Figma、tldraw、Excalidraw 都不管重叠；这里是白板上放的是要看内容的窗口，所以加了这一步。

import type { Rect } from '@agentdeck/contracts';
import { intersects } from './geometry.ts';

/** 框和框之间至少留这么多（需求画板 11 · V3）。 */
export const FRAME_GAP = 20;

const EPS = 1e-6;

export function inflate(r: Rect, d: number): Rect {
  return { x: r.x - d, y: r.y - d, w: r.w + d * 2, h: r.h + d * 2 };
}

export function containsRect(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x - EPS &&
    inner.y >= outer.y - EPS &&
    inner.x + inner.w <= outer.x + outer.w + EPS &&
    inner.y + inner.h <= outer.y + outer.h + EPS
  );
}

/** a 和 b 离得不到 gap（gap 为 0 时就是重叠）。正好隔 gap 不算。 */
export function tooClose(a: Rect, b: Rect, gap: number): boolean {
  return gap > 0 ? intersects(inflate(a, gap - EPS), b) : intersects(a, b);
}

export interface FreeSpotOptions {
  /** 挪开时和别的东西隔这么远。 */
  gap: number;
  /** 离得不到 margin 才算挡住（窗口 0：只有真的盖住才挪；框 FRAME_GAP）。 */
  margin?: number;
  /** 优先放在这个区域里（框的内边）；放不下才放到外面（框跟着长）。 */
  area?: Rect | null;
}

/**
 * 离 rect 最近、不挡住 obstacles 的位置（大小不变）。没挡住就原样返回。
 * 候选位置是“贴着某个障碍物隔 gap”或“贴着区域的边”的 x、y 的组合，所以一定有解（所有东西的右边总是空的）。
 */
export function findFreeSpot(rect: Rect, obstacles: readonly Rect[], opts: FreeSpotOptions): Rect {
  const margin = opts.margin ?? 0;
  if (!obstacles.some((o) => tooClose(o, rect, margin))) return rect;
  const xs = new Set<number>([rect.x]);
  const ys = new Set<number>([rect.y]);
  for (const o of obstacles) {
    xs.add(o.x + o.w + opts.gap);
    xs.add(o.x - rect.w - opts.gap);
    ys.add(o.y + o.h + opts.gap);
    ys.add(o.y - rect.h - opts.gap);
  }
  const area = opts.area;
  if (area) {
    xs.add(area.x);
    xs.add(area.x + area.w - rect.w);
    ys.add(area.y);
    ys.add(area.y + area.h - rect.h);
  }
  const keep = Math.max(opts.gap, margin);
  let inside: { r: Rect; d: number } | null = null;
  let outside: { r: Rect; d: number } | null = null;
  for (const x of xs) {
    for (const y of ys) {
      const r = { ...rect, x, y };
      const d = (x - rect.x) ** 2 + (y - rect.y) ** 2;
      if (area && containsRect(area, r)) {
        if (inside && inside.d <= d) continue;
      } else if (outside && outside.d <= d) continue;
      if (obstacles.some((o) => tooClose(o, r, keep))) continue;
      if (area && containsRect(area, r)) inside = { r, d };
      else outside = { r, d };
    }
  }
  if (inside) return inside.r;
  if (outside) return outside.r;
  // 理论上到不了：放到所有东西的右边
  const right = Math.max(...obstacles.map((o) => o.x + o.w));
  return { ...rect, x: right + opts.gap };
}

/**
 * 拖框：从上一个位置 prev 往 next 走，碰到别的框（隔 gap）就停在边上，可以沿着边滑（先走 x 再走 y）。
 * 开始时就已经挨得太近的框（老布局）只挡住重叠，不要求 gap；已经重叠的不挡。
 */
export function clampFrameMove(prev: Rect, next: Rect, obstacles: readonly Rect[], gap: number): Rect {
  const blockers = obstacles
    .filter((o) => !intersects(prev, o))
    .map((o) => ({ o, g: tooClose(prev, o, gap) ? 0 : gap }));
  const sweep = (from: Rect, axis: 'x' | 'y', to: number): number => {
    const start = axis === 'x' ? from.x : from.y;
    const size = axis === 'x' ? from.w : from.h;
    let v = to;
    for (const { o, g } of blockers) {
      // 另一个方向上会碰到（隔 g 以内）才挡
      const across = axis === 'x' ? from.y < o.y + o.h + g && o.y - g < from.y + from.h : from.x < o.x + o.w + g && o.x - g < from.x + from.w;
      if (!across) continue;
      const oLo = axis === 'x' ? o.x : o.y;
      const oHi = oLo + (axis === 'x' ? o.w : o.h);
      if (to > start && oLo - g >= start + size - EPS) v = Math.min(v, oLo - g - size);
      if (to < start && oHi + g <= start + EPS) v = Math.max(v, oHi + g);
    }
    return v;
  };
  // 先 x 后 y 和先 y 后 x 都走一遍，取离 next 近的（斜着拖过别的框的角时不会卡住）
  const x1 = sweep(prev, 'x', next.x);
  const a = { ...prev, x: x1, y: sweep({ ...prev, x: x1 }, 'y', next.y) };
  const y2 = sweep(prev, 'y', next.y);
  const b = { ...prev, y: y2, x: sweep({ ...prev, y: y2 }, 'x', next.x) };
  const dist = (r: Rect) => (r.x - next.x) ** 2 + (r.y - next.y) ** 2;
  return dist(b) < dist(a) ? b : a;
}

/** 把 q 从 p 旁边推开（隔 gap）：只往 q 所在的那一侧推，选挪得最少的方向。 */
export function pushOut(p: Rect, q: Rect, gap: number): Rect {
  const pcx = p.x + p.w / 2;
  const pcy = p.y + p.h / 2;
  const qcx = q.x + q.w / 2;
  const qcy = q.y + q.h / 2;
  const moves: { dx: number; dy: number }[] = [];
  if (qcx >= pcx) moves.push({ dx: p.x + p.w + gap - q.x, dy: 0 });
  if (qcx <= pcx) moves.push({ dx: p.x - gap - (q.x + q.w), dy: 0 });
  if (qcy >= pcy) moves.push({ dx: 0, dy: p.y + p.h + gap - q.y });
  if (qcy <= pcy) moves.push({ dx: 0, dy: p.y - gap - (q.y + q.h) });
  const best = moves.reduce((a, b) => (Math.abs(b.dx) + Math.abs(b.dy) < Math.abs(a.dx) + Math.abs(a.dy) ? b : a));
  return { ...q, x: q.x + best.dx, y: q.y + best.dy };
}

/**
 * 一个框从 before 变成 after（长大、新放上来）：被它挤到的框往外挪，挪过去又挤到别的框就接着挪。
 * 原来就挨得太近（但没重叠）的框，这次没有更近就不动；真的重叠了一定挪开。changed 自己不动。
 * 返回挪过的框的新位置。
 */
export function pushFrames<K>(others: ReadonlyMap<K, Rect>, changed: { id: K; before: Rect | null; after: Rect }, gap: number): Map<K, Rect> {
  const pos = new Map(others);
  pos.delete(changed.id);
  const moved = new Map<K, Rect>();
  const queue: { id: K; before: Rect | null; after: Rect }[] = [changed];
  let guard = 0;
  while (queue.length > 0 && guard++ < 500) {
    const p = queue.shift()!;
    for (const [id, q] of pos) {
      if (id === p.id) continue;
      if (!tooClose(p.after, q, gap)) continue;
      const wasClose = p.before ? tooClose(p.before, q, gap) : false;
      if (wasClose && !intersects(p.after, q)) continue;
      const next = pushOut(p.after, q, gap);
      pos.set(id, next);
      moved.set(id, next);
      queue.push({ id, before: q, after: next });
    }
  }
  return moved;
}

/** 老布局里重叠的框分开（启动时用）：按顺序，前面的不动，后面的挪开。返回挪过的框的新位置。 */
export function separateFrames<K>(frames: ReadonlyMap<K, Rect>, gap: number): Map<K, Rect> {
  const pos = new Map(frames);
  const moved = new Map<K, Rect>();
  for (let pass = 0; pass < 4; pass++) {
    let any = false;
    for (const [id, r] of pos) {
      const pushed = pushFrames(pos, { id, before: r, after: r }, gap);
      for (const [k, v] of pushed) {
        pos.set(k, v);
        moved.set(k, v);
        any = true;
      }
    }
    if (!any) break;
  }
  return moved;
}
