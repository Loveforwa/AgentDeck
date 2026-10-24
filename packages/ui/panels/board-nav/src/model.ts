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

export function navWindow(node: WindowNode, input: Pick<BoardNavInput, 'statuses' | 'badges'>): NavWindow {
  const badge = input.badges[node.id];
  if (node.type === 'terminal') {
    const terminalId = (node.data as Partial<TerminalWindowData> | null)?.terminalId ?? null;
    const snap = terminalId ? input.statuses[terminalId] : undefined;
    const waiting = snap ? WAITING_STATUSES.includes(snap.status) : badge?.tone === 'attention';
    const lamp: Lamp = snap ? STATUS_LAMP[snap.status] : (badgeLamp(badge) ?? (terminalId ? 'idle' : 'exited'));
    const detail = snap?.status === 'needs-approval' ? 'Needs approval' : snap?.status === 'needs-reply' ? 'Needs reply' : waiting ? (badge?.detail ?? null) : null;
    return { id: node.id, kind: 'terminal', name: windowName(node), lamp, waiting, detail, terminalId };
  }
  const lamp = badgeLamp(badge);
  const waiting = lamp === 'waiting';
  return { id: node.id, kind: 'other', name: windowName(node), lamp, waiting, detail: waiting ? (badge?.detail ?? null) : null, terminalId: null };
}

export function buildTree(input: BoardNavInput): NavTree {
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
      windows: readingOrder(inside, (w) => w.rect).map((w) => navWindow(w, input)),
    });
    byProject.set(ws.projectId, list);
  }
  const loose = readingOrder(
    input.windows.filter((w) => !placed.has(w.id)),
    (w) => w.rect,
  ).map((w) => navWindow(w, input));
  return {
    projects: input.projects.map((p) => ({ id: p.id, name: p.name, workspaces: byProject.get(p.id) ?? [] })),
    loose,
  };
}
