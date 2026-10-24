// 白板手势的事件接线（N6，规则见 model/gestures.ts 和 AGENTS.md「行为要点」）。

import { useEffect, useState, type RefObject } from 'react';
import type { BoardController } from '../controller.ts';
import { isFrameElement, isZoomWheel, startsSpacePan, wheelZoomDelta, zoomAtPoint } from '../model/gestures.ts';

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/**
 * 按住空格：返回 true，白板加 `ad-board--space-pan`（CSS 让节点不接指针，拖哪里都落到 React Flow 的底板上平移）。
 * 键盘事件在冒泡阶段收：终端（xterm 的 textarea）、输入框、按钮、菜单、对话框里的空格不拿；网页里的按键本来就到不了这里。
 */
export function useSpacePan(): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    let down = false;
    const release = () => {
      if (!down) return;
      down = false;
      setHeld(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (down) {
        // 按住时的自动重复也不能落到别处（比如滚动、按钮）
        if (e.code === 'Space' || e.key === ' ') e.preventDefault();
        return;
      }
      if (e.defaultPrevented || !startsSpacePan(e, e.target instanceof Element ? e.target : null)) return;
      e.preventDefault();
      down = true;
      setHeld(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.key === ' ') release();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') release();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', release);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
  return held;
}

/**
 * 窗口上的捏合和 ⌘ + 滚轮也缩放白板。窗口节点是 `nowheel`，React Flow 不管，这里在捕获阶段先拿走，
 * 按 React Flow 同样的换算以指针为不动点缩放；终端收不到（它不用这两种滚轮）。空白处仍由 React Flow 处理。
 */
export function useWindowZoomWheel(wrapper: RefObject<HTMLElement | null>, c: BoardController): void {
  useEffect(() => {
    const el = wrapper.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!isZoomWheel(e)) return;
      const target = e.target instanceof Element ? e.target : null;
      if (!target?.closest('.ad-window-node')) return;
      e.preventDefault();
      e.stopPropagation();
      const r = el.getBoundingClientRect();
      const vp = c.state.viewport;
      const zoom = vp.zoom * Math.pow(2, wheelZoomDelta(e, IS_MAC));
      c.viewportChanged(zoomAtPoint(vp, { x: e.clientX - r.left, y: e.clientY - r.top }, zoom));
    };
    el.addEventListener('wheel', onWheel, { capture: true, passive: false });
    return () => el.removeEventListener('wheel', onWheel, { capture: true });
  }, [wrapper, c]);
}

/** 盖层让开多久（网页窗口：滚动事件进了 iframe / webview 我们看不到，只能按时间）。 */
export const COVER_PASS_MS = 600;
const passTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

/**
 * 没聚焦的窗口上盖着一层（第一下单击只聚焦）。滚轮落在盖层上时交给下面的内容（DR-53）：
 * - 下面是普通 DOM（终端）：照原样再派发一个 wheel 给它，xterm 的滚轮处理是 JS 做的，回滚、鼠标模式都认；盖层不动，单击还是只聚焦。
 *   没有人 preventDefault 时（不是 xterm 那样自己滚的内容），滚最近的 overflow 可滚动的祖先。
 * - 下面是 iframe / webview（网页）：事件进不去，盖层暂时不接指针（COVER_PASS_MS），接下来的滚动原生地进网页。
 */
export function passWheelToContent(cover: HTMLElement, e: WheelEvent): void {
  if (isZoomWheel(e)) return; // 缩放在 useWindowZoomWheel 里已经处理
  const prev = cover.style.pointerEvents;
  cover.style.pointerEvents = 'none';
  const under = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(e.clientX, e.clientY) : null;
  const scope = cover.parentElement;
  const inside = under && scope && scope.contains(under) && under !== cover ? under : null;
  if (inside && isFrameElement(inside)) {
    clearTimeout(passTimers.get(cover));
    passTimers.set(
      cover,
      setTimeout(() => {
        cover.style.pointerEvents = '';
        passTimers.delete(cover);
      }, COVER_PASS_MS),
    );
    return;
  }
  cover.style.pointerEvents = prev;
  if (!inside || !scope) return;
  const legacy = e as WheelEvent & { wheelDeltaX?: number; wheelDeltaY?: number };
  const init: WheelEventInit & { wheelDeltaX?: number; wheelDeltaY?: number } = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: e.view,
    deltaX: e.deltaX,
    deltaY: e.deltaY,
    deltaZ: e.deltaZ,
    deltaMode: e.deltaMode,
    clientX: e.clientX,
    clientY: e.clientY,
    screenX: e.screenX,
    screenY: e.screenY,
    shiftKey: e.shiftKey,
    altKey: e.altKey,
    buttons: e.buttons,
  };
  // Chromium 的非标准字段，xterm（VS Code 的 StandardWheelEvent）优先读它们
  if (typeof legacy.wheelDeltaX === 'number') init.wheelDeltaX = legacy.wheelDeltaX;
  if (typeof legacy.wheelDeltaY === 'number') init.wheelDeltaY = legacy.wheelDeltaY;
  // 没人处理（没有 preventDefault）：合成事件不会触发浏览器原生滚动，自己滚最近的可滚动的祖先（摘要卡、只用 overflow 的内容）
  if (inside.dispatchEvent(new WheelEvent('wheel', init))) scrollNearest(inside, scope, e);
}

/** 从 el 往上到 scope（含）找能在这个方向滚的元素，按滚轮的量滚它。 */
function scrollNearest(el: Element, scope: Element, e: WheelEvent): void {
  const unit = e.deltaMode === 1 ? 16 : 1;
  for (let cur: Element | null = el; cur; cur = cur === scope ? null : cur.parentElement) {
    if (!(cur instanceof HTMLElement)) continue;
    const page = e.deltaMode === 2;
    const dx = e.deltaX * (page ? cur.clientWidth : unit);
    const dy = e.deltaY * (page ? cur.clientHeight : unit);
    const style = getComputedStyle(cur);
    const canY = dy !== 0 && /(auto|scroll|overlay)/.test(style.overflowY) && cur.scrollHeight > cur.clientHeight;
    const canX = dx !== 0 && /(auto|scroll|overlay)/.test(style.overflowX) && cur.scrollWidth > cur.clientWidth;
    if (canY || canX) {
      if (canY) cur.scrollTop += dy;
      if (canX) cur.scrollLeft += dx;
      return;
    }
  }
}
