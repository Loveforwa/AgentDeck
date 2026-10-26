// 左边栏历史会话的分组（MVP v3 · N11，画板 14）。纯函数，测试直接调。
//
// 三层：项目 → 工作路径 → agent，会话按最后活动倒序。
// - 工作路径：会话目录等于某个工作区的目录、或在它下面（取最长的那个）就归到那个工作区；
//   不在任何工作区里、但在项目目录（或项目的 worktree 目录）下面的，按目录各成一行，归到那个项目；
//   都不在的归到最后的 Other folders。
// - 项目按最后活动排，当前项目（顶栏选中的）放最上面；工作路径、agent 也按最后活动排。
// - 筛选：搜索框按标题、第一条消息、分支找（不分大小写）；agent 筛选只留那一种。

import type { AgentKind, Project, ProjectId, SessionSummary, Workspace, WorkspaceId } from '@agentdeck/contracts';

/** 白板上开着的会话的状态灯，和终端标题栏一套。 */
export type Lamp = 'running' | 'waiting' | 'error' | 'idle' | 'exited';

export const LAMP_LABEL: Record<Lamp, string> = { running: 'Running', waiting: 'Waiting', error: 'Error', idle: 'Idle', exited: 'Exited' };

export interface OpenSession {
  windowId: string;
  lamp: Lamp;
}

/** 开着的会话按 “agent:会话 id” 找。 */
export function sessionKey(agent: AgentKind, id: string): string {
  return `${agent}:${id}`;
}

export interface AgentGroup {
  agent: AgentKind;
  sessions: SessionSummary[];
}

export interface PathGroup {
  key: string;
  /** 分支名、工作区名，或目录。 */
  label: string;
  /** 后面的灰字，例如 “main folder”。 */
  detail: string | null;
  /** label 是分支名或目录（等宽字）。 */
  mono: boolean;
  /** 归到的工作区；按目录归的为 null。 */
  workspaceId: WorkspaceId | null;
  /** 新开终端的目录（工作区的目录，或会话的目录）。 */
  cwd: string | null;
  /** 工作区在白板上有框（默认展开）。 */
  onBoard: boolean;
  count: number;
  updatedAt: string;
  agents: AgentGroup[];
}

export interface ProjectGroup {
  /** 项目 id；Other folders 是 'other'。 */
  id: ProjectId | 'other';
  name: string;
  path: string | null;
  updatedAt: string;
  paths: PathGroup[];
}

export interface HistoryFilter {
  query: string;
  agent: AgentKind | null;
}

export interface HistoryInput {
  sessions: readonly SessionSummary[];
  projects: readonly Project[];
  workspaces: Readonly<Record<string, Workspace>>;
  /** 在白板上有框的工作区。 */
  onBoard: ReadonlySet<string>;
  activeProjectId: ProjectId | null;
  filter: HistoryFilter;
}

/** path 等于 dir 或在它下面。 */
export function within(path: string, dir: string): boolean {
  const d = dir.endsWith('/') ? dir.slice(0, -1) : dir;
  return path === d || path.startsWith(`${d}/`);
}

export function matches(s: SessionSummary, filter: HistoryFilter): boolean {
  if (filter.agent && s.agent !== filter.agent) return false;
  const q = filter.query.trim().toLowerCase();
  if (!q) return true;
  return [s.title, s.firstPrompt, s.branch].some((t) => !!t && t.toLowerCase().includes(q));
}

const newer = (a: { updatedAt: string }, b: { updatedAt: string }) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0);

export function buildHistory(input: HistoryInput): ProjectGroup[] {
  const workspaces = Object.values(input.workspaces);
  const projects = new Map<string, ProjectGroup>();
  const paths = new Map<string, PathGroup & { project: string }>();

  const projectGroup = (id: ProjectId | 'other'): ProjectGroup => {
    let g = projects.get(id);
    if (!g) {
      const p = id === 'other' ? undefined : input.projects.find((x) => x.id === id);
      g = { id, name: p?.name ?? 'Other folders', path: p?.path ?? null, updatedAt: '', paths: [] };
      projects.set(id, g);
    }
    return g;
  };

  for (const s of input.sessions) {
    if (!matches(s, input.filter)) continue;
    const cwd = s.cwd;
    const ws = cwd ? workspaces.filter((w) => within(cwd, w.path)).sort((a, b) => b.path.length - a.path.length)[0] : undefined;
    let key: string;
    let base: Omit<PathGroup, 'count' | 'updatedAt' | 'agents' | 'key'>;
    let projectId: ProjectId | 'other';
    if (ws) {
      key = `ws:${ws.id}`;
      projectId = ws.projectId;
      base = {
        label: ws.branch ?? ws.name,
        detail: ws.mode === 'main-folder' ? 'main folder' : null,
        mono: ws.branch !== null,
        workspaceId: ws.id,
        cwd: ws.path,
        onBoard: input.onBoard.has(ws.id),
      };
    } else {
      const p = cwd ? input.projects.find((x) => within(cwd, x.path) || within(cwd, x.worktreeRoot)) : undefined;
      projectId = p?.id ?? 'other';
      key = `dir:${projectId}:${cwd ?? ''}`;
      // 写成相对项目目录（或项目的 worktree 目录）的路径
      const root = p && cwd ? [p.path, p.worktreeRoot].find((r) => within(cwd, r)) : undefined;
      const rel = root && cwd ? cwd.slice(root.replace(/\/$/, '').length).replace(/^\//, '') : cwd;
      base = { label: rel || cwd || 'Unknown folder', detail: null, mono: true, workspaceId: null, cwd, onBoard: false };
    }
    let g = paths.get(key);
    if (!g) {
      g = { ...base, key, count: 0, updatedAt: '', agents: [], project: projectId };
      paths.set(key, g);
      projectGroup(projectId).paths.push(g);
    }
    g.count += 1;
    if (s.updatedAt > g.updatedAt) g.updatedAt = s.updatedAt;
    let a = g.agents.find((x) => x.agent === s.agent);
    if (!a) {
      a = { agent: s.agent, sessions: [] };
      g.agents.push(a);
    }
    a.sessions.push(s);
  }

  const out = [...projects.values()];
  for (const p of out) {
    for (const path of p.paths) {
      for (const a of path.agents) a.sessions.sort(newer);
      path.agents.sort((x, y) => newer(x.sessions[0]!, y.sessions[0]!));
      // 去掉内部用的 project 字段
      delete (path as Partial<PathGroup & { project: string }>).project;
    }
    p.paths.sort(newer);
    p.updatedAt = p.paths[0]?.updatedAt ?? '';
  }
  return out.sort((a, b) => {
    if (a.id === 'other' || b.id === 'other') return a.id === 'other' ? (b.id === 'other' ? 0 : 1) : -1;
    if (a.id === input.activeProjectId) return -1;
    if (b.id === input.activeProjectId) return 1;
    return newer(a, b);
  });
}

/** “now”、“5m”、“2h”、“3d”、“12 Oct”。 */
export function relativeTime(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)}d`;
  const d = new Date(t);
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
  return `${d.getDate()} ${month}`;
}

export const SOURCE_LABEL: Record<SessionSummary['source'], string | null> = { terminal: null, desktop: 'Desktop app', ide: 'Editor' };

/** 悬停时的说明：标题、agent 和模型、来源、开始和最后活动、目录和分支、第一条消息。 */
export function sessionDetails(s: SessionSummary): string {
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : null);
  return [
    s.title,
    [s.agent, s.model, SOURCE_LABEL[s.source]].filter(Boolean).join(' · '),
    [s.startedAt ? `Started ${when(s.startedAt)}` : null, `Last active ${when(s.updatedAt)}`].filter(Boolean).join(' · '),
    [s.cwd, s.branch].filter(Boolean).join(' · ') || null,
    s.firstPrompt && s.firstPrompt !== s.title ? `“${s.firstPrompt}”` : null,
  ]
    .filter(Boolean)
    .join('\n');
}
