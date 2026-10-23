import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Button,
  computePosition,
  Menu,
  Popover,
  TOAST_DEFAULT_MS,
  TOAST_WITH_ACTION_MS,
  ToastProvider,
  useToast,
  type ToastOptions,
} from '../src/index.ts';

describe('Toast', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function Trigger({ options }: { options: ToastOptions }) {
    const toast = useToast();
    return <button onClick={() => toast.show(options)}>show</button>;
  }

  it('shows one sentence and disappears on its own', () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Trigger options={{ message: 'Committed 2 files to feat/oauth' }} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('show'));
    expect(screen.getByRole('status').textContent).toBe('Committed 2 files to feat/oauth');
    act(() => vi.advanceTimersByTime(TOAST_DEFAULT_MS - 1));
    expect(screen.queryByRole('status')).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('stays longer with an action, and the action dismisses it', () => {
    vi.useFakeTimers();
    const undo = vi.fn();
    render(
      <ToastProvider>
        <Trigger options={{ message: 'Removed api-server · feat/oauth from the board', action: { label: 'Undo', onAction: undo } }} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('show'));
    act(() => vi.advanceTimersByTime(TOAST_DEFAULT_MS));
    expect(screen.queryByRole('status')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('status')).toBeNull();
    expect(TOAST_WITH_ACTION_MS).toBeGreaterThan(TOAST_DEFAULT_MS);
  });

  it('pauses while hovered', () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Trigger options={{ message: 'Saved', duration: 1000 }} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('show'));
    act(() => vi.advanceTimersByTime(600));
    fireEvent.mouseEnter(screen.getByRole('status').parentElement!);
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.queryByRole('status')).not.toBeNull();
    fireEvent.mouseLeave(screen.getByRole('status').parentElement!);
    act(() => vi.advanceTimersByTime(400));
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('Popover', () => {
  function Example({ onClose = () => {} }: { onClose?: () => void }) {
    const [anchor, setAnchor] = useState<HTMLElement | null>(null);
    const close = () => {
      onClose();
      setAnchor(null);
    };
    return (
      <>
        <Button onClick={(e) => setAnchor(e.currentTarget)}>Projects</Button>
        <button>elsewhere</button>
        <Popover open={!!anchor} anchor={anchor} onClose={close} chrome={false}>
          <Menu items={[{ id: 'api', label: 'api-server' }]} onClose={close} aria-label="Projects" />
        </Popover>
      </>
    );
  }

  it('opens anchored, moves focus in, and Escape closes and returns focus', async () => {
    const user = userEvent.setup();
    render(<Example />);
    const opener = screen.getByRole('button', { name: 'Projects' });
    await user.click(opener);
    const menu = screen.getByRole('menu', { name: 'Projects' });
    expect(menu.closest('.ad-popover')).not.toBeNull();
    expect(document.activeElement).toBe(menu);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('closes on a click outside', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Example onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Projects' }));
    await user.click(screen.getByRole('button', { name: 'elsewhere' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('computePosition', () => {
  const viewport = { width: 800, height: 600 };
  const anchor = { x: 100, y: 100, width: 80, height: 24 };
  const float = { width: 200, height: 120 };

  it('places below, start-aligned, with the offset', () => {
    expect(computePosition(anchor, float, viewport, 'bottom-start', 4)).toEqual({ x: 100, y: 128, placement: 'bottom-start' });
  });

  it('aligns end and center', () => {
    // 右对齐会算出 x = -20，被夹到离边缘 8px。
    expect(computePosition(anchor, float, viewport, 'bottom-end').x).toBe(8);
    expect(computePosition({ ...anchor, x: 400 }, float, viewport, 'bottom-end').x).toBe(400 + 80 - 200);
    expect(computePosition({ ...anchor, x: 400 }, float, viewport, 'bottom').x).toBe(400 + 40 - 100);
  });

  it('flips to the top when there is no room below', () => {
    const low = { ...anchor, y: 540 };
    expect(computePosition(low, float, viewport, 'bottom-start')).toEqual({ x: 100, y: 540 - 4 - 120, placement: 'top-start' });
  });

  it('flips right to left and clamps into the viewport', () => {
    const p = computePosition({ x: 700, y: 10, width: 60, height: 20 }, float, viewport, 'right-start');
    expect(p.placement).toBe('left-start');
    expect(p.x).toBe(700 - 4 - 200);
  });

  it('works for a point anchor (context menu)', () => {
    expect(computePosition({ x: 300, y: 200, width: 0, height: 0 }, float, viewport, 'bottom-start', 0)).toEqual({
      x: 300,
      y: 200,
      placement: 'bottom-start',
    });
  });
});
