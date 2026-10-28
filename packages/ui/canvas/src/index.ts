// @agentdeck/ui-canvas：白板（线 2）。组装方（apps/desktop）用 Workbench；widget 只用 './registry' 子路径。
export * from './registry.ts';
export { BoardController, SUMMARY_ZOOM, TYPING_MS, type BoardControllerOptions, type ViewportApi } from './controller.ts';
export { listGroups, dissolveGroups, type WindowGroup } from './model/groups.ts';
export { createBoardStore, type BoardStore, type BoardStoreState, type DialogState, type MenuState, type PendingFrame, type SettingsSection } from './store.ts';
export { Workbench, type LeftPanelContext, type PanelContext, type WorkbenchProps } from './react/Workbench.tsx';
export { Board } from './react/Board.tsx';
export { BoardProvider, useBoardState, useController } from './react/context.tsx';
export { useShortcuts } from './react/useShortcuts.ts';
export { matchShortcut, resolveShortcut, shouldHandle, textUndoTarget, jumpAgentRow, JUMP_AGENT_SHORTCUTS, SHORTCUT_LABELS, type JumpAgentShortcut, type ShortcutId } from './model/shortcuts.ts';
export { BoardHistory, HISTORY_LIMIT, type HistoryStep } from './model/history.ts';
export { summarize, nextWaiting, prevWaiting, waitingPosition, isWaiting, type AttentionSummary } from './model/attention.ts';
export { windowOrder, adjacentWindow } from './model/navigation.ts';
export { createAutosave, type Autosave } from './model/autosave.ts';
export { TERMINAL_TYPE, BROWSER_TYPE } from './model/windows.ts';
