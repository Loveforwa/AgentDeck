import { useEffect } from 'react';
import type { BoardController } from '../controller.ts';
import { resolveShortcut, textUndoTarget } from '../model/shortcuts.ts';


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
      // ⌘Z / ⌘⇧Z（X10）：在输入框、网页里是文字的撤销；在白板上和终端里撤销白板上的操作
      const id = resolveShortcut(e, { windowFocused: s.focusedId !== null, inEditable, inTextField: textUndoTarget(el) });
      if (!id) return;
      if (!c.runShortcut(id)) return;
      e.preventDefault();
      e.stopPropagation();
      // ⌘K 交给聚焦的窗口（WindowComponentProps.onCommand）
      if (id === 'clear-terminal' && s.focusedId) c.sendWindowCommand(s.focusedId, 'clear');
    };
    target.addEventListener('keydown', onKeyDown, true);
    return () => target.removeEventListener('keydown', onKeyDown, true);
  }, [c, target]);
}
