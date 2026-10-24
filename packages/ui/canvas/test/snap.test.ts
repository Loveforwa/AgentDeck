import { describe, expect, it } from 'vitest';
import type { Rect } from '@agentdeck/contracts';
import { snapMove, snapResize, type Guide } from '../src/model/snap.ts';
import { layoutGuides } from '../src/react/Guides.tsx';

const R = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });
const opts = { threshold: 6, gap: 16 };
const kinds = (gs: Guide[]) => gs.map((g) => `${g.kind}:${g.axis}`);

describe('snapMove (V3)', () => {
  it('snaps an edge to another window’s edge within the threshold and draws the line across both', () => {
    const t = R(0, 0, 100, 100);
    const res = snapMove(R(104, 200, 50, 50), [t], opts);
    expect(res.rect).toEqual(R(100, 200, 50, 50));
    expect(res.guides).toEqual([{ kind: 'align', axis: 'x', at: 100, from: 0, to: 250 }]);
  });

  it('does nothing outside the threshold', () => {
    const res = snapMove(R(107, 200, 50, 50), [R(0, 0, 100, 100)], opts);
    expect(res.rect).toEqual(R(107, 200, 50, 50));
    expect(res.guides).toEqual([]);
  });

  it('the threshold is whatever the caller passes (6 screen px / zoom)', () => {
    // 缩到 50%：屏幕 6px = 白板 12
    expect(snapMove(R(110, 200, 50, 50), [R(0, 0, 100, 100)], { ...opts, threshold: 12 }).rect.x).toBe(100);
    // 放大到 200%：屏幕 6px = 白板 3
    expect(snapMove(R(104, 200, 50, 50), [R(0, 0, 100, 100)], { ...opts, threshold: 3 }).rect.x).toBe(104);
  });

  it('snaps centre to centre', () => {
    const res = snapMove(R(23, 300, 60, 40), [R(0, 0, 100, 100)], opts);
    expect(res.rect.x).toBe(20);
    expect(res.guides).toContainEqual({ kind: 'align', axis: 'x', at: 50, from: 0, to: 340 });
  });

  it('takes the closest candidate when several are in range', () => {
    const res = snapMove(R(101, 200, 50, 50), [R(0, 0, 100, 10), R(103, 400, 50, 10)], opts);
    expect(res.rect.x).toBe(100);
  });

  it('merges lines that land on the same position', () => {
    const res = snapMove(R(3, 300, 50, 50), [R(0, 0, 100, 100), R(0, 120, 80, 40)], opts);
    expect(res.rect.x).toBe(0);
    const lines = res.guides.filter((g) => g.kind === 'align' && g.axis === 'x');
    expect(lines).toEqual([{ kind: 'align', axis: 'x', at: 0, from: 0, to: 350 }]);
  });

  it('snaps to the standard gap next to a window side by side', () => {
    const res = snapMove(R(113, 10, 50, 50), [R(0, 0, 100, 100)], opts);
    expect(res.rect.x).toBe(116);
    expect(res.guides).toContainEqual({ kind: 'gap', axis: 'x', size: 16, segments: [{ from: 100, to: 116, cross: 35 }] });
  });

  it('no gap snapping to a window that is not side by side', () => {
    const res = snapMove(R(113, 300, 50, 50), [R(0, 0, 100, 100)], opts);
    expect(res.rect.x).toBe(113);
  });

  it('centres between two windows (equal gaps on both sides)', () => {
    const a = R(0, 0, 100, 100);
    const b = R(300, 0, 100, 100);
    const res = snapMove(R(172, 120, 50, 50), [a, b], { ...opts, threshold: 6 });
    // y 不并排时不算等距
    expect(res.rect.x).toBe(172);
    const side = snapMove(R(172, 20, 50, 50), [a, b], opts);
    expect(side.rect.x).toBe(175);
    const gap = side.guides.find((g) => g.kind === 'gap');
    expect(gap).toMatchObject({ size: 75, segments: [{ from: 100, to: 175 }, { from: 225, to: 300 }] });
  });

  it('repeats the gap between two other windows (tldraw-style gap snapping)', () => {
    const a = R(0, 0, 100, 100);
    const b = R(140, 0, 100, 100);
    const res = snapMove(R(283, 0, 100, 100), [a, b], opts);
    expect(res.rect.x).toBe(280);
    expect(res.guides).toContainEqual({
      kind: 'gap',
      axis: 'x',
      size: 40,
      segments: [
        { from: 100, to: 140, cross: 50 },
        { from: 240, to: 280, cross: 50 },
      ],
    });
  });

  it('snaps to the frame’s inner edges', () => {
    const area = R(16, 36, 500, 400);
    const res = snapMove(R(20, 434 - 50 + 3, 50, 50), [], { ...opts, area });
    expect(res.rect).toEqual(R(16, 386, 50, 50));
    expect(kinds(res.guides).sort()).toEqual(['align:x', 'align:y']);
  });

  it('snaps x and y independently', () => {
    const res = snapMove(R(104, 3, 50, 50), [R(0, 0, 100, 100)], opts);
    expect(res.rect).toEqual(R(100, 0, 50, 50));
  });
});

describe('snapResize (V3)', () => {
  const min = { w: 110, h: 60 };

  it('east edge: same width as a neighbour, labelled on both', () => {
    const t = R(0, 0, 170, 150);
    const res = snapResize(R(200, 0, 165, 150), 'e', [t], { ...opts, min });
    expect(res.rect).toEqual(R(200, 0, 170, 150));
    expect(res.guides).toContainEqual({ kind: 'size', axis: 'x', size: 170, rects: [R(200, 0, 170, 150), t] });
  });

  it('west edge moves x, keeps the right edge, and snaps to the gap after a neighbour', () => {
    const res = snapResize(R(190, 0, 175, 150), 'w', [R(0, 0, 170, 150)], { ...opts, min });
    expect(res.rect).toEqual(R(186, 0, 179, 150));
    expect(res.guides[0]).toMatchObject({ kind: 'gap', axis: 'x', size: 16 });
  });

  it('south edge: same height', () => {
    const res = snapResize(R(200, 0, 160, 146), 's', [R(0, 0, 170, 150)], { ...opts, min });
    expect(res.rect.h).toBe(150);
  });

  it('only the moving edges snap', () => {
    // 东边在动，西边离 0 只有 3 也不吸
    const res = snapResize(R(3, 300, 200, 100), 'e', [R(0, 0, 50, 50)], { ...opts, min });
    expect(res.rect.x).toBe(3);
  });

  it('never goes below the minimum size', () => {
    const res = snapResize(R(300, 0, 112, 100), 'e', [R(0, 200, 108, 50)], { ...opts, min });
    expect(res.rect.w).toBe(112);
  });

  it('snaps to the frame’s inner edge', () => {
    const res = snapResize(R(16, 36, 480, 100), 'e', [], { ...opts, min, area: R(16, 36, 484, 400) });
    expect(res.rect.w).toBe(484);
  });
});

describe('IS-65: frames as align-only targets, frame resize', () => {
  const min = { w: 110, h: 60 };

  it('alignTo rects snap edges and centres but are not used for spacing', () => {
    const f = R(0, 0, 100, 100);
    // 边对边
    expect(snapMove(R(300, 104, 50, 50), [], { ...opts, alignTo: [f] }).rect.y).toBe(100);
    // 中线对中线
    expect(snapMove(R(300, 27, 50, 50), [], { ...opts, alignTo: [f] }).rect.y).toBe(25);
    // 并排、离它 14：作为窗口会吸到 16 的标准间距，作为框不吸
    expect(snapMove(R(114, 300, 50, 50), [R(0, 290, 100, 100)], opts).rect.x).toBe(116);
    expect(snapMove(R(114, 300, 50, 50), [], { ...opts, alignTo: [R(0, 290, 100, 100)] }).rect.x).toBe(114);
  });

  it('fit: the edge snaps to just fit the content and never goes inside it; the line is on the content edge', () => {
    const content = R(16, 36, 300, 200);
    const fit = { content, frame: R(0, 0, 332, 252) };
    const res = snapResize(R(0, 0, 337, 400), 'e', [], { ...opts, min, fit });
    expect(res.rect.w).toBe(332);
    expect(res.guides).toEqual([{ kind: 'align', axis: 'x', at: 316, from: 0, to: 400 }]);
    // 吸附点比 fit 小就不要（这里同宽 330 会挤进窗口）
    expect(snapResize(R(0, 0, 334, 400), 'e', [R(0, 500, 330, 50)], { ...opts, min, fit }).rect.w).toBe(332);
  });

  it('keepApart: a snap that would bring the edge closer than keepApart to a target is skipped', () => {
    const t = R(200, 0, 100, 100);
    // 右边 179（离 t 21）：吸到隔 16 的 184 就离 t 不到 20 了，不吸
    expect(snapResize(R(0, 0, 179, 100), 'e', [t], { ...opts, min, keepApart: 20 }).rect.w).toBe(179);
    expect(snapResize(R(0, 0, 179, 100), 'e', [t], { ...opts, min }).rect.w).toBe(184);
    // 隔 keepApart 正好的位置照吸（gap 和 keepApart 一样，框改大小就是这样）
    expect(snapResize(R(0, 0, 177, 100), 'e', [t], { ...opts, gap: 20, min, keepApart: 20 }).rect.w).toBe(180);
  });
});

describe('guide layout (screen coordinates)', () => {
  it('maps board coordinates through the viewport and keeps labels as whole numbers', () => {
    const { lines, labels } = layoutGuides(
      [
        { kind: 'align', axis: 'x', at: 100, from: 0, to: 50 },
        { kind: 'gap', axis: 'x', size: 16.4, segments: [{ from: 100, to: 116, cross: 20 }] },
        { kind: 'size', axis: 'x', size: 170, rects: [R(0, 0, 170, 150)] },
      ],
      { x: 10, y: 20, zoom: 0.5 },
    );
    expect(lines[0]).toEqual({ x1: 60, y1: 20, x2: 60, y2: 45, dashed: true });
    expect(lines[1]).toEqual({ x1: 60, y1: 30, x2: 68, y2: 30, dashed: false });
    expect(labels).toEqual([
      { x: 64, y: 30, text: '16' },
      { x: 52.5, y: 95 + 8, text: '170' },
    ]);
  });
});
