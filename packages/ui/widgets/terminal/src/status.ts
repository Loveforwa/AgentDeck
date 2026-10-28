// 标题栏右侧的状态文字和点（需求「6 · 终端状态与提醒」）。数据来自 status.changed，按 terminalId 对上。
// CO4：一轮结束后还没看过时 idle 写 “Idle · Unseen · now”（聚焦就清，由白板记在 TerminalWindowData.unseen）。
// 时间写法：不到 1 分钟 “now”，不到 1 小时 “4m”，不到 1 天 “2h”，更早写日期 “Oct 21”。

import type { StatusSnapshot, WindowStatusBadge } from '@agentdeck/contracts';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatSince(since: string, now: number): string {
  const t = Date.parse(since);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  const d = new Date(t);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

export interface BadgeOptions {
  /** CO4：一轮结束后还没看过（TerminalWindowData.unseen）。只在 idle 时显示：“Idle · Unseen · now”，只改文字不加颜色。 */
  unseen?: boolean;
}

export function badgeFor(snap: Pick<StatusSnapshot, 'status' | 'since' | 'exitCode'>, now: number, opts: BadgeOptions = {}): WindowStatusBadge {
  const t = formatSince(snap.since, now);
  const withTime = (text: string) => (t ? `${text} · ${t}` : text);
  switch (snap.status) {
    case 'starting':
      return { text: 'Starting', tone: 'muted', dot: 'hollow' };
    // MVP v2 · V2 红绿灯：等批准、等回答都写 Waiting（黄），悬停看是哪一种
    case 'running':
      return { text: withTime('Running'), tone: 'running', dot: 'filled' };
    case 'needs-approval':
      return { text: withTime('Waiting'), tone: 'attention', dot: 'filled', detail: 'Needs approval' };
    case 'needs-reply':
      return { text: withTime('Waiting'), tone: 'attention', dot: 'filled', detail: 'Needs reply' };
    case 'idle':
      return { text: withTime(opts.unseen ? 'Idle · Unseen' : 'Idle'), tone: 'muted', dot: 'hollow' };
    case 'exited':
      return { text: 'Exited', tone: 'muted', dot: 'none' };
    case 'error':
      return { text: snap.exitCode === null ? 'Error' : `Error · exit ${snap.exitCode}`, tone: 'error', dot: 'filled' };
  }
}

/** 进程退出时（没有状态机的情况下也要有）标题栏的状态。 */
export function exitBadge(code: number): WindowStatusBadge {
  return code === 0 ? { text: 'Exited', tone: 'muted', dot: 'none' } : { text: `Error · exit ${code}`, tone: 'error', dot: 'filled' };
}

/** 退出提示条的文字。 */
export function exitMessage(code: number): string {
  return code === 0 ? 'Process exited' : `Process exited (code ${code})`;
}
