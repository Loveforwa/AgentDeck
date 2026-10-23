// 标题栏上的名字：agent 名（claude、codex），Shell 和自定义命令用命令名（zsh、pnpm）。

import type { TerminalWindowData } from '@agentdeck/contracts';

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

export function commandName(d: Pick<TerminalWindowData, 'agent' | 'cmd' | 'startCommand'>): string {
  if (d.agent !== 'shell' && d.agent !== 'custom' && d.agent) return d.agent;
  if (d.agent === 'custom' && d.startCommand) return d.startCommand.trim().split(/\s+/)[0] ?? d.startCommand;
  // 登录 shell 有时以 “-zsh” 的形式出现
  const name = basename(d.cmd || '').replace(/^-/, '');
  return name || (d.agent === 'shell' ? 'shell' : 'terminal');
}
