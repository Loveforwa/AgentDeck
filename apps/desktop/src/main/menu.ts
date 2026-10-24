// 应用菜单。
// - 白板的快捷键注册成菜单 accelerator，回调白板的 runShortcut（经 IPC 发给界面）：焦点在网页窗口的 iframe 里时，
//   按键到不了白板页面的 keydown 监听，只能靠菜单（canvas/CONTRACT_NOTES.md 第 7 条）。
//   焦点在白板页面里时，白板自己先处理并 preventDefault，菜单不会再触发；界面那边还按时间去一次重（见 renderer 的 menu-shortcuts）。
// - 不用 Electron 的默认菜单：它把 ⌘R 设成重载整个应用、⌘W 关掉应用窗口，⌘[ ⌘] ⌘L 也不能占（网页窗口自己用）。
// - 编辑菜单必须有：macOS 上没有 Edit 菜单的 copy / paste 角色，⌘C ⌘V 在页面里不起作用。

import type { MenuItemConstructorOptions } from 'electron';
import type { MenuShortcutId } from '../shared/desktop-bridge.ts';

export type { MenuShortcutId };


export const MENU_ACCELERATORS: Record<MenuShortcutId, string> = {
  'new-terminal': 'CmdOrCtrl+N',
  'new-browser': 'CmdOrCtrl+T',
  'new-workspace': 'Shift+CmdOrCtrl+N',
  'close-window': 'CmdOrCtrl+W',
  'toggle-maximize': 'Shift+CmdOrCtrl+Enter',
  'next-waiting': 'CmdOrCtrl+J',
  'prev-waiting': 'Shift+CmdOrCtrl+J',
  // 带 ⇧ 的方括号：不带 ⇧ 的 ⌘[ ⌘] 留给网页窗口（RESERVED_ACCELERATORS）
  'next-window': 'Shift+CmdOrCtrl+]',
  'prev-window': 'Shift+CmdOrCtrl+[',
  'toggle-panel': 'CmdOrCtrl+B',
  'zoom-100': 'CmdOrCtrl+0',
  'show-all': 'CmdOrCtrl+1',
  'zoom-in': 'CmdOrCtrl+=',
  'zoom-out': 'CmdOrCtrl+-',
  'clear-terminal': 'CmdOrCtrl+K',
};

/** 菜单里绝对不能出现的 accelerator（网页窗口和 Electron 默认行为要用）。 */
export const RESERVED_ACCELERATORS = ['CmdOrCtrl+R', 'CmdOrCtrl+[', 'CmdOrCtrl+]', 'CmdOrCtrl+L'];

export interface MenuActions {
  shortcut(id: MenuShortcutId): void;
  openSettings(): void;
  quit(stopTerminals: boolean): void;
  /** 只在开发时出现。 */
  dev: { reload(): void; toggleDevTools(): void } | null;
}

export function buildMenuTemplate(appName: string, actions: MenuActions): MenuItemConstructorOptions[] {
  const sc = (id: MenuShortcutId, label: string): MenuItemConstructorOptions => ({
    label,
    accelerator: MENU_ACCELERATORS[id],
    click: () => actions.shortcut(id),
  });
  const view: MenuItemConstructorOptions[] = [
    sc('toggle-panel', 'Toggle Side Panel'),
    sc('toggle-maximize', 'Maximize Window'),
    { type: 'separator' },
    sc('zoom-100', 'Actual Size'),
    sc('show-all', 'Show All'),
    sc('zoom-in', 'Zoom In'),
    sc('zoom-out', 'Zoom Out'),
    { type: 'separator' },
    sc('clear-terminal', 'Clear Terminal'),
  ];
  if (actions.dev) {
    const dev = actions.dev;
    view.push(
      { type: 'separator' },
      { label: 'Reload AgentDeck', accelerator: 'Alt+Shift+CmdOrCtrl+R', click: () => dev.reload() },
      { label: 'Toggle Developer Tools', accelerator: 'Alt+CmdOrCtrl+I', click: () => dev.toggleDevTools() },
    );
  }
  return [
    {
      label: appName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => actions.openSettings() },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { label: `Quit ${appName}`, accelerator: 'CmdOrCtrl+Q', click: () => actions.quit(false) },
        { label: 'Stop All Terminals and Quit', click: () => actions.quit(true) },
      ],
    },
    {
      label: 'File',
      submenu: [
        sc('new-terminal', 'New Terminal'),
        sc('new-browser', 'New Browser'),
        sc('new-workspace', 'New Workspace…'),
        { type: 'separator' },
        sc('close-window', 'Close Window'),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
      ],
    },
    { label: 'View', submenu: view },
    {
      label: 'Go',
      submenu: [
        sc('next-waiting', 'Next Waiting Terminal'),
        sc('prev-waiting', 'Previous Waiting Terminal'),
        { type: 'separator' },
        sc('next-window', 'Next Window'),
        sc('prev-window', 'Previous Window'),
      ],
    },
    {
      label: 'Window',
      role: 'window',
      // 不用 role: 'windowMenu'：它带 Close（⌘W）
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }],
    },
  ];
}
