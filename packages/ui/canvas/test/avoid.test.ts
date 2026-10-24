import { describe, expect, it } from 'vitest';
import type { Rect } from '@agentdeck/contracts';
import { clampFrameMove, findFreeSpot, pushFrames, pushOut, separateFrames, tooClose } from '../src/model/avoid.ts';
import { intersects } from '../src/model/geometry.ts';

const R = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });

describe('tooClose', () => {
  it('exactly gap apart is fine, closer is not; gap 0 means overlapping', () => {
    expect(tooClose(R(0, 0, 100, 100), R(120, 0, 100, 100), 20)).toBe(false);
    expect(tooClose(R(0, 0, 100, 100), R(119, 0, 100, 100), 20)).toBe(true);
    expect(tooClose(R(0, 0, 100, 100), R(100, 0, 100, 100), 0)).toBe(false);
    expect(tooClose(R(0, 0, 100, 100), R(99, 0, 100, 100), 0)).toBe(true);
  });
});

describe('findFreeSpot (windows, on release)', () => {
  const a = R(0, 0, 170, 150);

  it('leaves a window alone when it covers nothing (touching or close is fine)', () => {
    const r = R(175, 0, 160, 120);
    expect(findFreeSpot(r, [a], { gap: 16 })).toBe(r);
    expect(findFreeSpot(R(170, 0, 10, 10), [a], { gap: 16 })).toEqual(R(170, 0, 10, 10));
  });

  it('slides a window dropped on another to the nearest free spot, gap away (board 11: to the right)', () => {
    expect(findFreeSpot(R(120, 40, 160, 120), [a], { gap: 16 })).toEqual(R(186, 40, 160, 120));
  });

  it('prefers a spot inside the frame even if one outside is closer', () => {
    const area = R(0, 0, 300, 400);
    expect(findFreeSpot(R(120, 40, 160, 120), [a], { gap: 16, area })).toEqual(R(120, 166, 160, 120));
  });

  it('when nothing fits inside the frame, goes to the nearest spot outside (the frame then grows)', () => {
    const area = R(0, 0, 180, 160);
    expect(findFreeSpot(R(120, 40, 160, 120), [a], { gap: 16, area })).toEqual(R(186, 40, 160, 120));
  });

  it('the new spot keeps the gap from every window, not just the one it covered', () => {
    const b = R(200, 0, 100, 150);
    const got = findFreeSpot(R(120, 40, 160, 120), [a, b], { gap: 16 });
    for (const o of [a, b]) expect(tooClose(o, got, 16)).toBe(false);
  });

  it('with a margin, being closer than the margin also counts as covering (frames)', () => {
    const got = findFreeSpot(R(180, 0, 100, 100), [a], { gap: 20, margin: 20 });
    expect(got).toEqual(R(190, 0, 100, 100));
  });

  it('never returns a spot that overlaps, with many windows around', () => {
    const obstacles = Array.from({ length: 12 }, (_, i) => R((i % 4) * 120, Math.floor(i / 4) * 120, 100, 100));
    const got = findFreeSpot(R(50, 50, 100, 100), obstacles, { gap: 16, area: R(0, 0, 460, 340) });
    expect(obstacles.some((o) => intersects(o, got))).toBe(false);
  });
});

describe('clampFrameMove (dragging a frame)', () => {
  const other = R(500, 0, 200, 200);

  it('stops 20px before another frame', () => {
    expect(clampFrameMove(R(0, 0, 200, 200), R(400, 0, 200, 200), [other], 20)).toEqual(R(280, 0, 200, 200));
  });

  it('does not tunnel through when the pointer jumps past', () => {
    expect(clampFrameMove(R(0, 0, 200, 200), R(1000, 0, 200, 200), [other], 20)).toEqual(R(280, 0, 200, 200));
  });

  it('slides along the edge and gets around a corner', () => {
    expect(clampFrameMove(R(0, 0, 200, 200), R(400, 30, 200, 200), [other], 20)).toEqual(R(280, 30, 200, 200));
    expect(clampFrameMove(R(0, 0, 200, 200), R(400, 300, 200, 200), [other], 20)).toEqual(R(400, 300, 200, 200));
  });

  it('works in every direction', () => {
    expect(clampFrameMove(R(800, 0, 200, 200), R(500, 0, 200, 200), [other], 20).x).toBe(720);
    expect(clampFrameMove(R(500, 400, 200, 200), R(500, 0, 200, 200), [other], 20).y).toBe(220);
    expect(clampFrameMove(R(500, -400, 200, 200), R(500, 0, 200, 200), [other], 20).y).toBe(-220);
  });

  it('a frame that already sat too close (old layout) can move away, and only stops when touching', () => {
    // 在 other 正下方，只隔 10
    expect(clampFrameMove(R(500, 210, 200, 200), R(500, 300, 200, 200), [other], 20).y).toBe(300);
    expect(clampFrameMove(R(500, 210, 200, 200), R(500, 100, 200, 200), [other], 20).y).toBe(200);
  });

  it('a frame that already overlaps (old layout) does not block', () => {
    expect(clampFrameMove(R(450, 0, 200, 200), R(460, 0, 200, 200), [other], 20).x).toBe(460);
  });
});

describe('pushOut / pushFrames (a frame grows into another)', () => {
  it('pushes away on the side the other frame is on, the shortest way', () => {
    expect(pushOut(R(0, 0, 500, 200), R(330, 0, 200, 200), 20)).toEqual(R(520, 0, 200, 200));
    expect(pushOut(R(0, 0, 300, 400), R(0, 350, 300, 200), 20)).toEqual(R(0, 420, 300, 200));
  });

  it('cascades to frames further along', () => {
    const others = new Map([
      ['q', R(330, 0, 200, 200)],
      ['r', R(560, 0, 200, 200)],
    ]);
    const moved = pushFrames(others, { id: 'p', before: R(0, 0, 300, 200), after: R(0, 0, 500, 200) }, 20);
    expect(moved.get('q')).toEqual(R(520, 0, 200, 200));
    expect(moved.get('r')).toEqual(R(740, 0, 200, 200));
  });

  it('leaves frames that were already close but are not overlapped now; the changed frame never moves', () => {
    const others = new Map([
      ['p', R(0, 0, 300, 200)],
      ['q', R(310, 0, 200, 200)],
    ]);
    expect(pushFrames(others, { id: 'p', before: R(0, 0, 300, 200), after: R(0, 0, 300, 400) }, 20).size).toBe(0);
    const moved = pushFrames(others, { id: 'p', before: R(0, 0, 300, 200), after: R(0, 0, 320, 200) }, 20);
    expect(moved.get('q')).toEqual(R(340, 0, 200, 200));
    expect(moved.has('p')).toBe(false);
  });

  it('a new frame (no before) pushes anything closer than the gap', () => {
    const moved = pushFrames(new Map([['q', R(210, 0, 100, 100)]]), { id: 'p', before: null, after: R(0, 0, 200, 100) }, 20);
    expect(moved.get('q')).toEqual(R(220, 0, 100, 100));
  });

  it('separateFrames splits frames that overlap in an old layout and leaves the rest', () => {
    const frames = new Map([
      ['a', R(0, 0, 400, 300)],
      ['b', R(350, 50, 400, 300)],
      ['c', R(0, 310, 300, 100)], // 离 a 只有 10，但没重叠：不动
    ]);
    const moved = separateFrames(frames, 20);
    expect(moved.get('b')).toEqual(R(420, 50, 400, 300));
    expect(moved.has('a')).toBe(false);
    expect(moved.has('c')).toBe(false);
  });
});
