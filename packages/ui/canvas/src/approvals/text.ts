// 批准相关的纯函数：书签悬停的原因、记录里“谁批的”、时间、Approve all 的列表（X3）。

import type {
  ApprovalRecord,
  AutoApproveNeedsYouReason,
  PendingRequest,
  StatusSnapshot,
  WindowNode,
} from '@agentdeck/contracts';
import { statusOf } from '../model/attention.ts';

/** “Needs you” 书签悬停时的原因（PL1）。 */
export function needsYouReasonText(reason: AutoApproveNeedsYouReason): string {
  switch (reason) {
    case 'destructive':
      return 'Destructive command';
    case 'question':
      return 'Question for you';
    case 'couldnt-approve':
      return 'Couldn’t approve';
    case 'unsupported':
      return 'Not supported';
  }
}

/** Approval history 的“谁批的”：You / Approve all / Auto-approve。 */
export function approvedByText(by: ApprovalRecord['by']): string {
  switch (by) {
    case 'user':
      return 'You';
    case 'approve-all':
      return 'Approve all';
    case 'auto-approve':
      return 'Auto-approve';
  }
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 本地时间 “14:02”。读不出来时返回空串。 */
export function clockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 历史记录里的时间：今天的只写 “14:02”，更早的写 “Oct 24 14:02”。 */
export function historyTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return clockTime(iso);
  const month = d.toLocaleString('en-US', { month: 'short' });
  return `${month} ${d.getDate()} ${clockTime(iso)}`;
}

/** 在等“允许一次”的请求（不算提问和要你打字回答的）。按白板上窗口的顺序。 */
export function pendingApprovals(windows: readonly WindowNode[], statuses: Readonly<Record<string, StatusSnapshot>>): PendingRequest[] {
  const out: PendingRequest[] = [];
  for (const w of windows) {
    const s = statusOf(w, statuses);
    if (s?.status === 'needs-approval' && s.pending?.kind === 'approval') out.push(s.pending);
  }
  return out;
}

/** 在等你回答问题的（Approve all 不管它们，只在列表底下说一句）。 */
export function pendingQuestions(windows: readonly WindowNode[], statuses: Readonly<Record<string, StatusSnapshot>>): number {
  let n = 0;
  for (const w of windows) {
    const s = statusOf(w, statuses);
    if (s?.status === 'needs-reply' || (s?.status === 'needs-approval' && s.pending?.kind === 'question')) n += 1;
  }
  return n;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}
