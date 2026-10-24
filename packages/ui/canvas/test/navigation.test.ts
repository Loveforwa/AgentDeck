import { describe, expect, it } from 'vitest';
import type { FrameNode, Rect, WindowId, WindowNode, WorkspaceId } from '@agentdeck/contracts';
import { adjacentWindow, readingOrder, windowOrder } from '../src/model/navigation.ts';

const WS_A = 'ws-a' as WorkspaceId;
const WS_B = 'ws-b' as WorkspaceId;
const WS_GONE = 'ws-gone' as WorkspaceId;
const id = (s: string) => s as WindowId;

function win(wid: string, ws: WorkspaceId | null, rect: Rect, type = 'terminal'): WindowNode {
  return { id: id(wid), type, workspaceId: ws, rect, z: 1, title: null, restoreRect: null, data: null };
}

function frame(ws: WorkspaceId, rect: Rect): FrameNode {
  return { workspaceId: ws, rect, z: 0, autoApprove: false };
}

describe('window navigation (S3, ⌘⇧] ⌘⇧[)', () => {
  it('reading order: top to bottom, then left to right; a few pixels off still counts as the same row', () => {
    const r = (x: number, y: number): Rect => ({ x, y, w: 100, h: 100 });
    const items = [
      { n: 'bottom', r: r(0, 300) },
      { n: 'right', r: r(200, 0) },
      { n: 'left', r: r(0, 8) }, // 比右边那个低 8px，还是同一行
      { n: 'middle', r: r(100, 120) },
    ];
    expect(readingOrder(items, (i) => i.r).map((i) => i.n)).toEqual(['left', 'right', 'middle', 'bottom']);
  });

  // 框 B 在框 A 右边，框 A 里两行；散放的窗口（含工作区没有框的）排最后
  const frames = [frame(WS_B, { x: 1000, y: 0, w: 800, h: 600 }), frame(WS_A, { x: 0, y: 0, w: 900, h: 900 })];
  const windows = [
    win('loose-2', null, { x: 400, y: 1200, w: 300, h: 200 }),
    win('a-bottom', WS_A, { x: 20, y: 500, w: 300, h: 200 }),
    win('b-1', WS_B, { x: 1020, y: 40, w: 300, h: 200 }, 'browser'),
    win('a-top-right', WS_A, { x: 400, y: 40, w: 300, h: 200 }, 'browser'),
    win('a-top-left', WS_A, { x: 20, y: 44, w: 300, h: 200 }),
    win('loose-1', null, { x: 0, y: 1200, w: 300, h: 200 }),
    win('orphan', WS_GONE, { x: 0, y: 1500, w: 300, h: 200 }),
  ];
  const order = windowOrder(windows, frames);

  it('frames first in board order, windows inside by position, loose windows last', () => {
    expect(order).toEqual(['a-top-left', 'a-top-right', 'a-bottom', 'b-1', 'loose-1', 'loose-2', 'orphan']);
  });

  it('next / previous cycle from the focused window', () => {
    expect(adjacentWindow(order, id('a-top-left'), 1)).toBe('a-top-right');
    expect(adjacentWindow(order, id('a-bottom'), 1)).toBe('b-1');
    expect(adjacentWindow(order, id('orphan'), 1)).toBe('a-top-left');
    expect(adjacentWindow(order, id('a-top-left'), -1)).toBe('orphan');
    expect(adjacentWindow(order, id('b-1'), -1)).toBe('a-bottom');
  });

  it('with nothing focused: first / last, or start at the selected frame', () => {
    expect(adjacentWindow(order, null, 1)).toBe('a-top-left');
    expect(adjacentWindow(order, null, -1)).toBe('orphan');
    expect(adjacentWindow(order, null, 1, id('b-1'))).toBe('b-1');
    expect(adjacentWindow(order, null, -1, id('b-1'))).toBe('a-bottom');
    expect(adjacentWindow([], null, 1)).toBeNull();
    expect(adjacentWindow([id('x')], id('x'), 1)).toBe('x');
  });
});
