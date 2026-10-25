// ActivityTracker（src/activity.ts）：activity / silence 的计时，改大小后的重画不算活动（IS-72）。用假的计时器。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityTracker } from '../src/activity.ts';

const SILENCE = 3000;
const QUIET = 1000;

function setup(o: { adopted?: boolean; quietMs?: number; alive?: () => boolean } = {}) {
  const log: string[] = [];
  const t = new ActivityTracker(
    {
      silenceMs: SILENCE,
      quietMs: o.quietMs ?? QUIET,
      alive: o.alive ?? (() => true),
      onActivity: () => log.push('activity'),
      onSilence: () => log.push('silence'),
      onTimer: () => log.push('timer'),
    },
    { adopted: o.adopted ?? false },
  );
  return { t, log };
}

/** 新建的终端：启动输出（第一次 activity）之后安静下来。 */
function settled() {
  const s = setup();
  s.t.output();
  vi.advanceTimersByTime(SILENCE);
  s.log.length = 0;
  return s;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('ActivityTracker', () => {
  it('one activity per burst of output, silence after silenceMs without output', () => {
    const { t, log } = setup();
    expect(t.output()).toBe(true);
    vi.advanceTimersByTime(1000);
    t.output();
    vi.advanceTimersByTime(SILENCE - 1);
    expect(log).toEqual(['activity']);
    vi.advanceTimersByTime(1);
    expect(log).toEqual(['activity', 'timer', 'silence']);
    t.output();
    expect(log.at(-1)).toBe('activity');
  });

  it('input restarts the silence timer', () => {
    const { t, log } = setup();
    t.output();
    vi.advanceTimersByTime(2000);
    t.input();
    vi.advanceTimersByTime(2000);
    expect(log).toEqual(['activity']);
    vi.advanceTimersByTime(1000);
    expect(log).toEqual(['activity', 'timer', 'silence']);
  });

  it('the redraw right after a resize of a quiet terminal is not activity; silence timing is unchanged (IS-72)', () => {
    const { t, log } = settled();
    t.resized();
    vi.advanceTimersByTime(50);
    expect(t.output()).toBe(false);
    vi.advanceTimersByTime(100);
    expect(t.output()).toBe(false);
    expect(log).toEqual([]);
    vi.advanceTimersByTime(SILENCE);
    expect(log).toEqual(['timer', 'silence']);
  });

  it('output after the quiet window counts again', () => {
    const { t, log } = settled();
    t.resized();
    t.output();
    vi.advanceTimersByTime(QUIET);
    expect(t.output()).toBe(true);
    expect(log).toEqual(['activity']);
  });

  it('a program that starts printing inside the window and keeps going is seen once the window is over', () => {
    const { t, log } = settled();
    t.resized();
    for (let i = 0; i < 10; i++) {
      t.output();
      vi.advanceTimersByTime(200);
    }
    // 第 6 段在 1000ms 时，窗口刚过
    expect(log).toEqual(['activity']);
  });

  it('does not hide output while the terminal is already active', () => {
    const { t, log } = setup();
    t.output();
    t.resized();
    expect(t.output()).toBe(true);
    expect(log).toEqual(['activity']);
  });

  it('never hides the first activity of a new terminal (attach and start happen together)', () => {
    const { t, log } = setup();
    t.resized();
    expect(t.output()).toBe(true);
    expect(log).toEqual(['activity']);
  });

  it('an adopted terminal (reopened app) hides the redraw of its first attach', () => {
    const { t, log } = setup({ adopted: true });
    t.resized();
    expect(t.output()).toBe(false);
    expect(log).toEqual([]);
  });

  it('every resize extends the window; quietMs 0 turns it off', () => {
    const { t, log } = settled();
    t.resized();
    vi.advanceTimersByTime(800);
    t.resized();
    vi.advanceTimersByTime(800);
    expect(t.output()).toBe(false);
    expect(log).toEqual([]);

    const off = setup({ quietMs: 0 });
    off.t.output();
    vi.advanceTimersByTime(SILENCE);
    off.log.length = 0;
    off.t.resized();
    expect(off.t.output()).toBe(true);
    expect(off.log).toEqual(['activity']);
  });

  it('no silence for a dead process; clear() stops the timer', () => {
    let alive = true;
    const { t, log } = setup({ alive: () => alive });
    t.output();
    alive = false;
    vi.advanceTimersByTime(SILENCE);
    expect(log).toEqual(['activity', 'timer']);

    const b = setup();
    b.t.output();
    b.t.clear();
    vi.advanceTimersByTime(SILENCE * 2);
    expect(b.log).toEqual(['activity']);
  });
});
