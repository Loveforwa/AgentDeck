// 白板的平移和缩放手势（N6，IS-59，调研 DR-53）。规则：
// - 两指滚动在任何窗口上（聚焦不聚焦都一样）都给窗口内容（终端回滚、网页），不平移白板；在空白处平移白板。
// - 双指捏合缩放白板，⌘ + 滚轮也缩放；在窗口上也一样（白板自己算，见 Board 的 useWindowZoomWheel）。
// - 按住空格拖动平移白板；焦点在终端、输入框、网页里时空格照常输入，白板不拿。
// - 左键 / 中键拖空白处平移。
// 这里是纯函数和 React Flow 的那几个参数，事件接线在 react/gestures.ts。

import type { Viewport } from '@agentdeck/contracts';
import { clampZoom, type Point } from './geometry.ts';

/** 给 <ReactFlow> 的手势参数。窗口节点另外带 `nopan nowheel` 类（Board.tsx）。 */
export const FLOW_GESTURES = {
  panOnScroll: true,
  zoomOnScroll: false,
  zoomOnPinch: true,
  zoomActivationKeyCode: 'Meta',
  zoomOnDoubleClick: false,
  panOnDrag: [0, 1],
  // 空格平移我们自己做（useSpacePan）：React Flow 自带的会在终端里吞掉 Shift+空格，而且窗口上拖不动
  panActivationKeyCode: null,
} as const;

/** 窗口节点的类名：React Flow 在上面不拖动平移（nopan）、不滚动平移（nowheel）。 */
export const WINDOW_NODE_CLASS = 'nopan nowheel';

/** 和 React Flow（@xyflow/system 的 wheelDelta）一样的换算：返回 log2 缩放量。Mac 上捏合（ctrlKey）放大 10 倍。 */
export function wheelZoomDelta(e: Pick<WheelEvent, 'deltaY' | 'deltaMode' | 'ctrlKey'>, isMac: boolean): number {
  const factor = e.ctrlKey && isMac ? 10 : 1;
  const unit = e.deltaMode === 1 ? 0.05 : e.deltaMode ? 1 : 0.002;
  return -e.deltaY * unit * factor;
}

/** 以 point（相对白板左上角的屏幕坐标）为不动点改缩放比例。 */
export function zoomAtPoint(vp: Viewport, point: Point, zoom: number): Viewport {
  const z = clampZoom(zoom);
  const fx = (point.x - vp.x) / vp.zoom;
  const fy = (point.y - vp.y) / vp.zoom;
  return { x: point.x - fx * z, y: point.y - fy * z, zoom: z };
}

/** 这次滚轮是不是缩放白板：捏合（macOS 给 ctrlKey）或 ⌘ + 滚轮。 */
export function isZoomWheel(e: Pick<WheelEvent, 'ctrlKey' | 'metaKey'>): boolean {
  return e.ctrlKey || e.metaKey;
}

/** 内容在另一个文档里的元素：滚轮转发不进去，只能让盖层暂时让开。 */
export function isFrameElement(el: Element | null): boolean {
  const tag = el?.tagName;
  return tag === 'IFRAME' || tag === 'WEBVIEW';
}

/** 空格在这个元素上有自己的用处（打字、按按钮、菜单和对话框里）：白板不拿。 */
export function spaceBelongsTo(el: Element | null): boolean {
  if (!el || typeof el.closest !== 'function') return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || tag === 'A' || isFrameElement(el)) return true;
  return (
    el.closest(
      '.xterm, .nokey, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [role="textbox"], .ad-popover, .ad-dialog',
    ) !== null
  );
}

/** 按下的是不是“开始空格平移”：单独的空格（不带修饰键、不在输入法组字中），目标不是要用空格的元素。 */
export function startsSpacePan(
  e: Pick<KeyboardEvent, 'code' | 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'isComposing'>,
  target: Element | null,
): boolean {
  if (e.code !== 'Space' && e.key !== ' ') return false;
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.isComposing) return false;
  return !spaceBelongsTo(target);
}
