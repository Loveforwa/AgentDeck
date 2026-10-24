// 拖动和改大小时的吸附和对齐线（MVP v2 · V3，DR-52）。
// 做法照 Figma / tldraw / Excalidraw：吸附距离按屏幕像素算（调用方传 6 / zoom），x、y 两个方向各自找最近的一个吸附点，
// 吸住后把和它一样近的都画出来。吸附对象：边对边、中线对中线、框的内边、标准间距、等间距、同宽同高（只在改大小时）。
// 只算位置，不管重叠；重叠在松手时由 avoid.ts 处理。

import type { Rect, Size } from '@agentdeck/contracts';
import type { ResizeEdge } from '@agentdeck/ui-window-shell';

/** 屏幕上这么近就吸住（像素，调用方除以缩放比例换成白板坐标）。 */
export const SNAP_PX = 6;

export type Axis = 'x' | 'y';

/** 一段间距：axis 为 x 时是 y = cross 上从 x = from 到 x = to 的横线。 */
export interface GapSegment {
  from: number;
  to: number;
  cross: number;
}

export type Guide =
  /** 对齐线：axis 为 x 时是 x = at 的竖线，从 y = from 画到 y = to。 */
  | { kind: 'align'; axis: Axis; at: number; from: number; to: number }
  /** 间距：每段画一条线，标上 size。 */
  | { kind: 'gap'; axis: Axis; size: number; segments: GapSegment[] }
  /** 同宽（axis x）或同高（axis y）：每个矩形旁边画一条线，标上 size。 */
  | { kind: 'size'; axis: Axis; size: number; rects: Rect[] };

export interface SnapOptions {
  /** 白板坐标里的吸附距离（SNAP_PX / zoom）。 */
  threshold: number;
  /** 标准间距：吸到离邻居这么远的位置。 */
  gap: number;
  /** 框的内边（窗口离框边留 FRAME_PAD 的那个区域）。散放的窗口、拖框时没有。 */
  area?: Rect | null;
}

export interface SnapResult {
  rect: Rect;
  guides: Guide[];
}

const EPS = 1e-6;

const lo = (r: Rect, a: Axis) => (a === 'x' ? r.x : r.y);
const len = (r: Rect, a: Axis) => (a === 'x' ? r.w : r.h);
const hi = (r: Rect, a: Axis) => lo(r, a) + len(r, a);
const mid = (r: Rect, a: Axis) => lo(r, a) + len(r, a) / 2;
const cross = (a: Axis): Axis => (a === 'x' ? 'y' : 'x');

/** 在另一个方向上有重叠（并排）。等间距和标准间距只看并排的邻居。 */
function sideBySide(a: Rect, b: Rect, axis: Axis): boolean {
  const o = cross(axis);
  return lo(a, o) < hi(b, o) - EPS && lo(b, o) < hi(a, o) - EPS;
}

interface Candidate {
  delta: number;
  guide(final: Rect): Guide;
}

function alignGuide(axis: Axis, at: number, final: Rect, others: readonly Rect[]): Guide {
  const o = cross(axis);
  const all = [final, ...others];
  return { kind: 'align', axis, at, from: Math.min(...all.map((r) => lo(r, o))), to: Math.max(...all.map((r) => hi(r, o))) };
}

/** pairs 里每一对是 [前, 后]（axis 方向上前一个在前）。 */
function gapGuide(axis: Axis, size: number, pairs: readonly (readonly [Rect, Rect])[]): Guide {
  const o = cross(axis);
  return {
    kind: 'gap',
    axis,
    size,
    segments: pairs.map(([a, b]) => {
      const top = Math.max(lo(a, o), lo(b, o));
      const bottom = Math.min(hi(a, o), hi(b, o));
      const c = top < bottom ? (top + bottom) / 2 : (mid(a, o) + mid(b, o)) / 2;
      return { from: hi(a, axis), to: lo(b, axis), cross: c };
    }),
  };
}

function sizeGuide(axis: Axis, final: Rect, targets: readonly Rect[]): Guide {
  const size = len(final, axis);
  return { kind: 'size', axis, size, rects: [final, ...targets.filter((t) => Math.abs(len(t, axis) - size) < EPS)] };
}

/** 拖动：一个方向上的所有候选。 */
function moveCandidates(r: Rect, axis: Axis, targets: readonly Rect[], opts: SnapOptions): Candidate[] {
  const out: Candidate[] = [];
  const edges = [lo(r, axis), hi(r, axis)];
  for (const t of targets) {
    for (const tv of [lo(t, axis), hi(t, axis)]) {
      for (const sv of edges) out.push({ delta: tv - sv, guide: (f) => alignGuide(axis, tv, f, [t]) });
    }
    const tc = mid(t, axis);
    out.push({ delta: tc - mid(r, axis), guide: (f) => alignGuide(axis, tc, f, [t]) });
  }
  const area = opts.area;
  if (area) {
    for (const tv of [lo(area, axis), hi(area, axis)]) {
      for (const sv of edges) out.push({ delta: tv - sv, guide: (f) => alignGuide(axis, tv, f, [area]) });
    }
  }
  const near = targets.filter((t) => sideBySide(t, r, axis));
  for (const t of near) {
    // 标准间距：在 t 后面或前面隔 gap
    out.push({ delta: hi(t, axis) + opts.gap - lo(r, axis), guide: (f) => gapGuide(axis, opts.gap, [[t, f]]) });
    out.push({ delta: lo(t, axis) - opts.gap - hi(r, axis), guide: (f) => gapGuide(axis, opts.gap, [[f, t]]) });
  }
  for (const a of near) {
    for (const b of near) {
      if (a === b || hi(a, axis) > lo(b, axis) + EPS) continue;
      // 放在 a 和 b 正中间
      const space = lo(b, axis) - hi(a, axis) - len(r, axis);
      if (space >= 0) {
        const half = space / 2;
        out.push({ delta: hi(a, axis) + half - lo(r, axis), guide: (f) => gapGuide(axis, half, [[a, f], [f, b]]) });
      }
      // 照 a、b 之间的间距再排一个（tldraw 的 gap snapping）
      const g = lo(b, axis) - hi(a, axis);
      if (g > EPS && sideBySide(a, b, axis)) {
        out.push({ delta: hi(b, axis) + g - lo(r, axis), guide: (f) => gapGuide(axis, g, [[a, b], [b, f]]) });
        out.push({ delta: lo(a, axis) - g - hi(r, axis), guide: (f) => gapGuide(axis, g, [[f, a], [a, b]]) });
      }
    }
  }
  return out;
}

/** 选出最近的那个（threshold 以内）；和它一样近的都留下来画线。 */
function pick(cands: readonly Candidate[], threshold: number): Candidate[] {
  let best: number | null = null;
  for (const c of cands) {
    if (Math.abs(c.delta) > threshold + EPS) continue;
    if (best === null || Math.abs(c.delta) < Math.abs(best) - EPS) best = c.delta;
  }
  if (best === null) return [];
  const b = best;
  return cands.filter((c) => Math.abs(c.delta - b) < EPS);
}

/** 同一根对齐线只画一次（合并起止），同样的间距线只画一次。 */
function dedupe(guides: readonly Guide[]): Guide[] {
  const out: Guide[] = [];
  const seen = new Set<string>();
  for (const g of guides) {
    if (g.kind === 'align') {
      const same = out.find((o): o is Extract<Guide, { kind: 'align' }> => o.kind === 'align' && o.axis === g.axis && Math.abs(o.at - g.at) < EPS);
      if (same) {
        same.from = Math.min(same.from, g.from);
        same.to = Math.max(same.to, g.to);
        continue;
      }
      out.push({ ...g });
      continue;
    }
    const key = JSON.stringify(g);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(g);
  }
  return out;
}

/** 拖动窗口或框：targets 是同一个框里别的窗口（拖框时是别的框）。 */
export function snapMove(r: Rect, targets: readonly Rect[], opts: SnapOptions): SnapResult {
  const xs = pick(moveCandidates(r, 'x', targets, opts), opts.threshold);
  const ys = pick(moveCandidates(r, 'y', targets, opts), opts.threshold);
  const rect = { ...r, x: r.x + (xs[0]?.delta ?? 0), y: r.y + (ys[0]?.delta ?? 0) };
  return { rect, guides: dedupe([...xs, ...ys].map((c) => c.guide(rect))) };
}

/** 改大小：只吸正在动的边；同宽同高也算。吸完不能小于 min。 */
export function snapResize(r: Rect, edge: ResizeEdge, targets: readonly Rect[], opts: SnapOptions & { min: Size }): SnapResult {
  let rect = { ...r };
  const chosen: Candidate[] = [];
  for (const axis of ['x', 'y'] as const) {
    const side = axis === 'x' ? (edge.includes('e') ? 'hi' : edge.includes('w') ? 'lo' : null) : edge.includes('s') ? 'hi' : edge.includes('n') ? 'lo' : null;
    if (!side) continue;
    const minLen = axis === 'x' ? opts.min.w : opts.min.h;
    const v = side === 'hi' ? hi(rect, axis) : lo(rect, axis);
    const cands: Candidate[] = [];
    for (const t of targets) {
      for (const tv of [lo(t, axis), hi(t, axis)]) cands.push({ delta: tv - v, guide: (f) => alignGuide(axis, tv, f, [t]) });
      // 同宽 / 同高
      const want = side === 'hi' ? lo(rect, axis) + len(t, axis) : hi(rect, axis) - len(t, axis);
      cands.push({ delta: want - v, guide: (f) => sizeGuide(axis, f, targets) });
      if (sideBySide(t, rect, axis)) {
        if (side === 'hi') cands.push({ delta: lo(t, axis) - opts.gap - v, guide: (f) => gapGuide(axis, opts.gap, [[f, t]]) });
        else cands.push({ delta: hi(t, axis) + opts.gap - v, guide: (f) => gapGuide(axis, opts.gap, [[t, f]]) });
      }
    }
    const area = opts.area;
    if (area) {
      const tv = side === 'hi' ? hi(area, axis) : lo(area, axis);
      cands.push({ delta: tv - v, guide: (f) => alignGuide(axis, tv, f, [area]) });
    }
    const ok = cands.filter((c) => (side === 'hi' ? len(rect, axis) + c.delta : len(rect, axis) - c.delta) >= minLen - EPS);
    const got = pick(ok, opts.threshold);
    const d = got[0]?.delta ?? 0;
    if (d !== 0) {
      rect =
        axis === 'x'
          ? side === 'hi'
            ? { ...rect, w: rect.w + d }
            : { ...rect, x: rect.x + d, w: rect.w - d }
          : side === 'hi'
            ? { ...rect, h: rect.h + d }
            : { ...rect, y: rect.y + d, h: rect.h - d };
    }
    chosen.push(...got);
  }
  return { rect, guides: dedupe(chosen.map((c) => c.guide(rect))) };
}
