// X10：Edit › Undo / Redo 不再用系统的 role：发给界面，焦点在白板（或终端）上时撤销白板上的操作，
// 在输入框、网页、对话框里时请主进程做系统的 undo / redo（文字的撤销照旧）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildMenuTemplate, MENU_ACCELERATORS } from '../src/main/menu.ts';
import type { DesktopBridge, MenuShortcutId } from '../src/shared/desktop-bridge.ts';

type Item = { label?: string; accelerator?: string; role?: string; submenu?: Item[]; click?: () => void };

describe('Edit menu', () => {
  it('Undo / Redo are board shortcuts (⌘Z / ⌘⇧Z) instead of the system roles; cut / copy / paste stay system roles', () => {
    const shortcut = vi.fn();
    const template = buildMenuTemplate('AgentDeck', { shortcut, quit: vi.fn(), dev: null }) as Item[];
    const edit = template.find((m) => m.label === 'Edit')!.submenu!;
    expect(edit.slice(0, 2).map((i) => [i.label, i.accelerator, i.role])).toEqual([
      ['Undo', 'CmdOrCtrl+Z', undefined],
      ['Redo', 'Shift+CmdOrCtrl+Z', undefined],
    ]);
    expect(edit.some((i) => i.role === 'undo' || i.role === 'redo')).toBe(false);
    expect(edit.filter((i) => i.role).map((i) => i.role)).toEqual(['cut', 'copy', 'paste', 'pasteAndMatchStyle', 'delete', 'selectAll']);
    edit[0]!.click!();
    edit[1]!.click!();
    expect(shortcut.mock.calls).toEqual([['undo'], ['redo']]);
    expect(MENU_ACCELERATORS.undo).toBe('CmdOrCtrl+Z');
  });
});

const RENDERER_MENU_SHORTCUTS = '../src/renderer/src/menu-shortcuts.ts';

type KeyLike = { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean };

// 界面那边的分流（menu-shortcuts.ts）：node 环境里给一个最小的 window / document
describe('menu Undo / Redo routing in the renderer', () => {
  let active: { closest: (sel: string) => unknown; tagName: string } | null;
  const listeners: ((e: KeyLike) => void)[] = [];
  beforeEach(() => {
    active = null;
    listeners.length = 0;
    vi.stubGlobal('window', { addEventListener: (_t: string, l: (e: KeyLike) => void) => listeners.push(l) });
    vi.stubGlobal('document', {
      get activeElement() {
        return active;
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  /** 一个只认得几种选择器的假元素：inside 里的选择器和它自己的标签名算匹配。 */
  const element = (tagName: string, inside: string[] = []) => ({
    tagName,
    closest: (sel: string) =>
      sel.split(',').some((s) => inside.includes(s.trim()) || s.trim().toLowerCase() === tagName.toLowerCase()) ? {} : null,
  });

  async function install() {
    // 路径放在变量里：tsconfig.node.json 不带 jsx，不让 tsc 顺着它去查界面包（类型检查由 tsconfig.web.json 管）
    const { installMenuShortcuts } = (await import(/* @vite-ignore */ RENDERER_MENU_SHORTCUTS)) as {
      installMenuShortcuts(controller: unknown, desktop: DesktopBridge): void;
    };
    let onShortcut: (id: MenuShortcutId) => void = () => {};
    const nativeEdit = vi.fn();
    const desktop = {
      onShortcut: (l: (id: MenuShortcutId) => void) => {
        onShortcut = l;
      },
      nativeEdit,
    } as unknown as DesktopBridge;
    const controller = { state: { dialog: null as unknown, focusedId: null }, runShortcut: vi.fn(() => true), sendWindowCommand: vi.fn() };
    installMenuShortcuts(controller as never, desktop);
    return { fire: (id: MenuShortcutId) => onShortcut(id), nativeEdit, controller };
  }

  it('on the board: the board undoes', async () => {
    const { fire, nativeEdit, controller } = await install();
    active = element('BODY');
    fire('undo');
    fire('redo');
    expect(controller.runShortcut.mock.calls).toEqual([['undo'], ['redo']]);
    expect(nativeEdit).not.toHaveBeenCalled();
  });

  it('in a terminal (xterm’s textarea): still the board', async () => {
    const { fire, controller } = await install();
    active = element('TEXTAREA', ['.xterm', '.ad-window-content']);
    fire('undo');
    expect(controller.runShortcut).toHaveBeenCalledWith('undo');
  });

  it('in a text field, a web page or with a dialog open: the system undo', async () => {
    const { fire, nativeEdit, controller } = await install();
    active = element('INPUT');
    fire('undo');
    active = element('IFRAME', ['.ad-window-content']);
    fire('redo');
    active = element('BODY');
    controller.state.dialog = { kind: 'settings' };
    fire('undo');
    expect(nativeEdit.mock.calls).toEqual([['undo'], ['redo'], ['undo']]);
    expect(controller.runShortcut).not.toHaveBeenCalled();
  });

  it('a ⌘Z the board just handled from the keyboard is not done twice', async () => {
    const { fire, controller } = await install();
    active = element('BODY');
    for (const l of listeners) l({ key: 'z', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false });
    fire('undo');
    expect(controller.runShortcut).not.toHaveBeenCalled();
  });
});
