// 窗口外框（任务 B2）：只管样子和手势，位置、层级、聚焦由白板（@agentdeck/ui-canvas）决定。
export { WindowShell, StatusDot, TITLE_BAR_HEIGHT, type WindowShellProps } from './WindowShell.tsx';
export { moveRect, resizeRect, RESIZE_EDGES, type ResizeEdge } from './geometry.ts';
export { usePointerDrag, type DragHandlers } from './usePointerDrag.ts';
