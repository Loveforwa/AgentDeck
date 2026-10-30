// 白板上开着的窗口在管理面板里的样子（MP2）：状态灯、名字、窗口组里的身份、状态和时长。
// 从 V5 / CO4 的 BoardNav（packages/ui/panels/board-nav，MP3 退役）搬过来的纯函数，不碰 React。

import { WAITING_STATUSES } from '@agentdeck/contracts';
import type {
  AgentKind,
  BrowserWindowData,
  FrameNode,
  Project,
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

/** 状态灯，和终端标题栏一套（V2）：绿 running、黄 waiting、红 error、空心灰 idle、灰线 exited。 */
export type Lamp = 'running' | 'waiting' | 'error' | 'idle' | 'exited';

export const LAMP_LABEL: Record<Lamp, string> = { running: 'Running', waiting: 'Waiting', error: 'Error', idle: 'Idle', exited: 'Exited' };

/** 白板状态里管理面板要的几项，组装方原样传。 */
export interface BoardInput {
  projects: readonly Project[];
  workspaces: Readonly<Record<string, Workspace>>;
  frames: readonly FrameNode[];
  windows: readonly WindowNode[];
  /** 按 terminalId。 */
  statuses: Readonly<Record<string, StatusSnapshot>>;
  /** 按 windowId：窗口组件用 setStatus 给的状态（网页窗口等不是终端的窗口靠它表示在等你）。 */
  badges: Readonly<Record<string, WindowStatusBadge>>;
}

/** 一个开着的窗口。 */
export interface OpenWindow {
  id: WindowId;
  kind: 'terminal' | 'other';
  /** 终端的 agent；Shell、自定义命令是 'shell' / 'custom'；不是终端的窗口为 null。 */
  agent: AgentKind | null;
  /** 列表里的名字：改过名用改的名，否则 agent 名、命令名、网页的 host。 */
  name: string;
  /** 用户改过名（标题栏也只显示改的名）。 */
  renamed: boolean;
  /** 窗口组（N2）里的身份：“lead”、“sub-1 · api”。不在组里或改过名为 null。 */
  group: string | null;
  /** null：没有状态（网页窗口），显示窗口图标。 */
  lamp: Lamp | null;
  waiting: boolean;
  /** 在等什么：Needs approval / Needs reply。 */
  detail: string | null;
  terminalId: TerminalId | null;
  workspaceId: WorkspaceId | null;
  /** 终端里的 agent 会话 id（窗口记着的，没有时看状态机报的；codex、omp 启动后才知道）。 */
  sessionId: string | null;
  status: TerminalStatus | null;
  /** 状态从什么时候开始（StatusSnapshot.since）。 */
  since: string | null;
  exitCode: number | null;
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

/** 白板上的顺序（和 ⌘⇧] 一样）：框从上到下、同一行从左到右，框里的窗口也一样；不在框里的放最后。 */
export function boardOrder(input: Pick<BoardInput, 'frames' | 'windows'>): WindowNode[] {
  const out: WindowNode[] = [];
  const placed = new Set<WindowId>();
  for (const frame of readingOrder(input.frames, (f) => f.rect)) {
    const inside = input.windows.filter((w) => w.workspaceId === frame.workspaceId);
    for (const w of readingOrder(inside, (x) => x.rect)) {
      placed.add(w.id);
      out.push(w);
    }
  }
  return [...out, ...readingOrder(input.windows.filter((w) => !placed.has(w.id)), (w) => w.rect)];
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

/** 名字：用户起过名字就用它，否则和标题栏一样（agent 名、命令名、网页的 host）。 */
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
 * 窗口组里每个窗口的名字（N2，IS-70），和白板一致（ui/canvas 的 model/groups.ts：listGroups、memberName；
 * 那边没从注册表入口导出，这里照抄同一条规则，改一边要改另一边）：lead 是 “lead”；子终端按在 windows 里的先后编号
 * “sub-1”，有 label 时 “sub-1 · api”。没有 lead 或没有子终端的组不算。
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

export function openWindow(node: WindowNode, input: Pick<BoardInput, 'statuses' | 'badges'>, groups?: ReadonlyMap<WindowId, string>): OpenWindow {
  const badge = input.badges[node.id];
  const group = node.title ? null : (groups?.get(node.id) ?? null);
  const base = { id: node.id, name: windowName(node), renamed: !!node.title, group, workspaceId: node.workspaceId };
  if (node.type === 'terminal') {
    const data = node.data as Partial<TerminalWindowData> | null;
    const terminalId = data?.terminalId ?? null;
    const snap = terminalId ? input.statuses[terminalId] : undefined;
    const waiting = snap ? WAITING_STATUSES.includes(snap.status) : badge?.tone === 'attention';
    const lamp: Lamp = snap ? STATUS_LAMP[snap.status] : (badgeLamp(badge) ?? (terminalId ? 'idle' : 'exited'));
    const detail = snap?.status === 'needs-approval' ? 'Needs approval' : snap?.status === 'needs-reply' ? 'Needs reply' : waiting ? (badge?.detail ?? null) : null;
    return {
      ...base,
      kind: 'terminal',
      agent: data?.agent ?? null,
      lamp,
      waiting,
      detail,
      terminalId,
      sessionId: data?.sessionId ?? snap?.sessionId ?? null,
      status: snap?.status ?? null,
      since: snap?.since ?? null,
      exitCode: snap?.exitCode ?? null,
    };
  }
  const lamp = badgeLamp(badge);
  const waiting = lamp === 'waiting';
  return {
    ...base,
    kind: 'other',
    agent: null,
    lamp,
    waiting,
    detail: waiting ? (badge?.detail ?? null) : null,
    terminalId: null,
    sessionId: null,
    status: null,
    since: null,
    exitCode: null,
  };
}

/** 开着的窗口都要（白板上的顺序）。 */
export function openWindows(input: BoardInput): OpenWindow[] {
  const groups = groupNames(input.windows);
  return boardOrder(input).map((w) => openWindow(w, input, groups));
}

/** 进 NEEDS YOU 的：在等你（黄）或出错（红）。 */
export function needsYou(w: Pick<OpenWindow, 'lamp'>): boolean {
  return w.lamp === 'waiting' || w.lamp === 'error';
}

/** NEEDS YOU 的顺序：等得最久的在前（since 早的在前），没有时间的放后面，一样时按白板上的顺序。 */
export function byWaitTime<T extends { open: Pick<OpenWindow, 'since'> | null }>(rows: readonly T[]): T[] {
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const sa = a.r.open?.since ?? null;
      const sb = b.r.open?.since ?? null;
      if (sa !== sb) {
        if (sa === null) return 1;
        if (sb === null) return -1;
        return sa < sb ? -1 : 1;
      }
      return a.i - b.i;
    })
    .map((x) => x.r);
}

/** ⌥⌘1–9 的顺序（MP3）：NEEDS YOU 一段从上到下的窗口。白板的快捷键用它（apps/desktop 交给 BoardController）。 */
export function needsYouOrder(input: BoardInput): WindowId[] {
  return byWaitTime(openWindows(input).filter(needsYou).map((open) => ({ open }))).map((r) => r.open.id);
}

/** 能用 ⌥⌘n 跳到的行数。 */
export const SHORTCUT_ROWS = 9;

/** NEEDS YOU 第 index 行（从 0 数）的快捷键文字，“⌥⌘3”；第 10 行起没有。 */
export function rowShortcut(index: number): string | null {
  return index >= 0 && index < SHORTCUT_ROWS ? `⌥⌘${index + 1}` : null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 时长写法和标题栏一样（widgets/terminal 的 formatSince，那边不能 import，照抄）：now / 4m / 2h / Oct 21。 */
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

/**
 * 开着的一行右边的状态和时长，和标题栏同一个写法：“Waiting · 2m”“Running · 4m”“Idle · 1h”“exit 1 · 2m”“Exited”“Starting”。
 * 没有状态的网页窗口为空（在等你时 “Waiting”）。
 */
export function statusText(w: Pick<OpenWindow, 'lamp' | 'status' | 'since' | 'exitCode'>, now: number): string {
  const t = w.since ? formatSince(w.since, now) : '';
  const join = (...parts: string[]) => parts.filter(Boolean).join(' · ');
  switch (w.status) {
    case null:
      return w.lamp === 'waiting' ? 'Waiting' : w.lamp === 'error' ? 'Error' : '';
    case 'starting':
      return 'Starting';
    case 'running':
      return join('Running', t);
    case 'needs-approval':
    case 'needs-reply':
      return join('Waiting', t);
    case 'idle':
      return join('Idle', t);
    case 'exited':
      return 'Exited';
    case 'error':
      return join(w.exitCode !== null ? `exit ${w.exitCode}` : 'Error', t);
  }
}
