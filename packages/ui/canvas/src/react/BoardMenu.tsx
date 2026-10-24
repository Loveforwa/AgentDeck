// 右键菜单（任务 B3）。空白处和框里：New terminal ▸、New browser、New workspace…、Add project…、Show all；
// 框的标题栏、窗口的标题栏各有自己的项。新建的东西放在右键的位置。

import { Menu, Popover, type MenuEntry } from '@agentdeck/ui-kit';
import type { AgentInfo, TerminalWindowData, WorkspaceId } from '@agentdeck/contracts';
import type { BoardController } from '../controller.ts';
import { startableAgents } from '../model/agents.ts';
import { SHORTCUT_LABELS } from '../model/shortcuts.ts';
import { BROWSER_TYPE, TERMINAL_TYPE, isTerminal } from '../model/windows.ts';
import type { MenuState } from '../store.ts';
import { useBoardState, useController, useWindowTypes } from './context.tsx';

export function BoardMenu() {
  const c = useController();
  const menu = useBoardState((s) => s.menu);
  // 菜单开着时才需要这些；它们变了菜单跟着更新
  useBoardState((s) => s.agents);
  useBoardState((s) => s.frames);
  const types = useWindowTypes();
  if (!menu) return null;
  const has = (type: string) => types.some((t) => t.type === type);
  const items = menuItems(c, menu, { terminal: has(TERMINAL_TYPE), browser: has(BROWSER_TYPE) });
  return (
    <Popover open anchor={menu.screen} chrome={false} autoFocus={false} onClose={() => c.closeMenu()}>
      <Menu items={items} aria-label="Board" onClose={() => c.closeMenu()} />
    </Popover>
  );
}

/** New terminal ▸ 的子菜单：已安装的 agent（显示 AgentInfo.label），Shell 放在分隔线后面。 */
export function terminalItems(agents: readonly AgentInfo[], onPick: (agent: AgentInfo['id']) => void): MenuEntry[] {
  const installed = startableAgents(agents);
  const named = installed.filter((a) => a.id !== 'shell');
  const shell = installed.find((a) => a.id === 'shell');
  const items: MenuEntry[] = named.map((a) => ({ id: `agent-${a.id}`, label: a.label || a.id, onSelect: () => onPick(a.id) }));
  if (shell) {
    if (items.length) items.push({ type: 'separator' });
    items.push({ id: 'agent-shell', label: shell.label || 'Shell', onSelect: () => onPick('shell') });
  }
  if (items.length === 0) items.push({ id: 'agent-none', label: 'No agents installed', disabled: true });
  return items;
}

export function menuItems(c: BoardController, menu: MenuState, available: { terminal: boolean; browser: boolean }): MenuEntry[] {
  const { target, flow } = menu;
  const s = c.state;
  const create = (ws: WorkspaceId | null, at: typeof flow | null): MenuEntry[] => [
    {
      id: 'new-terminal',
      label: 'New terminal',
      disabled: !available.terminal,
      items: terminalItems(s.agents, (agent) => void c.newTerminal({ agent, workspaceId: ws, at })),
    },
    {
      id: 'new-browser',
      label: 'New browser',
      shortcut: SHORTCUT_LABELS['new-browser'],
      disabled: !available.browser,
      onSelect: () => c.newBrowser({ workspaceId: ws, at }),
    },
  ];

  switch (target.kind) {
    case 'pane':
    case 'frame-body': {
      const ws = target.kind === 'frame-body' ? target.workspaceId : null;
      return [
        ...create(ws, flow),
        { id: 'new-workspace', label: 'New workspace…', shortcut: SHORTCUT_LABELS['new-workspace'], onSelect: () => c.openNewWorkspace({ at: flow }) },
        { id: 'add-project', label: 'Add project…', onSelect: () => void c.addProject(flow) },
        { type: 'separator' },
        { id: 'show-all', label: 'Show all', shortcut: SHORTCUT_LABELS['show-all'], onSelect: () => c.showAll() },
      ];
    }
    case 'frame-title': {
      const ws = target.workspaceId;
      const workspace = s.workspaces[ws];
      const path = workspace?.path;
      return [
        ...create(ws, null),
        { type: 'separator' },
        { id: 'open-editor', label: 'Open in editor', disabled: !path, onSelect: () => path && void c.api.app.openInEditor(path) },
        { id: 'reveal', label: 'Reveal in Finder', disabled: !path, onSelect: () => path && void c.api.app.revealInFinder(path) },
        { id: 'copy-path', label: 'Copy path', disabled: !path, onSelect: () => path && copyText(path) },
        { type: 'separator' },
        { id: 'rename', label: 'Rename…', onSelect: () => c.openDialog({ kind: 'rename-workspace', workspaceId: ws }) },
        { id: 'delete', label: 'Delete workspace…', onSelect: () => c.askRemoveWorkspace(ws) },
      ];
    }
    case 'window': {
      const w = c.windowById(target.windowId);
      if (!w) return [];
      const id = w.id;
      const items: MenuEntry[] = [
        { id: 'rename', label: 'Rename…', onSelect: () => c.openDialog({ kind: 'rename-window', windowId: id }) },
        {
          id: 'maximize',
          label: c.isMaximized(w) ? 'Restore' : 'Maximize',
          shortcut: SHORTCUT_LABELS['toggle-maximize'],
          onSelect: () => c.toggleMaximize(id),
        },
      ];
      // 窗口类型自己的菜单项（WindowTypeDefinition.menu），选中时作为 WindowCommand 发给窗口；例如终端的
      // Clear、Restart、Restart and resume conversation。“Open in system terminal” 白板下面已经有一项，不重复
      const own = (c.definitionOf(w)?.menu ?? []).filter((m) => m.id !== 'open-in-system-terminal');
      if (own.length > 0) {
        items.push(
          { type: 'separator' },
          ...own.map((m) => ({
            id: `window-${m.id}`,
            label: m.label,
            ...(m.shortcut ? { shortcut: m.shortcut } : {}),
            onSelect: () => void c.sendWindowCommand(id, m.id),
          })),
        );
      }
      if (isTerminal(w)) {
        const data = w.data as Partial<TerminalWindowData>;
        const others = s.frames.filter((f) => f.workspaceId !== w.workspaceId);
        items.push(
          { type: 'separator' },
          { id: 'copy-folder', label: 'Copy folder path', disabled: !data.cwd, onSelect: () => data.cwd && copyText(data.cwd) },
          {
            id: 'system-terminal',
            label: 'Open in system terminal',
            disabled: !data.terminalId,
            onSelect: () => data.terminalId && void c.api.app.openInSystemTerminal(data.terminalId),
          },
          {
            id: 'other-workspace',
            label: 'Open in another workspace',
            disabled: others.length === 0,
            items: others.map((f) => ({
              id: `ws-${f.workspaceId}`,
              label: c.workspaceTitle(f.workspaceId),
              onSelect: () => void c.openInWorkspace(id, f.workspaceId, null),
            })),
          },
        );
      }
      items.push({ type: 'separator' }, { id: 'close', label: 'Close', shortcut: SHORTCUT_LABELS['close-window'], onSelect: () => c.closeWindow(id) });
      return items;
    }
  }
}

function copyText(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => {});
}
