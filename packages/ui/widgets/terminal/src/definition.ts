// 终端在窗口注册表里的条目（contracts 0.1.3 的 WindowTypeDefinition）。白板只读这些字段，不按 type 写特例。

import type { ComponentType } from 'react';
import type { TerminalWindowData, WindowComponentProps, WindowMenuItem, WindowTypeDefinition } from '@agentdeck/contracts';
import { termSizeFor } from './metrics.ts';
import { needsRestore, planRestore, restoreTerminal } from './restore.ts';
import { TerminalWindow } from './TerminalWindow.tsx';
import { commandName } from './title.ts';

export const TERMINAL_WINDOW_TYPE = 'terminal';

/**
 * 标题栏右键菜单里终端自己的项，选中时作为 WindowCommand 发给窗口。
 * Rename 由白板自己做（改的是 WindowNode.title，窗口改不了），这里不重复加。
 */
export const TERMINAL_MENU: WindowMenuItem[] = [
  { id: 'clear', label: 'Clear', shortcut: '⌘K' },
  { id: 'restart', label: 'Restart' },
  // agent 带着原来的会话 id 重启（claude --resume、codex resume）：对话接着，启动参数换成最新的
  // （例如 2026-10-24 加的 theme: auto）。没有会话 id（Shell、还没开始对话）时和 Restart 一样。
  { id: 'restart-resume', label: 'Restart and resume conversation' },
  { id: 'open-in-system-terminal', label: 'Open in system terminal' },
];

export type TerminalWindowDefinition = WindowTypeDefinition<TerminalWindowData, ComponentType<WindowComponentProps<TerminalWindowData>>>;

export const terminalWindowType: TerminalWindowDefinition = {
  type: TERMINAL_WINDOW_TYPE,
  label: 'Terminal',
  defaultSize: { w: 560, h: 360 },
  minSize: { w: 110, h: 60 },
  summaryBelow: { w: 320, h: 200 },
  component: TerminalWindow,
  create: (init) => ({
    terminalId: init.terminalId ?? null,
    agent: init.agent ?? 'shell',
    cmd: init.cmd ?? '',
    args: init.args ?? [],
    cwd: init.cwd ?? '',
    sessionId: init.sessionId ?? null,
    startCommand: init.startCommand ?? null,
    ...(init.lastCommand ? { lastCommand: init.lastCommand } : {}),
  }),
  pinnedToWorkspace: true,
  title: (data) => commandName(data),
  closeConfirm: (data) => {
    // 只拿得到 data，不知道进程是不是还活着；有终端就问（已退出的终端白板按状态直接关，见 CONTRACT_NOTES.md）
    if (!data.terminalId) return null;
    const name = commandName(data);
    return { title: `Close ${name}?`, body: `${name} will be stopped. This can’t be undone.`, confirm: 'Stop and close' };
  },
  onClose: async (data) => {
    if (!data.terminalId) return;
    await window.agentdeck.terminals.kill(data.terminalId).catch(() => {});
  },
  menu: TERMINAL_MENU,
  termSize: (content) => termSizeFor(content),
  // X6：白板启动时（和 tmux 服务没了之后）问每个终端要不要恢复，Restore all 时调 restore（见 restore.ts）
  restore: {
    describe: (data, live) => {
      if (!needsRestore(data, live)) return null;
      const { kind, label, detail, fresh } = planRestore(data);
      return { kind, label, detail, fresh };
    },
    restore: (data, ctx) => restoreTerminal(window.agentdeck, data, ctx),
  },
};
