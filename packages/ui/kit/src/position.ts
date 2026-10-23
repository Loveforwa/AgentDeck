// 浮层定位的纯计算：给锚点矩形、浮层大小、视口大小，算出左上角。放不下就翻到另一边，最后夹在视口里。

export type Side = 'top' | 'bottom' | 'left' | 'right';
export type Align = 'start' | 'center' | 'end';
export type Placement = Side | `${Side}-${Exclude<Align, 'center'>}`;

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Position {
  x: number;
  y: number;
  placement: Placement;
}

/** 离视口边缘至少留这么多。 */
export const VIEWPORT_MARGIN = 8;

const OPPOSITE: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

function parse(p: Placement): [Side, Align] {
  const [side, align] = p.split('-') as [Side, Exclude<Align, 'center'> | undefined];
  return [side, align ?? 'center'];
}

function place(anchor: Box, float: { width: number; height: number }, side: Side, align: Align, offset: number) {
  const vertical = side === 'top' || side === 'bottom';
  let x: number;
  let y: number;
  if (vertical) {
    y = side === 'bottom' ? anchor.y + anchor.height + offset : anchor.y - float.height - offset;
    x =
      align === 'start'
        ? anchor.x
        : align === 'end'
          ? anchor.x + anchor.width - float.width
          : anchor.x + (anchor.width - float.width) / 2;
  } else {
    x = side === 'right' ? anchor.x + anchor.width + offset : anchor.x - float.width - offset;
    y =
      align === 'start'
        ? anchor.y
        : align === 'end'
          ? anchor.y + anchor.height - float.height
          : anchor.y + (anchor.height - float.height) / 2;
  }
  return { x, y };
}

function fits(side: Side, pos: { x: number; y: number }, float: { width: number; height: number }, vw: number, vh: number) {
  const m = VIEWPORT_MARGIN;
  switch (side) {
    case 'bottom':
      return pos.y + float.height <= vh - m;
    case 'top':
      return pos.y >= m;
    case 'right':
      return pos.x + float.width <= vw - m;
    case 'left':
      return pos.x >= m;
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, Math.max(lo, hi)));

export function computePosition(
  anchor: Box,
  float: { width: number; height: number },
  viewport: { width: number; height: number },
  placement: Placement = 'bottom-start',
  offset = 4,
): Position {
  const [side, align] = parse(placement);
  let usedSide = side;
  let pos = place(anchor, float, side, align, offset);
  if (!fits(side, pos, float, viewport.width, viewport.height)) {
    const other = OPPOSITE[side];
    const flipped = place(anchor, float, other, align, offset);
    if (fits(other, flipped, float, viewport.width, viewport.height)) {
      usedSide = other;
      pos = flipped;
    }
  }
  const m = VIEWPORT_MARGIN;
  return {
    x: clamp(pos.x, m, viewport.width - float.width - m),
    y: clamp(pos.y, m, viewport.height - float.height - m),
    placement: (align === 'center' ? usedSide : `${usedSide}-${align}`) as Placement,
  };
}
