// 应用菜单的快捷键（主进程 src/main/menu.ts）回到白板的 runShortcut。
//
// 焦点在网页窗口的 iframe 里时按键到不了白板页面，只能靠菜单 accelerator；焦点在白板页面里时白板自己先处理。
// 为了不执行两次：白板页面上刚看到同一个组合键（500ms 内），菜单这次就不管——白板已经按自己的规则处理过（或者决定不处理）。
// 其余判断和白板的 useShortcuts 一样：有对话框时不管，焦点在输入框里时不管（窗口内容里的不算）。
// Edit › Undo / Redo（X10）：焦点在输入框、网页里（或有对话框）时是文字的撤销，请主进程做系统的 undo / redo；
// 否则撤销白板上的操作（终端聚焦时也是，xterm 不把 ⌘Z 发给 shell）。

import { matchShortcut, shouldHandle, textUndoTarget, type BoardController, type ShortcutId } from '@agentdeck/ui-canvas';
import type { DesktopBridge, MenuShortcutId } from '../../shared/desktop-bridge.ts';

const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="dialog"], [role="menu"]';
const DEDUPE_MS = 500;

export function installMenuShortcuts(controller: BoardController, desktop: DesktopBridge): void {
  const seenAt = new Map<ShortcutId, number>();
  window.addEventListener(
    'keydown',
    (e) => {
      const id = matchShortcut(e);
      if (id) seenAt.set(id, performance.now());
    },
    true,
  );

  desktop.onShortcut((id: MenuShortcutId) => {
    const s = controller.state;
    const el = document.activeElement;
    const inWindow = !!el?.closest('.ad-window-content');
    // 焦点在 iframe 上时 activeElement 是 iframe 本身（在窗口内容里）
    const inEditable = !inWindow && !!el?.closest(EDITABLE);
    if (id === 'undo' || id === 'redo') {
      // 文字的撤销：键盘上的 ⌘Z 白板没拿（没 preventDefault），菜单才会收到，所以这里不用去重
      if (s.dialog || inEditable || textUndoTarget(el)) return desktop.nativeEdit(id);
    }
    const t = seenAt.get(id);
    if (t !== undefined && performance.now() - t < DEDUPE_MS) return;
    if (s.dialog) return;
    if (!shouldHandle(id, { windowFocused: s.focusedId !== null, inEditable })) return;
    if (!controller.runShortcut(id)) return;
    if (id === 'clear-terminal' && s.focusedId) controller.sendWindowCommand(s.focusedId, 'clear');
  });
}
