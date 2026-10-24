import { describe, expect, it } from 'vitest';
import { matchShortcut, resolveShortcut, type KeyLike } from '../src/model/shortcuts.ts';

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods });
const cmd = (k: string, mods: Partial<KeyLike> = {}) => key(k, { metaKey: true, ...mods });

describe('shortcuts (R1)', () => {
  it('maps the shortcut table', () => {
    expect(matchShortcut(cmd('n'))).toBe('new-terminal');
    expect(matchShortcut(cmd('t'))).toBe('new-browser');
    expect(matchShortcut(cmd('N', { shiftKey: true }))).toBe('new-workspace');
    expect(matchShortcut(cmd('w'))).toBe('close-window');
    expect(matchShortcut(cmd('Enter', { shiftKey: true }))).toBe('toggle-maximize');
    expect(matchShortcut(cmd('j'))).toBe('next-waiting');
    expect(matchShortcut(cmd('J', { shiftKey: true }))).toBe('prev-waiting');
    expect(matchShortcut(cmd('}', { shiftKey: true, code: 'BracketRight' }))).toBe('next-window');
    expect(matchShortcut(cmd('{', { shiftKey: true, code: 'BracketLeft' }))).toBe('prev-window');
    // 别的键盘布局下 key 不一定是 } {，按物理键认
    expect(matchShortcut(cmd('*', { shiftKey: true, code: 'BracketRight' }))).toBe('next-window');
    expect(matchShortcut(cmd('b'))).toBe('toggle-panel');
    expect(matchShortcut(cmd('0'))).toBe('zoom-100');
    expect(matchShortcut(cmd('1'))).toBe('show-all');
    expect(matchShortcut(cmd('k'))).toBe('clear-terminal');
    expect(matchShortcut(cmd('='))).toBe('zoom-in');
    expect(matchShortcut(cmd('-'))).toBe('zoom-out');
    expect(matchShortcut(key('Delete'))).toBe('delete-selection');
    expect(matchShortcut(key('Escape'))).toBe('escape');
  });

  it('ignores what is not ours', () => {
    expect(matchShortcut(cmd('c'))).toBeNull(); // 复制交给页面
    expect(matchShortcut(cmd('l'))).toBeNull(); // 网页窗口自己的
    expect(matchShortcut(cmd('Enter'))).toBeNull(); // 提交框自己的
    expect(matchShortcut(key('n'))).toBeNull();
    expect(matchShortcut(key('n', { ctrlKey: true }))).toBeNull(); // ⌃N 是终端的
    expect(matchShortcut(cmd('n', { altKey: true }))).toBeNull();
    // 不带 ⇧ 的 ⌘[ ⌘] 是网页窗口的后退前进，白板不拦
    expect(matchShortcut(cmd('[', { code: 'BracketLeft' }))).toBeNull();
    expect(matchShortcut(cmd(']', { code: 'BracketRight' }))).toBeNull();
    expect(matchShortcut(key('{', { shiftKey: true, code: 'BracketLeft' }))).toBeNull();
  });

  it('a focused terminal keeps every key without ⌘', () => {
    const ctx = { windowFocused: true, inEditable: false };
    for (const k of ['Escape', 'Delete', 'Backspace', 'Tab', ' ', 'y', 'ArrowUp']) {
      expect(resolveShortcut(key(k), ctx)).toBeNull();
    }
    expect(resolveShortcut(key('c', { ctrlKey: true }), ctx)).toBeNull();
    expect(resolveShortcut(cmd('j'), ctx)).toBe('next-waiting');
    expect(resolveShortcut(cmd('}', { shiftKey: true, code: 'BracketRight' }), ctx)).toBe('next-window');
    expect(resolveShortcut(cmd('w'), ctx)).toBe('close-window');
  });

  it('Delete and Esc work when nothing is focused, and never inside inputs', () => {
    expect(resolveShortcut(key('Delete'), { windowFocused: false, inEditable: false })).toBe('delete-selection');
    expect(resolveShortcut(key('Escape'), { windowFocused: false, inEditable: false })).toBe('escape');
    expect(resolveShortcut(key('Delete'), { windowFocused: false, inEditable: true })).toBeNull();
    expect(resolveShortcut(cmd('n'), { windowFocused: false, inEditable: true })).toBeNull();
  });

  it('uses Ctrl off macOS', () => {
    expect(matchShortcut(key('n', { ctrlKey: true }), false)).toBe('new-terminal');
    expect(matchShortcut(cmd('n'), false)).toBeNull();
  });
});
