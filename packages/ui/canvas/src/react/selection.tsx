// X10：框选。Shift + 左键在空白处（含框里的空白）拖出一个矩形，碰到的窗口都选上；同时按着 ⌘ 时加在原来的选择上。
// 左键拖空白处照旧平移白板（N6），所以框选要按 Shift，不改老用户的习惯。
// 事件在 .ad-board 上的捕获阶段拿：React Flow 的平移（d3-zoom 听 mousedown）收不到这次按下，松手后的 click 也不当成“点空白处”。

import { useEffect, useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { BoardController } from '../controller.ts';
import { useBoardState } from './context.tsx';
import '../selection.css';

/** 不算空白的地方：窗口、侧边栏、框的标题和改大小的边、浮层和各种控件。 */
const NOT_EMPTY =
  '.ad-window-node, .ad-group-sidebar, .ad-frame-header, .ad-frame-resize, .ad-frame-error, .ad-board-zoom, .ad-board-empty, .ad-popover, .ad-dialog, [role="menu"], [role="dialog"], button, a, input, textarea, select';

/** el 在白板的空白处：React Flow 的底板，或框里没有窗口的地方。 */
export function isEmptyBoardTarget(el: Element | null): boolean {
  if (!el || typeof el.closest !== 'function') return false;
  if (el.closest(NOT_EMPTY)) return false;
  return el.closest('.react-flow__pane, .ad-frame') !== null;
}

/** 这次按下是不是开始框选：Shift + 左键（可以再加 ⌘），按在空白处。 */
export function startsBoxSelect(e: Pick<PointerEvent, 'button' | 'shiftKey' | 'altKey' | 'ctrlKey'>, target: Element | null): boolean {
  return e.button === 0 && e.shiftKey && !e.altKey && !e.ctrlKey && isEmptyBoardTarget(target);
}

/** 拖过这么多屏幕像素才算框选（只是 Shift + 单击时什么都不选）。 */
const THRESHOLD = 3;

/** 给 .ad-board 的捕获阶段处理函数。disabled：正在空格平移。 */
export function useBoxSelect(c: BoardController, disabled: boolean) {
  const active = useRef(false);
  const suppressClick = useRef(false);
  const cleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanupRef.current?.(), []);

  const onPointerDownCapture = (e: ReactPointerEvent<HTMLElement>) => {
    if (disabled || active.current || !startsBoxSelect(e, e.target as Element)) return;
    e.stopPropagation();
    active.current = true;
    const doc = e.currentTarget.ownerDocument;
    const win = doc.defaultView ?? window;
    // 焦点离开终端和输入框：框选完 Esc、⌘Z 都给白板
    const focused = doc.activeElement as HTMLElement | null;
    if (focused && focused !== doc.body) focused.blur?.();
    const pointerId = e.pointerId;
    const startX = e.clientX;
    const startY = e.clientY;
    let moved = false;
    c.boxSelectStart(c.clientToFlow({ x: e.clientX, y: e.clientY }), e.metaKey);
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (!moved && Math.abs(ev.clientX - startX) < THRESHOLD && Math.abs(ev.clientY - startY) < THRESHOLD) return;
      moved = true;
      c.boxSelectMove(c.clientToFlow({ x: ev.clientX, y: ev.clientY }));
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      cleanup();
      c.boxSelectEnd();
      if (moved) suppressClick.current = true;
    };
    const cleanup = () => {
      active.current = false;
      cleanupRef.current = null;
      win.removeEventListener('pointermove', onMove);
      win.removeEventListener('pointerup', onUp);
      win.removeEventListener('pointercancel', onUp);
    };
    cleanupRef.current = cleanup;
    win.addEventListener('pointermove', onMove);
    win.addEventListener('pointerup', onUp);
    win.addEventListener('pointercancel', onUp);
  };

  // 跟在 pointerdown 后面的 mousedown：不给 React Flow 平移，也不开始选中文字
  const onMouseDownCapture = (e: ReactMouseEvent<HTMLElement>) => {
    if (!active.current) return;
    e.stopPropagation();
    e.preventDefault();
  };

  // 框选松手后的 click 不算“点空白处”（那会把刚选的清掉）
  const onClickCapture = (e: ReactMouseEvent<HTMLElement>) => {
    if (!suppressClick.current) return;
    suppressClick.current = false;
    e.stopPropagation();
  };

  return { onPointerDownCapture, onMouseDownCapture, onClickCapture };
}

/** 框选的矩形（store 里是白板坐标，这里换成屏幕坐标画）。 */
export function SelectionBox() {
  const box = useBoardState((s) => s.selectionBox);
  const vp = useBoardState((s) => s.viewport);
  if (!box) return null;
  return (
    <div
      className="ad-selection-box"
      data-testid="selection-box"
      aria-hidden="true"
      style={{ left: box.x * vp.zoom + vp.x, top: box.y * vp.zoom + vp.y, width: box.w * vp.zoom, height: box.h * vp.zoom }}
    />
  );
}
