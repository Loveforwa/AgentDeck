// @agentdeck/ui-canvas：白板（线 2）。组装方（apps/desktop）用 Workbench；widget 只用 './registry' 子路径。
export * from './registry.ts';
export { BoardController, SUMMARY_ZOOM, type BoardControllerOptions, type ViewportApi } from './controller.ts';
export { createBoardStore, type BoardStore, type BoardStoreState, type DialogState, type MenuState, type PendingFrame } from './store.ts';
export { Workbench, type PanelContext, type WorkbenchProps } from './react/Workbench.tsx';
export { Board } from './react/Board.tsx';
export { BoardProvider, useBoardState, useController } from './react/context.tsx';
export { useShortcuts } from './react/useShortcuts.ts';
export { matchShortcut, resolveShortcut, shouldHandle, SHORTCUT_LABELS, type ShortcutId } from './model/shortcuts.ts';
export { summarize, nextWaiting, isWaiting, type AttentionSummary } from './model/attention.ts';
export { createAutosave, type Autosave } from './model/autosave.ts';
export { TERMINAL_TYPE, BROWSER_TYPE } from './model/windows.ts';
