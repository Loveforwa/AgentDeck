// 窗口组（MVP v3 · N1、N2）：agent 用 MCP 的 open_terminals 一次开出的子终端，和开它们的主 agent。
// 数据在 WindowNode.group 上，随白板保存。N2 的侧边栏用 listGroups 列出一组里的子终端。

import type { WindowGroupId, WindowNode } from '@agentdeck/contracts';

export interface WindowGroup {
  id: WindowGroupId;
  lead: WindowNode;
  /** 按在 BoardState.windows 里的先后（也就是打开的先后）。 */
  members: WindowNode[];
}

/** 白板上的窗口组。没有 lead 或没有子终端的不算（dissolveGroups 之后不会有）。 */
export function listGroups(windows: readonly WindowNode[]): WindowGroup[] {
  const leads = new Map<WindowGroupId, WindowNode>();
  const members = new Map<WindowGroupId, WindowNode[]>();
  for (const w of windows) {
    if (!w.group) continue;
    if (w.group.role === 'lead') leads.set(w.group.id, w);
    else members.set(w.group.id, [...(members.get(w.group.id) ?? []), w]);
  }
  const out: WindowGroup[] = [];
  for (const [id, lead] of leads) {
    const m = members.get(id);
    if (m?.length) out.push({ id, lead, members: m });
  }
  return out;
}

/**
 * 关掉窗口后整理窗口组：主 agent 没了，子终端变回普通窗口；子终端都没了，主 agent 也不再是组。
 * 没有变化时返回原数组（store 靠引用判断要不要保存）。
 */
export function dissolveGroups(windows: WindowNode[]): WindowNode[] {
  const leads = new Set<WindowGroupId>();
  const members = new Set<WindowGroupId>();
  for (const w of windows) {
    if (!w.group) continue;
    (w.group.role === 'lead' ? leads : members).add(w.group.id);
  }
  const orphan = (w: WindowNode) => !!w.group && (w.group.role === 'lead' ? !members.has(w.group.id) : !leads.has(w.group.id));
  if (!windows.some(orphan)) return windows;
  return windows.map((w) => (orphan(w) ? { ...w, group: null } : w));
}
