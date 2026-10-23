// 聚焦时的按键怎么分（T3）：不带 ⌘ 的全部交给终端；⌘C / ⌘V 走系统复制粘贴；其余 ⌘ 组合留给白板和应用菜单。

/** Shift+Enter：xterm.js 6 默认发 \r，claude、codex 都要 CSI u 才当换行（AGENTS.md 问题 10）。 */
export const SHIFT_ENTER = '\x1b[13;2u';

export type KeyDecision =
  /** 交给 xterm 正常处理。 */
  | { kind: 'terminal' }
  /** xterm 不处理，替它往终端发这些字节。 */
  | { kind: 'send'; data: string }
  /** xterm 不处理，也不阻止浏览器默认行为（⌘C / ⌘V 由浏览器触发 copy / paste 事件，xterm 自己接）。 */
  | { kind: 'native' }
  /** xterm 不处理，冒泡给白板（⌘K、⌘W、⌘J……）。 */
  | { kind: 'board' };

export interface KeyLike {
  type: string;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export function decideKey(e: KeyLike, isMac: boolean): KeyDecision {
  // ⌘；其他系统上是 Ctrl+Shift（MVP 只支持 macOS，留着方便在 Linux 上开发）
  const cmd = e.metaKey || (!isMac && e.ctrlKey && e.shiftKey);
  if (cmd) {
    const k = e.key.toLowerCase();
    if (k === 'c' || k === 'v') return { kind: 'native' };
    return { kind: 'board' };
  }
  if (e.key === 'Enter' && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
    // keypress / keyup 也不能交给 xterm，否则还会再发一个 \r
    return e.type === 'keydown' ? { kind: 'send', data: SHIFT_ENTER } : { kind: 'native' };
  }
  return { kind: 'terminal' };
}

/** 从访达拖进来的文件：每个路径加单引号（里面的单引号转义），空格隔开，末尾留一个空格。 */
export function quotePaths(paths: string[]): string {
  if (paths.length === 0) return '';
  return `${paths.map((p) => `'${p.replace(/'/g, `'\\''`)}'`).join(' ')} `;
}
