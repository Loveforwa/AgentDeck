// 窗口组（MVP v3 · N1、N2）：agent 用 MCP 的 open_terminals 一次开出的子终端，和开它们的主 agent。
// 数据在 WindowNode.group 上，随白板保存。N2 的侧边栏用 listGroups 列出一组里的子终端，显示方式在 lead 的 group.view 上。

import { WAITING_STATUSES } from '@agentdeck/contracts';
import type {
  Rect,
  StatusSnapshot,
  TerminalStatus,
  WindowGroupId,
  WindowGroupView,
  WindowId,
  WindowNode,
  WindowStatusBadge,
} from '@agentdeck/contracts';
import type { Point } from './geometry.ts';
import { terminalIdOf } from './windows.ts';

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

// ---- N2：窗口组的侧边栏（形态 A） ----
// 侧边栏贴在 lead 窗口右边（隔 SIDEBAR_GAP），和 lead 一样高，列出子终端和状态灯。lead 上的 group.view 记着怎么显示子终端：
// - one：只显示选中的那个，贴在侧边栏右边（“停靠”）；其余收起。
// - all：Show all，子终端都是普通窗口，平铺在侧边栏右边。
// - collapsed：Collapse group，只剩侧边栏。
// 收起的子终端不画（终端 detach，进程照常在 tmux 里跑），仍然算进“在等你”；它们的位置停在停靠处，跟着 lead 走，
// 所以再显示时就在侧边栏右边。只停靠和 lead 在同一个框（或都散放）的子终端；别的框里的子终端收起 / 显示时位置不动。

/** 侧边栏的宽度（白板坐标）。 */
export const SIDEBAR_W = 168;
/** 侧边栏和 lead、和停靠的子终端之间的空。比窗口之间的 GAP 小，看起来是贴着 lead 的。 */
export const SIDEBAR_GAP = 8;

const ALL: WindowGroupView = { mode: 'all' };

/** 这一组现在的显示方式：没记（N1 存下的组）按 all；one 选中的子终端不在组里了就换成第一个。 */
export function groupView(g: WindowGroup): WindowGroupView {
  const v = g.lead.group?.view ?? ALL;
  if (v.mode === 'one' && !g.members.some((m) => m.id === v.shown)) {
    const first = g.members[0];
    return first ? { mode: 'one', shown: first.id } : ALL;
  }
  return v;
}

/** 侧边栏的位置：lead 右边。anchor 是 lead 占的地方（放大中的 lead 用还原后的位置）。 */
export function sidebarRect(anchor: Rect): Rect {
  return { x: anchor.x + anchor.w + SIDEBAR_GAP, y: anchor.y, w: SIDEBAR_W, h: anchor.h };
}

/** 停靠处（选中的子终端的左上角）：侧边栏右边。 */
export function dockSlot(anchor: Rect): Point {
  return { x: anchor.x + anchor.w + SIDEBAR_GAP * 2 + SIDEBAR_W, y: anchor.y };
}

export function atSlot(rect: Rect, slot: Point): boolean {
  return Math.abs(rect.x - slot.x) < 0.5 && Math.abs(rect.y - slot.y) < 0.5;
}

/** 能停靠在侧边栏右边：和 lead 在同一个框里（或都散放）。 */
export function dockable(lead: WindowNode, member: WindowNode): boolean {
  return member.workspaceId === lead.workspaceId;
}

/** 收起的子终端（不画在白板上）。 */
export function hiddenMembers(windows: readonly WindowNode[]): Set<WindowId> {
  const out = new Set<WindowId>();
  for (const g of listGroups(windows)) {
    const v = groupView(g);
    if (v.mode === 'all') continue;
    for (const m of g.members) if (v.mode === 'collapsed' || m.id !== v.shown) out.add(m.id);
  }
  return out;
}

/** 窗口在哪个组里（lead 或子终端）。 */
export function groupOf(windows: readonly WindowNode[], id: WindowId): WindowGroup | undefined {
  return listGroups(windows).find((g) => g.lead.id === id || g.members.some((m) => m.id === id));
}

/** 侧边栏一行的名字：“sub-2 · ui”（第几个子终端 · open_terminals 给的名字）。左边管理面板（panels/manager 的 board.ts `groupNames`）照抄这条规则，改时一起改。 */
export function memberName(g: WindowGroup, member: WindowNode): string {
  const i = g.members.findIndex((m) => m.id === member.id);
  const label = member.group?.label?.trim();
  return `sub-${i + 1}${label ? ` · ${label}` : ''}`;
}

/** 标题栏上 agent 名字后面的灰字：lead 是 “lead”，子终端是 “sub-2 · ui”；不在组里为 null。 */
export function groupTitle(windows: readonly WindowNode[], node: WindowNode): string | null {
  const ref = node.group;
  if (!ref) return null;
  const g = listGroups(windows).find((x) => x.id === ref.id);
  if (!g) return null;
  return ref.role === 'lead' ? 'lead' : memberName(g, node);
}

/** 状态灯，和标题栏、快速定位列表（V5）一套：绿 running、黄 waiting、红 error、空心 idle、短线 exited。 */
export type Lamp = 'running' | 'waiting' | 'error' | 'idle' | 'exited';

export const LAMP_LABEL: Record<Lamp, string> = { running: 'Running', waiting: 'Waiting', error: 'Error', idle: 'Idle', exited: 'Exited' };

const STATUS_LAMP: Record<TerminalStatus, Lamp> = {
  starting: 'idle',
  running: 'running',
  'needs-approval': 'waiting',
  'needs-reply': 'waiting',
  idle: 'idle',
  exited: 'exited',
  error: 'error',
};

export function lampOf(
  node: WindowNode,
  statuses: Readonly<Record<string, StatusSnapshot>>,
  badges: Readonly<Record<string, WindowStatusBadge>>,
): Lamp {
  const tid = terminalIdOf(node);
  const snap = tid ? statuses[tid] : undefined;
  if (snap) return WAITING_STATUSES.includes(snap.status) ? 'waiting' : STATUS_LAMP[snap.status];
  switch (badges[node.id]?.tone) {
    case 'running':
      return 'running';
    case 'attention':
      return 'waiting';
    case 'error':
      return 'error';
    default:
      return tid || node.type !== 'terminal' ? 'idle' : 'exited';
  }
}

/** 换掉 lead 的 view。 */
export function setGroupView(windows: readonly WindowNode[], groupId: WindowGroupId, view: WindowGroupView): WindowNode[] {
  return windows.map((w) => (w.group?.id === groupId && w.group.role === 'lead' ? { ...w, group: { ...w.group, view } } : w));
}

/**
 * 每次 windows 变了之后整理停靠（控制器的 set 里调）：
 * - one 选中的子终端被关掉了：换成它后面那个（没有就前面那个），停在停靠处。
 * - 收起的、能停靠的子终端停在停靠处，跟着 lead 走。
 * - 选中的子终端原来停靠着、这次没被别的操作挪过：lead 挪了或改了大小，它跟着到新的停靠处。用户把它拖走了就不再跟着。
 * anchorOf：lead 占的地方（控制器的 footprint）。没有变化时返回 next 本身（store 靠引用判断要不要保存）。
 */
export function syncGroups(prev: readonly WindowNode[], next: WindowNode[], anchorOf: (w: WindowNode) => Rect): WindowNode[] {
  if (prev === next || !next.some((w) => w.group?.role === 'lead' && w.group.view && w.group.view.mode !== 'all')) return next;
  const before = new Map(prev.map((w) => [w.id, w]));
  const patch = new Map<WindowId, WindowNode>();
  for (const g of listGroups(next)) {
    let lead = g.lead;
    let view = lead.group?.view ?? ALL;
    if (view.mode === 'all') continue;
    if (view.mode === 'one') {
      const gone = view.shown;
      if (!g.members.some((m) => m.id === gone)) {
        // 选中的被关掉了：按关之前的顺序找它后面的，没有就前面的
        const old = listGroups(prev).find((x) => x.id === g.id)?.members.map((m) => m.id) ?? [];
        const at = old.indexOf(gone);
        const alive = (id: WindowId) => g.members.some((m) => m.id === id);
        const shown = (at >= 0 ? (old.slice(at + 1).find(alive) ?? old.slice(0, at).reverse().find(alive)) : undefined) ?? g.members[0]!.id;
        view = { mode: 'one', shown };
        lead = { ...lead, group: { ...lead.group!, view } };
        patch.set(lead.id, lead);
      }
    }
    const slot = dockSlot(anchorOf(lead));
    const prevLead = before.get(lead.id);
    const prevSlot = prevLead ? dockSlot(anchorOf(prevLead)) : null;
    for (const m of g.members) {
      if (!dockable(lead, m)) continue;
      if (view.mode === 'one' && view.shown === m.id) {
        const was = before.get(m.id);
        const follow = !!was && !!prevSlot && was.rect === m.rect && atSlot(was.rect, prevSlot) && !atSlot(m.rect, slot);
        if (!follow) continue;
      } else if (atSlot(m.rect, slot)) continue;
      patch.set(m.id, { ...m, rect: { ...m.rect, x: slot.x, y: slot.y } });
    }
  }
  if (patch.size === 0) return next;
  return next.map((w) => patch.get(w.id) ?? w);
}
