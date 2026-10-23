// tmux 的 #{pane_dead_signal} 是信号名（“term”“kill”“hup”），不是数字（F7 问题 13）。
// contracts 的退出码按 128 + 信号编号算；编号取本机的（macOS 和 Linux 的 SIGUSR1 等不一样）。

import { constants } from 'node:os';

const SIGNALS = constants.signals as Record<string, number | undefined>;

/** “term” → 15；认不出时当作 SIGHUP（1）。 */
export function signalNumber(name: string): number {
  const trimmed = name.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const upper = trimmed.toUpperCase();
  return SIGNALS[upper.startsWith('SIG') ? upper : `SIG${upper}`] ?? SIGNALS.SIGHUP ?? 1;
}

/** 由 pane_dead_status / pane_dead_signal 算退出码。两个都空时返回 null（还活着）。 */
export function exitCodeOf(status: string, signal: string): number | null {
  if (status.trim() !== '') return Number(status.trim());
  if (signal.trim() !== '') return 128 + signalNumber(signal);
  return null;
}

/** kill-session 给进程发 SIGHUP，contracts 规定 kill() 发的退出码是 129。 */
export const KILLED_EXIT_CODE = 128 + (SIGNALS.SIGHUP ?? 1);
