// S4 后台通知的规则：状态变了，该不该发系统通知、程序坞角标是几。纯函数，不碰 Electron。
// 真正调 Notification 和 app.dock.setBadge / AppService.setBadge 在组装阶段（apps/desktop）做。
//
// 规则（需求「6 · 终端状态与提醒」的提醒规则）：
// - 只有“在等你”（needs-approval、needs-reply）才发通知；同一条请求只发一次。
// - 应用在前台时不发（窗口、框、顶栏已经在提示）；Settings 的 notifications 关掉时也不发。
// - 角标 = 在等你的终端数；应用在前台时为 0（清除）。
// - 单击通知跳到那个终端：通知里带 terminalId，组装时转成 app.focus-terminal 事件。

import { WAITING_STATUSES } from '@agentdeck/contracts';
import type { StatusSnapshot, TerminalId } from '@agentdeck/contracts';

export interface SystemNotification {
  terminalId: TerminalId;
  /** 英文，例如 "claude needs approval"。 */
  title: string;
  /** 英文原文，例如 "pnpm test"。 */
  body: string;
}

export interface AlertInput {
  /** 变化前的状态；新终端为 null。 */
  prev: StatusSnapshot | null;
  next: StatusSnapshot;
  /** 所有终端当前的状态（含 next），用来算角标。 */
  all: readonly StatusSnapshot[];
  appFocused: boolean;
  /** Settings.notifications。 */
  notificationsEnabled: boolean;
  /** 通知标题里怎么称呼这个终端，例如 "claude"、"lead · api-server"。由组装方按窗口名和工作区拼。 */
  label: string;
}

export interface AlertOutput {
  notification: SystemNotification | null;
  badge: number;
}

export function isWaiting(s: StatusSnapshot): boolean {
  return WAITING_STATUSES.includes(s.status);
}

export function badgeCount(all: readonly StatusSnapshot[], appFocused: boolean): number {
  return appFocused ? 0 : all.filter(isWaiting).length;
}

export function backgroundAlerts(input: AlertInput): AlertOutput {
  const badge = badgeCount(input.all, input.appFocused);
  const { prev, next } = input;
  const newRequest = isWaiting(next) && next.pending !== null && next.pending.id !== prev?.pending?.id;
  if (!newRequest || input.appFocused || !input.notificationsEnabled || !next.pending) return { notification: null, badge };
  const what = next.status === 'needs-approval' ? 'needs approval' : 'needs your reply';
  return {
    notification: { terminalId: next.terminalId, title: `${input.label} ${what}`, body: next.pending.summary },
    badge,
  };
}
