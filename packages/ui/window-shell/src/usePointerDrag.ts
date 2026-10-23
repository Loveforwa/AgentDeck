import { useRef, type PointerEvent as ReactPointerEvent } from 'react';

export interface DragHandlers {
  onStart?(): void;
  /** 从按下到现在的总位移，屏幕像素。 */
  onMove?(dx: number, dy: number, e: PointerEvent): void;
  /** moved：按下后真的移动过（超过 3px）。 */
  onEnd?(moved: boolean, e: PointerEvent): void;
}

const THRESHOLD = 3;

/** 左键按住拖动。用 pointer capture，拖出元素也能收到移动。返回给元素的 onPointerDown。 */
export function usePointerDrag(handlers: DragHandlers) {
  const ref = useRef(handlers);
  ref.current = handlers;

  return (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    const el = e.currentTarget;
    const startX = e.clientX;
    const startY = e.clientY;
    const pointerId = e.pointerId;
    let moved = false;
    try {
      el.setPointerCapture(pointerId);
    } catch {
      // jsdom 和某些合成事件不支持 capture，照样靠 window 上的监听工作
    }
    e.stopPropagation();

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!moved) {
        if (Math.abs(dx) < THRESHOLD && Math.abs(dy) < THRESHOLD) return;
        moved = true;
        ref.current.onStart?.();
      }
      ref.current.onMove?.(dx, dy, ev);
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      cleanup();
      ref.current.onEnd?.(moved, ev);
    };
    const cleanup = () => {
      win.removeEventListener('pointermove', onMove);
      win.removeEventListener('pointerup', onUp);
      win.removeEventListener('pointercancel', onUp);
    };
    const win = el.ownerDocument.defaultView ?? window;
    win.addEventListener('pointermove', onMove);
    win.addEventListener('pointerup', onUp);
    win.addEventListener('pointercancel', onUp);
  };
}
