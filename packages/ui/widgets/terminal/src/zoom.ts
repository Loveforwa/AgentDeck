// IS-82：白板用 CSS transform 缩放窗口。xterm 换算鼠标位置时，元素位置用缩放后的 getBoundingClientRect，
// 格子宽高用没缩放的 CSS 尺寸，白板不在 100% 时点链接、拖选、双击都会偏（缩小时偏到上一行、左边）。
// xterm 的选字、链接、鼠标上报（tmux 的拖选）都走同一个 MouseService：这里把 clientX / clientY 按缩放比
// 换回没缩放的坐标再交给它。用到 xterm 的内部字段 _core._mouseService，升级 xterm 时要核对（6.0.0 核对过）。

import type { Terminal } from '@xterm/xterm';

interface Point {
  clientX: number;
  clientY: number;
}

interface MouseServiceLike {
  getCoords(event: Point, element: HTMLElement, colCount: number, rowCount: number, isSelection?: boolean): [number, number] | undefined;
  getMouseReportCoords(event: MouseEvent, element: HTMLElement): unknown;
}

/** 元素现在被缩放了多少倍（画出来的宽 ÷ 排版的宽）。量不出来时当 1。 */
export function scaleOf(el: HTMLElement): number {
  const layout = el.offsetWidth;
  if (layout <= 0) return 1;
  const s = el.getBoundingClientRect().width / layout;
  return Number.isFinite(s) && s > 0 ? s : 1;
}

/** 屏幕上的一点 → 元素没缩放时它该在的屏幕坐标（以元素左上角为原点按缩放比还原）。100% 时原样返回。 */
export function unscaledPoint<T extends Point>(event: T, el: HTMLElement): T | Point {
  const s = scaleOf(el);
  if (Math.abs(s - 1) < 1e-3) return event;
  const rect = el.getBoundingClientRect();
  return { clientX: rect.left + (event.clientX - rect.left) / s, clientY: rect.top + (event.clientY - rect.top) / s };
}

/** 让 xterm 换算鼠标位置时算进白板的缩放。open() 之后调；找不到内部字段（xterm 改了）时什么也不做，返回 false。 */
export function fixMouseForZoom(term: Terminal): boolean {
  const ms = (term as unknown as { _core?: { _mouseService?: MouseServiceLike } })._core?._mouseService;
  if (ms === undefined || typeof ms.getCoords !== 'function' || typeof ms.getMouseReportCoords !== 'function') return false;
  const getCoords = ms.getCoords.bind(ms);
  const getMouseReportCoords = ms.getMouseReportCoords.bind(ms);
  ms.getCoords = (event, element, colCount, rowCount, isSelection) =>
    getCoords(unscaledPoint(event, element), element, colCount, rowCount, isSelection);
  // 原实现只读 clientX / clientY
  ms.getMouseReportCoords = (event, element) => getMouseReportCoords(unscaledPoint(event, element) as MouseEvent, element);
  return true;
}
