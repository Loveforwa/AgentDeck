// 白板底部一行浅色的常用快捷键（像 vim 底部的提示）。只是提示：不挡鼠标；窗口窄时从后往前藏掉放不下的。
// 按键文字取自 SHORTCUT_LABELS，和菜单里显示的一致。

import type { ReactNode } from 'react';
import { SHORTCUT_LABELS } from '../model/shortcuts.ts';

/** 显示的顺序也是重要程度：放不下时先藏后面的。 */
export const SHORTCUT_HINTS: readonly { keys: string; label: string }[] = [
  { keys: SHORTCUT_LABELS['next-waiting'], label: 'next waiting' },
  { keys: `${SHORTCUT_LABELS['next-window']} ${SHORTCUT_LABELS['prev-window']}`, label: 'switch window' },
  { keys: SHORTCUT_LABELS['toggle-maximize'], label: 'maximize' },
  { keys: SHORTCUT_LABELS['new-terminal'], label: 'terminal' },
  { keys: SHORTCUT_LABELS['new-browser'], label: 'browser' },
  { keys: SHORTCUT_LABELS['toggle-panel'], label: 'panel' },
  { keys: SHORTCUT_LABELS['show-all'], label: 'show all' },
  { keys: SHORTCUT_LABELS['open-settings'], label: 'settings' },
];

export function ShortcutHints(): ReactNode {
  return (
    <div className="ad-shortcut-hints" role="note" aria-label="Keyboard shortcuts">
      {SHORTCUT_HINTS.map((h) => (
        <span className="ad-shortcut-hint" key={h.label}>
          <kbd>{h.keys}</kbd> {h.label}
        </span>
      ))}
    </div>
  );
}
