// 提醒（任务 S3）：谁在等你、顶栏的 running / waiting 数、框标题的“1 waiting”、⌘J 的跳转顺序。
// 数据来自 status.snapshot() 和 status.changed；窗口通过 TerminalWindowData.terminalId 对上终端。
// 不是终端的窗口，组件用 setStatus 给了 tone: 'attention' 也算在等你。

import { WAITING_STATUSES } from '@agentdeck/contracts';
import type { StatusSnapshot, WindowId, WindowNode, WindowStatusBadge, WorkspaceId } from '@agentdeck/contracts';
import { terminalIdOf } from './windows.ts';

export interface AttentionInput {
  windows: readonly WindowNode[];
  statuses: Readonly<Record<string, StatusSnapshot>>;
  badges: Readonly<Record<string, WindowStatusBadge>>;
}

export interface AttentionSummary {
  /** 白板上终端窗口里状态为 running 的数量。 */
  running: number;
  /** 在等你的窗口，最早开始等的在前（⌘J 的顺序）。 */
  waiting: WindowId[];
  /** 每个工作区里在等你的窗口数。 */
  waitingByWorkspace: Partial<Record<WorkspaceId, number>>;
}

export function statusOf(node: WindowNode, statuses: AttentionInput['statuses']): StatusSnapshot | null {
  const id = terminalIdOf(node);
  return id ? (statuses[id] ?? null) : null;
}

export function isWaiting(node: WindowNode, input: Pick<AttentionInput, 'statuses' | 'badges'>): boolean {
  const s = statusOf(node, input.statuses);
  if (s && WAITING_STATUSES.includes(s.status)) return true;
  return input.badges[node.id]?.tone === 'attention';
}

export function summarize(input: AttentionInput): AttentionSummary {
  let running = 0;
  const waiting: { id: WindowId; since: string; order: number }[] = [];
  const waitingByWorkspace: Partial<Record<WorkspaceId, number>> = {};
  input.windows.forEach((w, order) => {
    const s = statusOf(w, input.statuses);
    if (s?.status === 'running') running += 1;
    if (isWaiting(w, input)) {
      waiting.push({ id: w.id, since: s?.since ?? '', order });
      if (w.workspaceId) waitingByWorkspace[w.workspaceId] = (waitingByWorkspace[w.workspaceId] ?? 0) + 1;
    }
  });
  // ISO 时间可以直接按字符串比较；没有时间的（只靠 badge）排在后面，再按白板上的顺序
  const key = (w: { since: string }) => w.since || '\uffff';
  waiting.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.order - b.order));
  return { running, waiting: waiting.map((w) => w.id), waitingByWorkspace };
}

/** ⌘J：当前聚焦的是在等你的窗口就跳到它后面那个，否则跳到第一个。没有在等你的返回 null。 */
export function nextWaiting(waiting: readonly WindowId[], current: WindowId | null): WindowId | null {
  if (waiting.length === 0) return null;
  const i = current ? waiting.indexOf(current) : -1;
  return waiting[(i + 1) % waiting.length] ?? null;
}

/** ⌘⇧J：反过来，当前聚焦的是在等你的窗口就跳到它前面那个，否则跳到最后一个（最晚开始等的）。 */
export function prevWaiting(waiting: readonly WindowId[], current: WindowId | null): WindowId | null {
  if (waiting.length === 0) return null;
  const i = current ? waiting.indexOf(current) : -1;
  return waiting[(i < 0 ? waiting.length : i) - 1] ?? waiting[waiting.length - 1] ?? null;
}

/** 聚焦的窗口在 ⌘J 顺序里排第几（从 1 开始）；不在里面返回 null。顶栏显示“2/3 waiting”。 */
export function waitingPosition(waiting: readonly WindowId[], current: WindowId | null): number | null {
  const i = current ? waiting.indexOf(current) : -1;
  return i < 0 ? null : i + 1;
}

/** 框标题栏右侧：“1 waiting”；没有时为空。 */
export function waitingLabel(n: number | undefined): string {
  return n ? `${n} waiting` : '';
}
