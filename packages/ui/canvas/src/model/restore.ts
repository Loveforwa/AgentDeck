// X6：恢复上次会话的提示（“Restore your last session?”）和恢复后的那句提示。纯函数。
// 哪些窗口要恢复、怎么恢复由各窗口类型的 WindowTypeDefinition.restore 说了算，白板不按 type 写特例。

import type { WindowId, WindowRestoreItem, WorkspaceId } from '@agentdeck/contracts';

export interface RestoreSessionItem extends WindowRestoreItem {
  windowId: WindowId;
  workspaceId: WorkspaceId | null;
}

export interface RestoreOutcome {
  item: RestoreSessionItem;
  /** 实际开了新对话（没记下会话、或接不回）。 */
  fresh: boolean;
  /** 失败时给人看的原因。 */
  error: string | null;
}

/** 提示里列出几个窗口，再多就写 “and 3 more”。 */
export const RESTORE_LIST_MAX = 8;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** “3 terminals in 2 workspaces: 2 agents and 1 shell.” */
export function restoreHeadline(items: readonly RestoreSessionItem[]): string {
  const workspaces = new Set(items.map((i) => i.workspaceId).filter((w) => w !== null)).size;
  const agents = items.filter((i) => i.kind === 'agent').length;
  const shells = items.length - agents;
  const where = workspaces > 0 ? ` in ${plural(workspaces, 'workspace')}` : '';
  const what = [agents ? plural(agents, 'agent') : '', shells ? plural(shells, 'shell') : ''].filter(Boolean).join(' and ');
  return `${plural(items.length, 'terminal')}${where}: ${what}.`;
}

/** 每个窗口一行（“claude — Resumes the conversation”），最多 RESTORE_LIST_MAX 行。 */
export function restoreLines(items: readonly RestoreSessionItem[]): { lines: { windowId: WindowId; label: string; detail: string; fresh: boolean }[]; more: number } {
  return {
    lines: items.slice(0, RESTORE_LIST_MAX).map((i) => ({ windowId: i.windowId, label: i.label, detail: i.detail, fresh: i.fresh })),
    more: Math.max(0, items.length - RESTORE_LIST_MAX),
  };
}

/** Restore all 之后的提示。 */
export function restoreResultMessage(outcomes: readonly RestoreOutcome[]): string {
  const ok = outcomes.filter((o) => !o.error);
  const failed = outcomes.filter((o) => o.error);
  const parts: string[] = [];
  if (ok.length) parts.push(`Restored ${plural(ok.length, 'terminal')}.`);
  const fresh = ok.filter((o) => o.fresh && o.item.kind === 'agent').map((o) => o.item.label);
  if (fresh.length) parts.push(`${listNames(fresh)} had no saved conversation and started a new one.`);
  if (failed.length) {
    const first = failed[0]!;
    parts.push(`Couldn’t restore ${first.item.label}: ${first.error}${failed.length > 1 ? ` (and ${failed.length - 1} more)` : ''}`);
  }
  return parts.join(' ');
}

function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
