// Agents 视图（CO4，画板 O0 第 4 节，照 Shepherd Terminal 的 Agent Monitor、herdr 的侧边栏）：只列 agent 终端，按状态分组。
// 分组顺序固定：ERROR（有的话）、NEEDS YOU、RUNNING、IDLE；组里按白板上的位置（和 Board 视图一样）。
// ⌥⌘1–9 跳到这里的前 9 行：白板的快捷键用 agentOrder() 算同一个顺序（apps/desktop 把它交给 BoardController）。纯函数，不碰 React。

import type { StatusSnapshot, TerminalWindowData, WindowId, WindowNode, Workspace } from '@agentdeck/contracts';
import { buildTree, type BoardNavInput, type NavWindow } from './model.ts';

export type AgentGroupId = 'error' | 'needs-you' | 'running' | 'idle';

export const AGENT_GROUP_ORDER: readonly AgentGroupId[] = ['error', 'needs-you', 'running', 'idle'];

export const AGENT_GROUP_LABEL: Record<AgentGroupId, string> = {
  error: 'ERROR',
  'needs-you': 'NEEDS YOU',
  running: 'RUNNING',
  idle: 'IDLE',
};

export interface AgentRow extends NavWindow {
  /** 在哪：“agentdeck · feat/login”（项目 · 分支；plain 项目没有分支时写工作区名）。散放的为 null。 */
  where: string | null;
  agentGroup: AgentGroupId;
  /** 状态从什么时候开始（StatusSnapshot.since），没有状态时为 null。 */
  since: string | null;
  status: StatusSnapshot['status'] | null;
  exitCode: number | null;
}

export interface AgentGroup {
  id: AgentGroupId;
  label: string;
  rows: AgentRow[];
}

export interface AgentsView {
  /** 只有不空的组，按 AGENT_GROUP_ORDER。 */
  groups: AgentGroup[];
  /** 所有行，按显示顺序（⌥⌘n 跳第 n 个）。 */
  rows: AgentRow[];
}

/** agent 终端：终端窗口，且不是 Shell、自定义命令。 */
export function isAgentWindow(node: WindowNode): boolean {
  if (node.type !== 'terminal') return false;
  const agent = (node.data as Partial<TerminalWindowData> | null)?.agent;
  return !!agent && agent !== 'shell' && agent !== 'custom';
}

function groupOf(row: Pick<AgentRow, 'lamp'>): AgentGroupId {
  switch (row.lamp) {
    case 'error':
      return 'error';
    case 'waiting':
      return 'needs-you';
    case 'running':
      return 'running';
    default:
      return 'idle';
  }
}

function whereOf(ws: Workspace | undefined, projectName: string | undefined): string | null {
  if (!ws) return null;
  const label = ws.branch ?? ws.name;
  return projectName ? `${projectName} · ${label}` : label;
}

export function buildAgents(input: BoardNavInput): AgentsView {
  const tree = buildTree(input);
  const byId = new Map(input.windows.map((w) => [w.id, w]));
  const projectName = new Map(input.projects.map((p) => [p.id, p.name]));
  // 白板顺序：项目 → 框 → 窗口，散放的最后（和 Board 视图一样）
  const ordered: NavWindow[] = [...tree.projects.flatMap((p) => p.workspaces.flatMap((ws) => ws.windows)), ...tree.loose];
  const buckets = new Map<AgentGroupId, AgentRow[]>(AGENT_GROUP_ORDER.map((g) => [g, []]));
  for (const nav of ordered) {
    const node = byId.get(nav.id);
    if (!node || !isAgentWindow(node)) continue;
    const snap = nav.terminalId ? input.statuses[nav.terminalId] : undefined;
    const ws = node.workspaceId ? input.workspaces[node.workspaceId] : undefined;
    // 旧白板里可能还带着 TerminalWindowData.unseen（CO4 早先写的），不读，照常按状态分组
    const row: AgentRow = {
      ...nav,
      where: whereOf(ws, ws ? projectName.get(ws.projectId) : undefined),
      agentGroup: groupOf(nav),
      since: snap?.since ?? null,
      status: snap?.status ?? null,
      exitCode: snap?.exitCode ?? null,
    };
    buckets.get(row.agentGroup)!.push(row);
  }
  const groups = AGENT_GROUP_ORDER.map((id) => ({ id, label: AGENT_GROUP_LABEL[id], rows: buckets.get(id)! })).filter((g) => g.rows.length > 0);
  return { groups, rows: groups.flatMap((g) => g.rows) };
}

/** ⌥⌘1–9 的顺序：Agents 视图里从上到下的窗口。 */
export function agentOrder(input: BoardNavInput): WindowId[] {
  return buildAgents(input).rows.map((r) => r.id);
}

/** 能用 ⌥⌘n 跳到的行数。 */
export const AGENT_SHORTCUT_ROWS = 9;

/** 第 index 行（从 0 数）的快捷键文字，“⌥⌘3”；第 10 行起没有。 */
export function agentShortcut(index: number): string | null {
  return index >= 0 && index < AGENT_SHORTCUT_ROWS ? `⌥⌘${index + 1}` : null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 时间写法和标题栏一样（widgets/terminal 的 formatSince，那边不能 import，照抄）：now / 4m / 2h / Oct 21。 */
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
 * 行右边的文字。分组的小标题已经写了状态，这里只补时间：
 * 等你 “Waiting · 2m”、运行 “4m”、空闲 “1h”、出错 “exit 1 · 2m”、退出 “Exited”、启动中 “Starting”。
 */
export function rowStatusText(row: Pick<AgentRow, 'agentGroup' | 'since' | 'status' | 'exitCode'>, now: number): string {
  const t = row.since ? formatSince(row.since, now) : '';
  const join = (...parts: string[]) => parts.filter(Boolean).join(' · ');
  switch (row.agentGroup) {
    case 'needs-you':
      return join('Waiting', t);
    case 'error':
      return join(row.exitCode !== null ? `exit ${row.exitCode}` : '', t);
    case 'running':
      return t;
    case 'idle':
      if (row.status === 'exited') return 'Exited';
      if (row.status === 'starting') return 'Starting';
      return t;
  }
}

/** 悬停提示第一行里的状态，和标题栏同一个写法：“Idle · now”“Running · 4m”“Waiting · 2m”。 */
export function titleStatusText(row: Pick<AgentRow, 'agentGroup' | 'since' | 'status' | 'exitCode'>, now: number): string {
  const t = row.since ? formatSince(row.since, now) : '';
  const join = (...parts: string[]) => parts.filter(Boolean).join(' · ');
  switch (row.status) {
    case null:
      return '';
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
      return row.exitCode === null ? 'Error' : `Error · exit ${row.exitCode}`;
  }
}
