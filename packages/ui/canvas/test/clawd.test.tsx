import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLAWD_ACTIVITIES,
  CLAWD_EVERY_MS,
  CLAWD_EXIT_MS,
  CLAWD_FRAME_MS,
  CLAWD_NAP_MS,
  CLAWD_STAY_MS,
  Clawd,
  ClawdSprite,
} from '../src/react/Clawd.tsx';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** 依次吐出给定的数，用完后一直是 0.5。 */
const seq = (...xs: number[]) => () => xs.shift() ?? 0.5;

describe('Clawd', () => {
  it('stays hidden at first, pops up after about 10 seconds doing a random thing, then ducks back down', () => {
    const { container } = render(<Clawd random={seq(0.4, 0.25)} />);
    expect(container.querySelector('.ad-clawd')).toBeNull();

    act(() => void vi.advanceTimersByTime(CLAWD_EVERY_MS + 20));
    const el = container.querySelector<HTMLElement>('.ad-clawd')!;
    expect(el.dataset.shown).toBe('true');
    expect(el.querySelector('svg')!.dataset.activity).toBe('coding'); // 0.4 × 3 → 第 2 个
    expect(el.style.left).toContain('0.250');

    act(() => void vi.advanceTimersByTime(CLAWD_STAY_MS));
    expect(el.dataset.shown).toBe('false');
  });

  it('comes back again with another activity', () => {
    const { container } = render(<Clawd random={seq(0, 0, 0.5, 0.9, 0.9)} />);
    act(() => void vi.advanceTimersByTime(CLAWD_EVERY_MS + 20));
    expect(container.querySelector('svg')!.dataset.activity).toBe('lifting');
    act(() => void vi.advanceTimersByTime(CLAWD_EVERY_MS + 20));
    expect(container.querySelector('svg')!.dataset.activity).toBe('eating');
    expect(container.querySelector<HTMLElement>('.ad-clawd')!.dataset.shown).toBe('true');
  });

  it('does not get in the way: decorative, no pointer events, cleans up its timers', () => {
    const { container, unmount } = render(<Clawd random={seq(0)} />);
    act(() => void vi.advanceTimersByTime(CLAWD_EVERY_MS + 20));
    expect(container.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('every activity has two frames drawn only with token classes', () => {
    for (const a of CLAWD_ACTIVITIES) {
      const { container, unmount } = render(<ClawdSprite activity={a} />);
      expect(container.querySelectorAll('.ad-clawd-frame')).toHaveLength(2);
      for (const r of container.querySelectorAll('rect')) expect(r.getAttribute('fill')).toBeNull();
      unmount();
    }
  });

  it('IS-161: switches its two frames with a timer only while shown, and is gone once it has ducked back down', () => {
    const { container } = render(<Clawd random={seq(0.4, 0.25)} />);
    act(() => void vi.advanceTimersByTime(CLAWD_EVERY_MS + 20));
    const svg = () => container.querySelector('svg')!;
    expect(svg().dataset.frame).toBe('1');
    act(() => void vi.advanceTimersByTime(CLAWD_FRAME_MS));
    expect(svg().dataset.frame).toBe('2');
    act(() => void vi.advanceTimersByTime(CLAWD_FRAME_MS));
    expect(svg().dataset.frame).toBe('1');

    act(() => void vi.advanceTimersByTime(CLAWD_STAY_MS - 20 - 2 * CLAWD_FRAME_MS)); // 正好缩回去
    expect(container.querySelector<HTMLElement>('.ad-clawd')!.dataset.shown).toBe('false');
    const still = svg().dataset.frame;
    act(() => void vi.advanceTimersByTime(CLAWD_EXIT_MS / 2));
    expect(svg().dataset.frame).toBe(still); // 缩回去时不再换帧
    act(() => void vi.advanceTimersByTime(CLAWD_EXIT_MS));
    expect(container.querySelector('.ad-clawd')).toBeNull();
    // 只剩下一次出现的那个定时器
    expect(vi.getTimerCount()).toBe(1);
  });

  it('IS-161: with reduced motion it stays on the first frame', () => {
    // jsdom 没有 matchMedia
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce'), media: q }));
    try {
      const { container } = render(<Clawd random={seq(0.4, 0.25)} />);
      act(() => void vi.advanceTimersByTime(CLAWD_EVERY_MS + 20 + CLAWD_FRAME_MS * 3));
      expect(container.querySelector('svg')!.dataset.frame).toBe('1');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('IS-161: naps once nobody has touched the keyboard or mouse for a while, and wakes on the next input', () => {
    const { container } = render(<Clawd random={seq()} />);
    // 一直没人碰：30 秒后那次不再冒出来，也不留定时器
    act(() => void vi.advanceTimersByTime(CLAWD_NAP_MS + CLAWD_EVERY_MS * 2));
    expect(container.querySelector('.ad-clawd')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    // 动一下鼠标：10 秒后又冒出来
    act(() => void window.dispatchEvent(new Event('pointermove')));
    act(() => void vi.advanceTimersByTime(CLAWD_EVERY_MS + 20));
    expect(container.querySelector<HTMLElement>('.ad-clawd')!.dataset.shown).toBe('true');
  });
});
