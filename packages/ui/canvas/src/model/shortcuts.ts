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
  | 'prev-waiting' // ⌘⇧J
  | 'next-window' // ⌘⇧]
  | 'prev-window' // ⌘⇧[
  | 'toggle-panel' // ⌘B
  | 'zoom-100' // ⌘0
  | 'show-all' // ⌘1
  | 'zoom-in' // ⌘=
  | 'zoom-out' // ⌘−
  | 'clear-terminal' // ⌘K
  | 'open-settings' // ⌘,
  | 'undo' // ⌘Z（X10：白板上的操作）
  | 'redo' // ⌘⇧Z
  | 'delete-selection' // Delete / Backspace
  | 'escape' // Esc
  | JumpAgentShortcut; // ⌥⌘1–9（CO4 / MP3：左边管理面板 NEEDS YOU 的第 1–9 行）

/** CO4 / MP3：⌥⌘1–9 跳到左边管理面板 NEEDS YOU 的第 n 行。 */
export type JumpAgentShortcut = `jump-agent-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;

export const JUMP_AGENT_SHORTCUTS: readonly JumpAgentShortcut[] = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `jump-agent-${n}` as JumpAgentShortcut);

/** jump-agent-3 → 3；别的快捷键 → null。 */
export function jumpAgentRow(id: ShortcutId): number | null {
  const m = /^jump-agent-([1-9])$/.exec(id);
  return m ? Number(m[1]) : null;
}

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
  /**
   * 焦点在编辑文字的地方，包括窗口里面的输入框（网页窗口的地址栏）和网页本身，但不包括终端（X10）：
   * 这时 ⌘Z / ⌘⇧Z 是文字的撤销，白板不拿。见 textUndoTarget。
   */
  inTextField?: boolean;
  /** macOS 用 ⌘，其他平台用 Ctrl。MVP 只支持 macOS，默认 true。 */
  mac?: boolean;
}

/** 键盘事件对应的快捷键；不是白板的快捷键返回 null。 */
export function matchShortcut(e: KeyLike, mac = true): ShortcutId | null {
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  // ⌥⌘1–9（CO4）。按住 ⌥ 时 key 是 ¡ ™ £ 之类（还随键盘布局变），按物理键认
  if (mod && e.altKey && !e.shiftKey) {
    const digit = /^Digit([1-9])$/.exec(e.code ?? '')?.[1] ?? (/^[1-9]$/.test(key) ? key : null);
    return digit ? (`jump-agent-${digit}` as JumpAgentShortcut) : null;
  }
  if (mod && !e.altKey) {
    if (e.shiftKey) {
      if (key === 'n') return 'new-workspace';
      if (key === 'Enter') return 'toggle-maximize';
      if (key === '+' || e.code === 'Equal') return 'zoom-in';
      if (key === 'j') return 'prev-waiting';
      if (key === 'z') return 'redo';
      // 按住 ⇧ 时 key 是 } {（还随键盘布局变），按物理键认。不带 ⇧ 的 ⌘] ⌘[ 是网页窗口的前进后退，不碰
      if (e.code === 'BracketRight' || key === '}') return 'next-window';
      if (e.code === 'BracketLeft' || key === '{') return 'prev-window';
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
      case 'z':
        return 'undo';
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
  if (id === 'undo' || id === 'redo') return !ctx.inTextField;
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
  'prev-waiting': '⌘⇧J',
  'next-window': '⌘⇧]',
  'prev-window': '⌘⇧[',
  'toggle-panel': '⌘B',
  'zoom-100': '⌘0',
  'show-all': '⌘1',
  'clear-terminal': '⌘K',
  'open-settings': '⌘,',
  undo: '⌘Z',
  redo: '⌘⇧Z',
} as const satisfies Partial<Record<ShortcutId, string>>;

const TEXT_FIELD = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]';

/**
 * ⌘Z 该不该当文字的撤销（X10）：焦点在输入框、文本框、contenteditable 里（窗口里面的也算，例如网页窗口的地址栏），
 * 或者在网页窗口的 iframe / webview 上。终端（xterm 的隐藏 textarea）不算：xterm.js 不把 ⌘ 组合键发给 shell
 * （终端的 keys.ts 把它们交给白板，和 ⌘K ⌘W 一样），所以终端聚焦时 ⌘Z 撤销白板上的操作（拖完窗口它就是聚焦的）。
 */
export function textUndoTarget(el: Element | null): boolean {
  if (!el || typeof el.closest !== 'function') return false;
  if (el.closest('.xterm')) return false;
  const tag = el.tagName;
  if (tag === 'IFRAME' || tag === 'WEBVIEW') return true;
  return el.closest(TEXT_FIELD) !== null;
}
