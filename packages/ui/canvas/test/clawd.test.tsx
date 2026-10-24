import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLAWD_ACTIVITIES, CLAWD_EVERY_MS, CLAWD_STAY_MS, Clawd, ClawdSprite } from '../src/react/Clawd.tsx';

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
});
