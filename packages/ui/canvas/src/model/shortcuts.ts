// 快捷键（任务 R1）。表见需求「10 · 全局规则」。
// 终端聚焦时，所有不带 ⌘ 的按键都交给终端，所以应用自己的快捷键都带 ⌘；
// 不带 ⌘ 的 Delete、Esc 只在没有窗口聚焦时由白板处理。

export type ShortcutId =
  | 'new-terminal' // ⌘N
  | 'new-browser' // ⌘T
  | 'new-workspace' // ⌘⇧N
  | 'close-window' // ⌘W
  | 'toggle-maximize' // ⌘⇧↩
  | 'next-waiting' // ⌘J
  | 'toggle-panel' // ⌘B
  | 'zoom-100' // ⌘0
  | 'show-all' // ⌘1
  | 'zoom-in' // ⌘=
  | 'zoom-out' // ⌘−
  | 'clear-terminal' // ⌘K
  | 'open-settings' // ⌘,
  | 'delete-selection' // Delete / Backspace
  | 'escape'; // Esc

export interface KeyLike {
  key: string;
  /** 物理键，按住 ⇧ 时 key 会变（⌘⇧= 之类），用它兜底。 */
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export interface ShortcutContext {
  /** 有窗口聚焦（按键默认交给它）。 */
  windowFocused: boolean;
  /** 焦点在输入框、对话框或菜单里。 */
  inEditable: boolean;
  /** macOS 用 ⌘，其他平台用 Ctrl。MVP 只支持 macOS，默认 true。 */
  mac?: boolean;
}

/** 键盘事件对应的快捷键；不是白板的快捷键返回 null。 */
export function matchShortcut(e: KeyLike, mac = true): ShortcutId | null {
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (mod && !e.altKey) {
    if (e.shiftKey) {
      if (key === 'n') return 'new-workspace';
      if (key === 'Enter') return 'toggle-maximize';
      if (key === '+' || e.code === 'Equal') return 'zoom-in';
      return null;
    }
    switch (key) {
      case 'n':
        return 'new-terminal';
      case 't':
        return 'new-browser';
      case 'w':
        return 'close-window';
      case 'j':
        return 'next-waiting';
      case 'b':
        return 'toggle-panel';
      case '0':
        return 'zoom-100';
      case '1':
        return 'show-all';
      case '=':
      case '+':
        return 'zoom-in';
      case '-':
        return 'zoom-out';
      case 'k':
        return 'clear-terminal';
      case ',':
        return 'open-settings';
    }
    return null;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (key === 'Delete' || key === 'Backspace') return 'delete-selection';
  if (key === 'Escape') return 'escape';
  return null;
}

/**
 * 白板该不该处理这个快捷键。带 ⌘ 的在终端聚焦时也处理（不会和终端抢）；
 * 不带 ⌘ 的只在没有窗口聚焦、焦点也不在输入框里时处理。焦点在对话框、输入框里时 ⌘ 快捷键也交给它们。
 */
export function shouldHandle(id: ShortcutId, ctx: ShortcutContext): boolean {
  // ⌘, 在输入框里也打开 Settings（输入框不用它）；对话框开着时 useShortcuts 整个不处理
  if (id === 'open-settings') return true;
  if (ctx.inEditable) return false;
  if (id === 'delete-selection' || id === 'escape') return !ctx.windowFocused;
  return true;
}

/** 白板实际处理的按键：matchShortcut + shouldHandle。 */
export function resolveShortcut(e: KeyLike, ctx: ShortcutContext): ShortcutId | null {
  const id = matchShortcut(e, ctx.mac ?? true);
  return id && shouldHandle(id, ctx) ? id : null;
}

/** 菜单里显示的快捷键文字。 */
export const SHORTCUT_LABELS = {
  'new-terminal': '⌘N',
  'new-browser': '⌘T',
  'new-workspace': '⌘⇧N',
  'close-window': '⌘W',
  'toggle-maximize': '⌘⇧↩',
  'next-waiting': '⌘J',
  'toggle-panel': '⌘B',
  'zoom-100': '⌘0',
  'show-all': '⌘1',
  'clear-terminal': '⌘K',
  'open-settings': '⌘,',
} as const satisfies Partial<Record<ShortcutId, string>>;
