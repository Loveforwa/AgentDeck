// 左边管理面板的数据（MP2，画板“左边管理面板”MP0）。纯函数，测试直接调。
//
// 一个终端只有一行：白板上开着的窗口和历史会话按 “agent:会话 id” 合成一行（开着的带状态灯）。从上到下：
// - NEEDS YOU：在等你（黄）或出错（红）的开着的行，等得最久的在前（⌥⌘1–9 跳这里的行）。
// - PINNED：置顶的会话、窗口、项目、工作路径（BoardState.pins 的顺序）。
// - 项目 → 工作路径 → 行。工作路径：开着的窗口按它所在的工作区；历史会话按目录——等于某个工作区的目录、或在它下面
//   （取最长的那个）就归到那个工作区，不在工作区里、但在项目目录（或项目的 worktree 目录）下面的按目录各成一行，
//   都不在的归到最后的 Other folders。不在工作区里的开着的窗口归到 “Not in a workspace”。
// 每一行只出现一次：在 NEEDS YOU 里的不再进 PINNED 和项目，置顶的不再进项目。
// 搜索按标题、第一条消息、分支、窗口名、终端的对话主题找（不分大小写），搜索时只留命中的。

import { boardPinKey } from '@agentdeck/contracts';
import type { AgentKind, BoardPin, Project, ProjectId, SessionSummary, Workspace, WorkspaceId } from '@agentdeck/contracts';
import { byWaitTime, needsYou, openWindows, readingOrder, type BoardInput, type OpenWindow } from './board.ts';

/** 开着的会话和窗口按 “agent:会话 id” 找。 */
export function sessionKey(agent: AgentKind, id: string): string {
  return `${agent}:${id}`;
}

/** Resume、新开终端放在哪：工作区（框）和目录。 */
export interface PathRef {
  workspaceId: WorkspaceId | null;
  cwd: string | null;
}

/** 面板里的一行：开着的窗口，或没开着的历史会话。 */
export interface Row {
  /** 和它的置顶同一个 key（boardPinKey）：“session:claude:abc” 或 “window:w1”。 */
  key: string;
  title: string;
  /** agent 身份色的小方块；Shell、自定义命令是 'shell' / 'custom'；网页等不是终端的窗口为 null。 */
  agent: AgentKind | null;
  session: SessionSummary | null;
  /** 开着的窗口；历史会话为 null。 */
  open: OpenWindow | null;
  /** 置顶它用的引用：有会话的置顶会话（关掉了照样留着），没有的置顶窗口。 */
  pin: BoardPin;
  /** NEEDS YOU、PINNED 里写的位置：“shop · feat/login”。 */
  where: string | null;
  /** 归到的工作路径（Resume 用）。 */
  path: PathRef;
  updatedAt: string;
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
  /** 显示的行数（不算已经在 NEEDS YOU、PINNED 里的）。 */
  count: number;
  updatedAt: string;
  /** 开着的在前（白板上的顺序），然后历史会话，最近的在前。 */
  rows: Row[];
}

export interface ProjectGroup {
  /** 项目 id；不在工作区里的开着的窗口是 'loose'，Other folders 是 'other'。 */
  id: ProjectId | 'loose' | 'other';
  name: string;
  path: string | null;
  updatedAt: string;
  paths: PathGroup[];
}

export type PinnedItem =
  | { kind: 'row'; index: number; pin: BoardPin; row: Row }
  | { kind: 'project'; index: number; pin: BoardPin; project: Project }
  | { kind: 'workspace'; index: number; pin: BoardPin; workspace: Workspace; label: string };

export interface ManagerView {
  needsYou: Row[];
  pinned: PinnedItem[];
  projects: ProjectGroup[];
}

export interface ManagerInput extends BoardInput {
  /** 历史会话（HistoryService.list）；还没读到时传空数组。 */
  sessions: readonly SessionSummary[];
  pins: readonly BoardPin[];
  /** 顶栏选中的项目，放最上面。 */
  activeProjectId: ProjectId | null;
  query: string;
  /** 终端的对话主题（TerminalInfo.title），按 terminalId。 */
  topics?: Readonly<Record<string, string>>;
  /** 家目录，目录写成 ~ 开头。 */
  home?: string | null;
}

/** macOS 上 /tmp、/var、/etc 是 /private/… 的链接，agent 记下的目录两种写法都有：统一去掉 /private。 */
export function normalizePath(path: string): string {
  const p = path.replace(/^\/private(?=\/(tmp|var|etc)(\/|$))/, '');
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

/** path 等于 dir 或在它下面（按 normalizePath 比）。 */
export function within(path: string, dir: string): boolean {
  const p = normalizePath(path);
  const d = normalizePath(dir);
  return p === d || p.startsWith(`${d}/`);
}

/** 列表里的目录：家目录写成 ~，还太长时只留最后两层（完整的在悬停里）。 */
export function shortPath(path: string, home: string | null): string {
  let p = normalizePath(path);
  if (home && within(p, home)) p = `~${p.slice(normalizePath(home).length)}`;
  if (p.length <= 36) return p;
  const parts = p.split('/').filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : p;
}

const newer = (a: { updatedAt: string }, b: { updatedAt: string }) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0);

function rowMatches(row: Row, q: string, topic: string | null): boolean {
  const s = row.session;
  return [row.title, row.where, s?.firstPrompt, s?.branch, row.open?.name, topic].some((t) => !!t && t.toLowerCase().includes(q));
}

interface Place {
  projectId: ProjectId | 'loose' | 'other';
  key: string;
  base: Omit<PathGroup, 'key' | 'count' | 'updatedAt' | 'rows'>;
}

function workspacePlace(ws: Workspace, onBoard: ReadonlySet<string>): Place {
  return {
    projectId: ws.projectId,
    key: `ws:${ws.id}`,
    base: {
      label: ws.branch ?? ws.name,
      detail: ws.mode === 'main-folder' ? 'main folder' : null,
      mono: ws.branch !== null,
      workspaceId: ws.id,
      cwd: ws.path,
      onBoard: onBoard.has(ws.id),
    },
  };
}

/** 历史会话按目录归到哪（见文件开头）。 */
function dirPlace(cwd: string | null, input: ManagerInput, workspaces: readonly Workspace[], onBoard: ReadonlySet<string>): Place {
  const ws = cwd ? workspaces.filter((w) => within(cwd, w.path)).sort((a, b) => b.path.length - a.path.length)[0] : undefined;
  if (ws) return workspacePlace(ws, onBoard);
  const p = cwd ? input.projects.find((x) => within(cwd, x.path) || within(cwd, x.worktreeRoot)) : undefined;
  const projectId = p?.id ?? 'other';
  // 写成相对项目目录（或项目的 worktree 目录）的路径
  const root = p && cwd ? [p.path, p.worktreeRoot].find((r) => within(cwd, r)) : undefined;
  const rel = root && cwd ? normalizePath(cwd).slice(normalizePath(root).length).replace(/^\//, '') : null;
  return {
    projectId,
    key: `dir:${projectId}:${cwd ? normalizePath(cwd) : ''}`,
    base: {
      label: rel || (cwd ? shortPath(cwd, input.home ?? null) : 'Unknown folder'),
      detail: null,
      mono: true,
      workspaceId: null,
      cwd,
      onBoard: false,
    },
  };
}

const LOOSE: Place = {
  projectId: 'loose',
  key: 'loose',
  base: { label: 'Not in a workspace', detail: null, mono: false, workspaceId: null, cwd: null, onBoard: true },
};

export function buildManager(input: ManagerInput): ManagerView {
  const workspaces = Object.values(input.workspaces);
  const onBoard = new Set<string>(input.frames.map((f) => f.workspaceId));
  const projectName = new Map<string, string>(input.projects.map((p) => [p.id, p.name]));
  const topics = input.topics ?? {};
  const q = input.query.trim().toLowerCase();

  // 1. 开着的窗口，按会话对上历史会话
  const sessions = new Map(input.sessions.map((s) => [sessionKey(s.agent, s.id), s]));
  const opened = new Set<string>();
  const rows: { row: Row; place: Place; topic: string | null }[] = [];
  for (const w of openWindows(input)) {
    const sk = w.agent && w.sessionId ? sessionKey(w.agent, w.sessionId) : null;
    const session = sk ? (sessions.get(sk) ?? null) : null;
    if (sk) opened.add(sk);
    const topic = w.terminalId ? (topics[w.terminalId] ?? null) : null;
    const pin: BoardPin = w.agent && w.sessionId ? { kind: 'session', agent: w.agent, sessionId: w.sessionId as BoardPinSessionId } : { kind: 'window', windowId: w.id };
    const ws = w.workspaceId ? input.workspaces[w.workspaceId] : undefined;
    const place = ws ? workspacePlace(ws, onBoard) : LOOSE;
    rows.push({
      row: {
        key: boardPinKey(pin),
        title: (w.renamed ? w.name : null) ?? session?.title ?? topic ?? w.name,
        agent: w.agent,
        session,
        open: w,
        pin,
        where: null,
        path: { workspaceId: place.base.workspaceId, cwd: place.base.cwd ?? session?.cwd ?? null },
        updatedAt: [session?.updatedAt ?? '', w.since ?? ''].sort().pop()!,
      },
      place,
      topic,
    });
  }
  // 2. 没开着的历史会话
  for (const [sk, s] of sessions) {
    if (opened.has(sk)) continue;
    const pin: BoardPin = { kind: 'session', agent: s.agent, sessionId: s.id };
    const place = dirPlace(s.cwd, input, workspaces, onBoard);
    rows.push({
      row: { key: boardPinKey(pin), title: s.title, agent: s.agent, session: s, open: null, pin, where: null, path: { workspaceId: place.base.workspaceId, cwd: s.cwd ?? place.base.cwd }, updatedAt: s.updatedAt },
      place,
      topic: null,
    });
  }
  for (const r of rows) {
    const name = r.place.projectId === 'loose' || r.place.projectId === 'other' ? null : (projectName.get(r.place.projectId) ?? null);
    r.row.where = r.place.projectId === 'loose' ? null : name ? `${name} · ${r.place.base.label}` : r.place.base.label;
  }
  const shown = q ? rows.filter((r) => rowMatches(r.row, q, r.topic)) : rows;
  const taken = new Set<string>();

  // 3. NEEDS YOU
  const needs = byWaitTime(shown.filter((r) => r.row.open && needsYou(r.row.open)).map((r) => r.row));
  for (const r of needs) taken.add(r.key);

  // 4. PINNED
  const pinned: PinnedItem[] = [];
  input.pins.forEach((pin, index) => {
    if (pin.kind === 'session' || pin.kind === 'window') {
      const hit = shown.find((r) => (pin.kind === 'window' ? r.row.open?.id === pin.windowId : r.row.key === boardPinKey(pin)));
      if (!hit || taken.has(hit.row.key)) return;
      taken.add(hit.row.key);
      pinned.push({ kind: 'row', index, pin, row: hit.row });
    } else if (pin.kind === 'project') {
      const project = input.projects.find((p) => p.id === pin.projectId);
      if (project && (!q || project.name.toLowerCase().includes(q))) pinned.push({ kind: 'project', index, pin, project });
    } else {
      const workspace = input.workspaces[pin.workspaceId];
      if (!workspace) return;
      const label = `${projectName.get(workspace.projectId) ?? workspace.name} · ${workspace.branch ?? workspace.name}`;
      if (!q || label.toLowerCase().includes(q)) pinned.push({ kind: 'workspace', index, pin, workspace, label });
    }
  });

  // 5. 项目 → 工作路径 → 行
  const projects = new Map<string, ProjectGroup>();
  const paths = new Map<string, PathGroup>();
  const projectGroup = (id: ProjectGroup['id']): ProjectGroup => {
    let g = projects.get(id);
    if (!g) {
      const p = id === 'loose' || id === 'other' ? undefined : input.projects.find((x) => x.id === id);
      const name = id === 'loose' ? 'Not in a workspace' : id === 'other' ? 'Other folders' : (p?.name ?? 'Unknown project');
      g = { id, name, path: p?.path ?? null, updatedAt: '', paths: [] };
      projects.set(id, g);
    }
    return g;
  };
  const pathGroup = (place: Place): PathGroup => {
    let g = paths.get(place.key);
    if (!g) {
      g = { ...place.base, key: place.key, count: 0, updatedAt: '', rows: [] };
      paths.set(place.key, g);
      projectGroup(place.projectId).paths.push(g);
    }
    return g;
  };
  if (!q) {
    // 不搜索时：每个项目都列出来，白板上有框的工作区即使没有会话也列出来
    for (const p of input.projects) projectGroup(p.id);
    for (const f of input.frames) {
      const ws = input.workspaces[f.workspaceId];
      if (ws && projectName.has(ws.projectId)) pathGroup(workspacePlace(ws, onBoard));
    }
  }
  for (const r of shown) {
    if (taken.has(r.row.key)) continue;
    const g = pathGroup(r.place);
    g.rows.push(r.row);
    g.count += 1;
    if (r.row.updatedAt > g.updatedAt) g.updatedAt = r.row.updatedAt;
  }
  // 白板上有框的工作区按框的位置在前，其余按最后活动
  const frameOrder = new Map<string, number>(readingFrames(input).map((id, i) => [`ws:${id}`, i]));
  const out = [...projects.values()];
  for (const p of out) {
    for (const path of p.paths) {
      const open = path.rows.filter((r) => r.open);
      const closed = path.rows.filter((r) => !r.open).sort(newer);
      path.rows = [...open, ...closed];
    }
    p.paths.sort((a, b) => {
      const fa = frameOrder.get(a.key);
      const fb = frameOrder.get(b.key);
      if (fa !== undefined || fb !== undefined) return fa === undefined ? 1 : fb === undefined ? -1 : fa - fb;
      return newer(a, b);
    });
    p.updatedAt = p.paths.reduce((m, x) => (x.updatedAt > m ? x.updatedAt : m), '');
  }
  const rank = (g: ProjectGroup) => (g.id === 'other' ? 3 : g.id === 'loose' ? 2 : g.id === input.activeProjectId ? 0 : 1);
  const listed = new Map<string, number>(input.projects.map((p, i) => [p.id, i]));
  return {
    needsYou: needs,
    pinned,
    projects: out
      .filter((g) => g.paths.length > 0 || (g.id !== 'loose' && g.id !== 'other'))
      .sort((a, b) => rank(a) - rank(b) || newer(a, b) || (listed.get(a.id) ?? 0) - (listed.get(b.id) ?? 0)),
  };
}

type BoardPinSessionId = Extract<BoardPin, { kind: 'session' }>['sessionId'];

/** 框的工作区 id，按白板上的位置。 */
function readingFrames(input: Pick<BoardInput, 'frames'>): string[] {
  return readingOrder(input.frames, (f) => f.rect).map((f) => f.workspaceId);
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
