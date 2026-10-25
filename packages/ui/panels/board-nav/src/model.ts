// 快速定位列表的数据（MVP v2 · V5）：把白板状态整理成 项目 → 工作区 → 窗口 的树。纯函数，不碰 React。
// 顺序和 ⌘⇧] 一样按位置：框从上到下、同一行从左到右，框里的窗口也一样；散放的窗口放最后一组。

import { WAITING_STATUSES } from '@agentdeck/contracts';
import type {
  BrowserWindowData,
  FrameNode,
  Project,
  ProjectId,
  Rect,
  StatusSnapshot,
  TerminalId,
  TerminalStatus,
  TerminalWindowData,
  WindowGroupId,
  WindowId,
  WindowNode,
  WindowStatusBadge,
  Workspace,
  WorkspaceId,
} from '@agentdeck/contracts';

/** 状态灯，和 V2 一套：绿 running、黄 waiting、红 error、空心灰 idle、灰线 exited。 */
export type Lamp = 'running' | 'waiting' | 'error' | 'idle' | 'exited';

export const LAMP_LABEL: Record<Lamp, string> = {
  running: 'Running',
  waiting: 'Waiting',
  error: 'Error',
  idle: 'Idle',
  exited: 'Exited',
};

export interface BoardNavInput {
  projects: readonly Project[];
  workspaces: Readonly<Record<string, Workspace>>;
  frames: readonly FrameNode[];
  windows: readonly WindowNode[];
  /** 按 terminalId。 */
  statuses: Readonly<Record<string, StatusSnapshot>>;
  /** 按 windowId：窗口组件用 setStatus 给的状态（网页窗口等不是终端的窗口靠它表示在等你）。 */
  badges: Readonly<Record<string, WindowStatusBadge>>;
}

export interface NavWindow {
  id: WindowId;
  /** 终端的名字用等宽字体；其他窗口前面画一个窗口小图标。 */
  kind: 'terminal' | 'other';
  name: string;
  /**
   * 窗口组（N2）里的身份，和标题栏的灰字一样：lead 是 “lead”，子终端是 “sub-2 · ui”（和组的侧边栏同名）。
   * 不在组里、或用户改过名（标题栏也只显示改的名）时为 null。
   */
  group: string | null;
  /** null：没有状态（网页窗口），显示图标。 */
  lamp: Lamp | null;
  waiting: boolean;
  /** 在等什么：Needs approval / Needs reply。 */
  detail: string | null;
  /** 对话主题按它去 terminals.list() 里找。 */
  terminalId: TerminalId | null;
}

export interface NavWorkspace {
  id: WorkspaceId;
  /** 分支名；没有分支（plain 项目）时是工作区名。 */
  label: string;
  isBranch: boolean;
  windows: NavWindow[];
}

export interface NavProject {
  id: ProjectId;
  name: string;
  workspaces: NavWorkspace[];
}

export interface NavTree {
  projects: NavProject[];
  /** 散放在白板上的窗口（以及工作区没有框、或不认识的窗口）。 */
  loose: NavWindow[];
}

/** 按阅读顺序排：从上到下分行（上边沿在这一行第一个的竖直中线以上算同一行），同一行从左到右。 */
export function readingOrder<T>(items: readonly T[], rectOf: (item: T) => Rect): T[] {
  const byTop = [...items].sort((a, b) => rectOf(a).y - rectOf(b).y || rectOf(a).x - rectOf(b).x);
  const rows: T[][] = [];
  let rowEnd = -Infinity;
  for (const item of byTop) {
    const r = rectOf(item);
    const row = rows[rows.length - 1];
    if (row && r.y < rowEnd) row.push(item);
    else {
      rows.push([item]);
      rowEnd = r.y + r.h / 2;
    }
  }
  return rows.flatMap((row) => row.sort((a, b) => rectOf(a).x - rectOf(b).x));
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

/** 列表里显示的名字：用户起过名字就用它，否则和标题栏一样（agent 名、命令名、网页的 host）。 */
export function windowName(node: WindowNode): string {
  if (node.title) return node.title;
  if (node.type === 'terminal') {
    const d = node.data as Partial<TerminalWindowData> | null;
    if (d?.agent && d.agent !== 'shell' && d.agent !== 'custom') return d.agent;
    if (d?.cmd) return basename(d.cmd);
    return 'terminal';
  }
  if (node.type === 'browser') {
    const url = (node.data as Partial<BrowserWindowData> | null)?.url;
    if (url) {
      try {
        return new URL(url).host || url;
      } catch {
        return url;
      }
    }
    return 'browser';
  }
  return node.type;
}

/**
 * 窗口组里每个窗口的名字（MVP v3 · N2，IS-70），和白板一致（ui/canvas 的 model/groups.ts：listGroups、memberName、groupTitle；
 * 那边没从注册表入口导出，这里照抄同一条规则）：lead 是 “lead”；子终端按在 windows 里的先后编号 “sub-1”，
 * 有 label 时 “sub-1 · api”。没有 lead 或没有子终端的组不算。
 */
export function groupNames(windows: readonly WindowNode[]): Map<WindowId, string> {
  const leads = new Map<WindowGroupId, WindowNode>();
  const members = new Map<WindowGroupId, WindowNode[]>();
  for (const w of windows) {
    if (!w.group) continue;
    if (w.group.role === 'lead') leads.set(w.group.id, w);
    else members.set(w.group.id, [...(members.get(w.group.id) ?? []), w]);
  }
  const out = new Map<WindowId, string>();
  for (const [id, lead] of leads) {
    const list = members.get(id);
    if (!list?.length) continue;
    out.set(lead.id, 'lead');
    list.forEach((m, i) => {
      const label = m.group?.label?.trim();
      out.set(m.id, `sub-${i + 1}${label ? ` · ${label}` : ''}`);
    });
  }
  return out;
}

const STATUS_LAMP: Record<TerminalStatus, Lamp> = {
  starting: 'idle',
  running: 'running',
  'needs-approval': 'waiting',
  'needs-reply': 'waiting',
  idle: 'idle',
  exited: 'exited',
  error: 'error',
};

function badgeLamp(badge: WindowStatusBadge | undefined): Lamp | null {
  switch (badge?.tone) {
    case 'running':
      return 'running';
    case 'attention':
      return 'waiting';
    case 'error':
      return 'error';
    default:
      return null;
  }
}

export function navWindow(node: WindowNode, input: Pick<BoardNavInput, 'statuses' | 'badges'>, groups?: ReadonlyMap<WindowId, string>): NavWindow {
  const badge = input.badges[node.id];
  const group = node.title ? null : (groups?.get(node.id) ?? null);
  if (node.type === 'terminal') {
    const terminalId = (node.data as Partial<TerminalWindowData> | null)?.terminalId ?? null;
    const snap = terminalId ? input.statuses[terminalId] : undefined;
    const waiting = snap ? WAITING_STATUSES.includes(snap.status) : badge?.tone === 'attention';
    const lamp: Lamp = snap ? STATUS_LAMP[snap.status] : (badgeLamp(badge) ?? (terminalId ? 'idle' : 'exited'));
    const detail = snap?.status === 'needs-approval' ? 'Needs approval' : snap?.status === 'needs-reply' ? 'Needs reply' : waiting ? (badge?.detail ?? null) : null;
    return { id: node.id, kind: 'terminal', name: windowName(node), group, lamp, waiting, detail, terminalId };
  }
  const lamp = badgeLamp(badge);
  const waiting = lamp === 'waiting';
  return { id: node.id, kind: 'other', name: windowName(node), group, lamp, waiting, detail: waiting ? (badge?.detail ?? null) : null, terminalId: null };
}

export function buildTree(input: BoardNavInput): NavTree {
  const groups = groupNames(input.windows);
  const placed = new Set<WindowId>();
  const byProject = new Map<ProjectId, NavWorkspace[]>();
  for (const frame of readingOrder(input.frames, (f) => f.rect)) {
    const ws = input.workspaces[frame.workspaceId];
    if (!ws || !input.projects.some((p) => p.id === ws.projectId)) continue;
    const inside = input.windows.filter((w) => w.workspaceId === ws.id);
    for (const w of inside) placed.add(w.id);
    const list = byProject.get(ws.projectId) ?? [];
    list.push({
      id: ws.id,
      label: ws.branch ?? ws.name,
      isBranch: ws.branch !== null,
      windows: readingOrder(inside, (w) => w.rect).map((w) => navWindow(w, input, groups)),
    });
    byProject.set(ws.projectId, list);
  }
  const loose = readingOrder(
    input.windows.filter((w) => !placed.has(w.id)),
    (w) => w.rect,
  ).map((w) => navWindow(w, input, groups));
  return {
    projects: input.projects.map((p) => ({ id: p.id, name: p.name, workspaces: byProject.get(p.id) ?? [] })),
    loose,
  };
}
