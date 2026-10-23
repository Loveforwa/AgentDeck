import { useEffect } from 'react';
import type { BoardController } from '../controller.ts';
import { resolveShortcut } from '../model/shortcuts.ts';

/** 窗口组件收到的白板命令（contracts 里还没有对应的 prop，见 CONTRACT_NOTES.md）。目前只有 ⌘K 的 clear。 */
export const WINDOW_COMMAND_EVENT = 'agentdeck:window-command';
export interface WindowCommandDetail {
  command: 'clear';
}

const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="dialog"], [role="menu"]';

/**
 * 全局快捷键（任务 R1）。捕获阶段监听，带 ⌘ 的组合先于终端拿到；不带 ⌘ 的只在没有窗口聚焦时处理，所以不会抢终端的按键。
 * 焦点在白板窗口的内容里（终端的 textarea）不算“在输入框里”。
 */
export function useShortcuts(c: BoardController, target: Window | null = typeof window === 'undefined' ? null : window): void {
  useEffect(() => {
    if (!target) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const el = e.target instanceof Element ? e.target : null;
      const inWindow = !!el?.closest('.ad-window-content');
      const inEditable = !inWindow && !!el?.closest(EDITABLE);
      const s = c.state;
      if (s.dialog) return;
      const id = resolveShortcut(e, { windowFocused: s.focusedId !== null, inEditable });
      if (!id) return;
      if (!c.runShortcut(id)) return;
      e.preventDefault();
      e.stopPropagation();
      if (id === 'clear-terminal' && s.focusedId) {
        const content = target.document.querySelector(`[data-window-id="${s.focusedId}"] .ad-window-content`);
        content?.dispatchEvent(new CustomEvent<WindowCommandDetail>(WINDOW_COMMAND_EVENT, { detail: { command: 'clear' } }));
      }
    };
    target.addEventListener('keydown', onKeyDown, true);
    return () => target.removeEventListener('keydown', onKeyDown, true);
  }, [c, target]);
}
