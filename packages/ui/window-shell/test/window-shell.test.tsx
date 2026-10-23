import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { resizeRect, WindowShell } from '../src/index.ts';

const min = { w: 100, h: 60 };
const start = { x: 10, y: 20, w: 300, h: 200 };

describe('resizeRect', () => {
  it('grows from the right and bottom edges', () => {
    expect(resizeRect(start, 'se', 50, 30, min)).toEqual({ x: 10, y: 20, w: 350, h: 230 });
    expect(resizeRect(start, 'e', 50, 30, min)).toEqual({ x: 10, y: 20, w: 350, h: 200 });
    expect(resizeRect(start, 's', 50, 30, min)).toEqual({ x: 10, y: 20, w: 300, h: 230 });
  });

  it('keeps the opposite edge fixed when dragging left or top', () => {
    expect(resizeRect(start, 'nw', 20, 10, min)).toEqual({ x: 30, y: 30, w: 280, h: 190 });
    expect(resizeRect(start, 'w', -40, 0, min)).toEqual({ x: -30, y: 20, w: 340, h: 200 });
  });

  it('stops at the minimum size', () => {
    expect(resizeRect(start, 'se', -500, -500, min)).toEqual({ x: 10, y: 20, w: 100, h: 60 });
    expect(resizeRect(start, 'nw', 500, 500, min)).toEqual({ x: 210, y: 160, w: 100, h: 60 });
  });
});

function drag(el: Element, from: [number, number], to: [number, number]) {
  fireEvent.pointerDown(el, { button: 0, pointerId: 1, clientX: from[0], clientY: from[1] });
  fireEvent.pointerMove(window, { pointerId: 1, clientX: to[0], clientY: to[1] });
  fireEvent.pointerUp(window, { pointerId: 1, clientX: to[0], clientY: to[1] });
}

describe('WindowShell', () => {
  it('shows name, label and status', () => {
    render(<WindowShell name="claude" label="lead" status={{ text: 'Needs approval', tone: 'attention', dot: 'filled' }} />);
    expect(screen.getByText('claude')).toBeTruthy();
    expect(screen.getByText('lead')).toBeTruthy();
    expect(screen.getByText('Needs approval').className).toContain('attention');
  });

  it('reports title drags as total screen deltas', () => {
    const onMove = vi.fn();
    const onMoveEnd = vi.fn();
    const { container } = render(<WindowShell name="zsh" onMove={onMove} onMoveEnd={onMoveEnd} />);
    drag(container.querySelector('.ad-window-titlebar')!, [100, 100], [140, 90]);
    expect(onMove).toHaveBeenLastCalledWith(40, -10, expect.anything());
    expect(onMoveEnd).toHaveBeenCalledWith(true, expect.anything());
  });

  it('a click without moving is not a drag', () => {
    const onMove = vi.fn();
    const onMoveEnd = vi.fn();
    const { container } = render(<WindowShell name="zsh" onMove={onMove} onMoveEnd={onMoveEnd} />);
    drag(container.querySelector('.ad-window-titlebar')!, [100, 100], [101, 101]);
    expect(onMove).not.toHaveBeenCalled();
    expect(onMoveEnd).toHaveBeenCalledWith(false, expect.anything());
  });

  it('resizes from every edge and corner', () => {
    const onResize = vi.fn();
    const onResizeEnd = vi.fn();
    const { container } = render(<WindowShell name="zsh" onResize={onResize} onResizeEnd={onResizeEnd} />);
    const handles = container.querySelectorAll('[data-edge]');
    expect(handles).toHaveLength(8);
    drag(container.querySelector('[data-edge="se"]')!, [0, 0], [20, 30]);
    expect(onResize).toHaveBeenLastCalledWith('se', 20, 30);
    expect(onResizeEnd).toHaveBeenCalledWith('se');
  });

  it('hides resize handles when maximized and offers Restore', () => {
    const onToggle = vi.fn();
    const { container } = render(<WindowShell name="zsh" maximized onToggleMaximize={onToggle} />);
    expect(container.querySelectorAll('[data-edge]')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(onToggle).toHaveBeenCalled();
  });

  it('double-click on the title and close button', () => {
    const onDbl = vi.fn();
    const onClose = vi.fn();
    const { container } = render(<WindowShell name="zsh" onTitleDoubleClick={onDbl} onClose={onClose} />);
    fireEvent.doubleClick(container.querySelector('.ad-window-titlebar')!);
    expect(onDbl).toHaveBeenCalledTimes(1);
    fireEvent.doubleClick(screen.getByRole('button', { name: 'Close' }));
    expect(onDbl).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('attention border only when not focused', () => {
    const { container, rerender } = render(<WindowShell name="claude" attention />);
    expect(container.firstElementChild!.className).toContain('ad-window--attention');
    rerender(<WindowShell name="claude" attention focused />);
    expect(container.firstElementChild!.className).not.toContain('ad-window--attention');
    expect(container.firstElementChild!.className).toContain('ad-window--focused');
  });
});
