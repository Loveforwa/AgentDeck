// 项目框一键排版（MVP v3 · N12，画板 15）：把一个框里的窗口排整齐。纯函数，控制器把框里的窗口变成“块”交进来。
//
// 一块 = 一个窗口连同贴着它的东西（底边的书签、Usage 条、窗口组的侧边栏和停靠的子终端、后台 agent 面板），
// 整块一起挪，不拆开；ext 是整块占的地方，pad 是窗口到整块四边的距离（挪动、改大小时保持不变）。
// - tidy：紧凑网格，窗口大小不变。⌈√n⌉ 列，每列宽取这一列最宽的块，每行高取这一行最高的块。
// - columns：并排，一样高（取最高的窗口），一样宽（取平均宽度，不小于最小宽度）；一行最多 COLUMNS_PER_ROW 个，多了换行。
// - rows：上下叠，一样宽（取最宽的窗口），一样高（取平均高度，不小于最小高度）。
// 顺序按原来的位置：先上后下、先左后右（上下差不到 ROW_TOLERANCE 算同一行）；last 里的（新开的）排在最后。
// 带着停靠的子终端的 lead（resizable 为 false）只挪不改大小。

import type { FrameLayout, Rect, Size } from '@agentdeck/contracts';
import type { Point } from './geometry.ts';

export interface ArrangeBlock {
  id: string;
  /** 整块占的地方。 */
  ext: Rect;
  /** 窗口本身。 */
  rect: Rect;
  /** 窗口的最小尺寸。 */
  min: Size;
  /** false：只挪不改大小。 */
  resizable: boolean;
  /** 新开的，排在最后。 */
  last?: boolean;
}

/** 上下差不到这么多算同一行（白板坐标）。 */
export const ROW_TOLERANCE = 40;
/** columns 一行最多几个。 */
export const COLUMNS_PER_ROW = 6;

export const LAYOUT_LABEL: Record<FrameLayout, string> = { tidy: 'Tidy', columns: 'Columns', rows: 'Rows' };

/** 先上后下、先左后右；last 的排最后（它们之间也照这个顺序）。 */
export function readingOrder(blocks: readonly ArrangeBlock[]): ArrangeBlock[] {
  const rows: ArrangeBlock[][] = [];
  const byY = [...blocks].sort((a, b) => Number(!!a.last) - Number(!!b.last) || a.ext.y - b.ext.y || a.ext.x - b.ext.x);
  for (const b of byY) {
    const row = rows.find((r) => !!r[0]!.last === !!b.last && Math.abs(r[0]!.ext.y - b.ext.y) < ROW_TOLERANCE);
    if (row) row.push(b);
    else rows.push([b]);
  }
  return rows.flatMap((r) => r.sort((a, b) => a.ext.x - b.ext.x));
}

/** 排好后每个窗口的位置和大小（按块的 id）。origin 是框内区域的左上角。 */
export function arrangeBlocks(layout: FrameLayout, blocks: readonly ArrangeBlock[], origin: Point, gap: number): Map<string, Rect> {
  const order = readingOrder(blocks);
  const out = new Map<string, Rect>();
  if (order.length === 0) return out;
  // 窗口在整块里的位置（整块的左上角到窗口左上角）和整块比窗口多出来的宽高
  const pad = (b: ArrangeBlock) => ({ x: b.rect.x - b.ext.x, y: b.rect.y - b.ext.y, w: b.ext.w - b.rect.w, h: b.ext.h - b.rect.h });
  const resizable = order.filter((b) => b.resizable);
  // 每块的新窗口大小
  const sizeOf = new Map<string, Size>();
  if (layout === 'columns' && resizable.length > 0) {
    const h = Math.max(...resizable.map((b) => b.rect.h));
    const w = Math.round(resizable.reduce((n, b) => n + b.rect.w, 0) / resizable.length);
    for (const b of resizable) sizeOf.set(b.id, { w: Math.max(b.min.w, w), h: Math.max(b.min.h, h) });
  } else if (layout === 'rows' && resizable.length > 0) {
    const w = Math.max(...resizable.map((b) => b.rect.w));
    const h = Math.round(resizable.reduce((n, b) => n + b.rect.h, 0) / resizable.length);
    for (const b of resizable) sizeOf.set(b.id, { w: Math.max(b.min.w, w), h: Math.max(b.min.h, h) });
  }
  const extSize = (b: ArrangeBlock): Size => {
    const s = sizeOf.get(b.id);
    if (!s) return { w: b.ext.w, h: b.ext.h };
    const p = pad(b);
    return { w: s.w + p.w, h: s.h + p.h };
  };
  const place = (b: ArrangeBlock, x: number, y: number) => {
    const p = pad(b);
    const s = sizeOf.get(b.id) ?? { w: b.rect.w, h: b.rect.h };
    out.set(b.id, { x: x + p.x, y: y + p.y, w: s.w, h: s.h });
  };

  const perRow = layout === 'tidy' ? Math.max(1, Math.ceil(Math.sqrt(order.length))) : layout === 'columns' ? COLUMNS_PER_ROW : 1;
  // 按网格放：每列宽取这一列最宽的，每行高取这一行最高的
  const cols = Math.min(perRow, order.length);
  const colW: number[] = Array.from({ length: cols }, () => 0);
  const rowH: number[] = [];
  order.forEach((b, i) => {
    const s = extSize(b);
    const c = i % cols;
    const r = Math.floor(i / cols);
    colW[c] = Math.max(colW[c]!, s.w);
    rowH[r] = Math.max(rowH[r] ?? 0, s.h);
  });
  order.forEach((b, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    const x = origin.x + colW.slice(0, c).reduce((n, w) => n + w + gap, 0);
    const y = origin.y + rowH.slice(0, r).reduce((n, h) => n + h + gap, 0);
    place(b, x, y);
  });
  return out;
}
