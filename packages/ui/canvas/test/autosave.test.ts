import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAutosave } from '../src/model/autosave.ts';

describe('autosave (B5)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('saves once, half a second after the last change', async () => {
    const save = vi.fn(async (_v: number) => {});
    const a = createAutosave({ save });
    a.schedule(1);
    await vi.advanceTimersByTimeAsync(300);
    a.schedule(2);
    await vi.advanceTimersByTimeAsync(300);
    a.schedule(3);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(499);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenLastCalledWith(3);
    expect(a.pending()).toBe(false);
  });

  it('flush saves right away and nothing is left', async () => {
    const save = vi.fn(async (_v: string) => {});
    const a = createAutosave({ save, delayMs: 500 });
    a.schedule('x');
    expect(a.pending()).toBe(true);
    await a.flush();
    expect(save).toHaveBeenCalledWith('x');
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('writes in order even when a save is slow', async () => {
    const written: number[] = [];
    const save = vi.fn((v: number) => new Promise<void>((r) => setTimeout(() => (written.push(v), r()), v === 1 ? 800 : 10)));
    const a = createAutosave({ save });
    a.schedule(1);
    await vi.advanceTimersByTimeAsync(500);
    a.schedule(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(written).toEqual([1, 2]);
  });

  it('reports errors and keeps going', async () => {
    const onError = vi.fn();
    let fail = true;
    const save = vi.fn(async () => {
      if (fail) throw new Error('disk full');
    });
    const a = createAutosave({ save, onError });
    a.schedule(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(onError).toHaveBeenCalledTimes(1);
    fail = false;
    a.schedule(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(save).toHaveBeenCalledTimes(2);
  });
});
