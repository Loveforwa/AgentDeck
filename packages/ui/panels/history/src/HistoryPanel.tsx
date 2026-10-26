// 左边栏：历史会话（MVP v3 · N11，画板 14，IS-86，调研 DR-62）。
// 项目 → 工作路径 → agent，会话按最后活动倒序。开着的会话有状态灯，单击跳过去；没开着的悬停出 Resume 和 ⋯
// （Fork into ▸、Copy session id、Reveal in Finder）。会话列表从 window.agentdeck.history.list() 取，开着时每 15 秒刷新一次。
// 白板数据和动作由组装方（apps/desktop）用 props 给，不 import 白板内部，也不 import 别的面板。

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AgentKind, Project, ProjectId, SessionSummary, Workspace, WorkspaceId } from '@agentdeck/contracts';
import { Menu, Popover, type MenuEntry } from '@agentdeck/ui-kit';
import {
  LAMP_LABEL,
  buildHistory,
  relativeTime,
  sessionDetails,
  sessionKey,
  type HistoryFilter,
  type OpenSession,
  type PathGroup,
} from './model.ts';
import './history.css';

export const HISTORY_REFRESH_MS = 15_000;
/** Other folders 开着没有，记在这台电脑的浏览器存储里（每个人自己的习惯，不随白板走）。默认收着。 */
export const OTHER_OPEN_KEY = 'agentdeck.history.otherFoldersOpen';

function readOtherOpen(): boolean {
  try {
    return window.localStorage.getItem(OTHER_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

function saveOtherOpen(open: boolean): void {
  try {
    window.localStorage.setItem(OTHER_OPEN_KEY, open ? '1' : '0');
  } catch {
    // 存不了就只在这次打开时记着
  }
}
/** 每个 agent 先显示几条。 */
export const FIRST_ROWS = 5;

/** 不能 fork 的 agent（X4：kimi 没有 fork 参数）。 */
const NO_FORK = new Set<AgentKind>(['kimi']);

export interface HistoryPanelProps {
  projects: readonly Project[];
  workspaces: Readonly<Record<string, Workspace>>;
  /** 在白板上有框的工作区（这些默认展开）。 */
  onBoard: ReadonlySet<string>;
  /** 顶栏选中的项目，放最上面。 */
  activeProjectId: ProjectId | null;
  /** 白板上开着的会话，按 sessionKey(agent, id)。 */
  open: Readonly<Record<string, OpenSession>>;
  /** Fork into ▸ 里列的工作区。 */
  forkTargets: readonly { id: WorkspaceId; label: string }[];
  /** 单击开着的会话：跳过去并聚焦。 */
  onJump(windowId: string): void;
  /** Resume：在 path 那个工作区的框里（没有工作区时散放）开一个终端接着这段对话。 */
  onResume(session: SessionSummary, path: PathGroup): void;
  onFork(session: SessionSummary, workspaceId: WorkspaceId): void;
  onCopyId(session: SessionSummary): void;
  onReveal(session: SessionSummary): void;
  /** 默认 window.agentdeck.history.list。 */
  load?: () => Promise<SessionSummary[]>;
  refreshMs?: number;
  now?: () => number;
  /** 标题栏右边的按钮（收起左边栏）。 */
  headerActions?: ReactNode;
  /** 家目录，目录写成 ~ 开头。 */
  home?: string | null;
}

function useSessions(
  load: () => Promise<SessionSummary[]>,
  refreshMs: number,
): { sessions: SessionSummary[] | null; error: boolean } {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let alive = true;
    const tick = () =>
      load().then(
        (list) => {
          if (!alive) return;
          setSessions(list);
          setError(false);
        },
        () => {
          if (alive) setError(true);
        },
      );
    void tick();
    const t = setInterval(() => void tick(), refreshMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [load, refreshMs]);
  return { sessions, error };
}

export function HistoryPanel(props: HistoryPanelProps) {
  const { projects, workspaces, onBoard, activeProjectId, open, headerActions } = props;
  const defaultLoad = useCallback(() => window.agentdeck.history.list(), []);
  const { sessions, error } = useSessions(props.load ?? defaultLoad, props.refreshMs ?? HISTORY_REFRESH_MS);
  const [query, setQuery] = useState('');
  const filter: HistoryFilter = useMemo(() => ({ query, agent: null }), [query]);
  const tree = useMemo(
    () =>
      sessions
        ? buildHistory({ sessions, projects, workspaces, onBoard, activeProjectId, filter, home: props.home ?? null })
        : [],
    [sessions, projects, workspaces, onBoard, activeProjectId, filter, props.home],
  );
  // 展开 / 收起记在这里（按工作路径）；没动过的照默认：白板上有框的、在搜索时都展开
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const expanded = (p: PathGroup) => toggled[p.key] ?? (query.trim() !== '' || p.onBoard);
  // Other folders（不在 AgentDeck 里的目录）默认收着，只露标题和会话数；搜索时照常展开（2026-10-26 用户定）
  const [otherOpen, setOtherOpen] = useState(readOtherOpen);
  const toggleOther = () => {
    saveOtherOpen(!otherOpen);
    setOtherOpen(!otherOpen);
  };
  const now = (props.now ?? Date.now)();

  return (
    <nav className="hist" aria-label="History">
      <div className="hist-top">
        <h2 className="hist-title">HISTORY</h2>
        <span className="hist-spacer" />
        {headerActions}
      </div>
      <div className="hist-tools">
        <input
          className="hist-search"
          type="search"
          placeholder="Search sessions"
          aria-label="Search sessions"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="hist-body">
        {sessions === null && !error ? <p className="hist-note">Reading sessions…</p> : null}
        {error && sessions === null ? <p className="hist-note">Couldn’t read the session history.</p> : null}
        {sessions !== null && tree.length === 0 ? (
          <p className="hist-note">{query ? 'No matching sessions.' : 'No sessions yet.'}</p>
        ) : null}
        {tree.map((p) => {
          const isOther = p.id === 'other';
          const showPaths = !isOther || otherOpen || query.trim() !== '';
          return (
            <section className="hist-project" key={p.id} aria-label={p.name}>
              {isOther ? (
                <h3 className="hist-project-name">
                  <button
                    type="button"
                    className="hist-path-row hist-other-row"
                    aria-expanded={showPaths}
                    onClick={toggleOther}
                  >
                    <span className="hist-caret" aria-hidden="true">
                      {showPaths ? '▾' : '▸'}
                    </span>
                    <span className="hist-path-label">{p.name}</span>
                    <span className="hist-spacer" />
                    <span className="hist-count">{p.paths.reduce((n, x) => n + x.count, 0)}</span>
                  </button>
                </h3>
              ) : (
                <h3 className="hist-project-name" title={p.path ?? undefined}>
                  {p.name}
                </h3>
              )}
              {(showPaths ? p.paths : []).map((path) => {
                const isOpen = expanded(path);
                return (
                  <div className="hist-path" key={path.key} role="group" aria-label={`${p.name} · ${path.label}`}>
                    <button
                      type="button"
                      className="hist-path-row"
                      aria-expanded={isOpen}
                      title={path.cwd ?? undefined}
                      onClick={() => setToggled((t) => ({ ...t, [path.key]: !isOpen }))}
                    >
                      <span className="hist-caret" aria-hidden="true">
                        {isOpen ? '▾' : '▸'}
                      </span>
                      <span className={path.mono ? 'hist-path-label hist-mono' : 'hist-path-label'}>{path.label}</span>
                      {path.detail ? <span className="hist-muted">{path.detail}</span> : null}
                      <span className="hist-spacer" />
                      <span className="hist-count">{path.count}</span>
                    </button>
                    {isOpen
                      ? path.agents.map((a) => (
                          <AgentRows
                            key={a.agent}
                            {...props}
                            path={path}
                            agent={a.agent}
                            sessions={a.sessions}
                            nowMs={now}
                            open={open}
                          />
                        ))
                      : null}
                  </div>
                );
              })}
            </section>
          );
        })}
      </div>
    </nav>
  );
}

function AgentRows(
  props: HistoryPanelProps & { path: PathGroup; agent: AgentKind; sessions: SessionSummary[]; nowMs: number },
) {
  const { agent, sessions, nowMs, open } = props;
  const [all, setAll] = useState(false);
  const shown = all ? sessions : sessions.slice(0, FIRST_ROWS);
  return (
    <div className="hist-agent" role="group" aria-label={agent}>
      {/* agent 的身份色（2026-10-26 用户定）：方块标记加小标题的字，和圆形的状态灯分开 */}
      <div className="hist-agent-name" data-agent={agent}>
        <span className="hist-agent-mark" aria-hidden="true" />
        {agent.toUpperCase()} · {sessions.length}
      </div>
      <ul className="hist-rows">
        {shown.map((s) => (
          <SessionRow
            key={s.id}
            {...props}
            session={s}
            openAt={open[sessionKey(s.agent, s.id)] ?? null}
            nowMs={nowMs}
          />
        ))}
      </ul>
      {sessions.length > FIRST_ROWS ? (
        <button type="button" className="hist-more" onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show ${sessions.length - FIRST_ROWS} more`}
        </button>
      ) : null}
    </div>
  );
}

function SessionRow(
  props: HistoryPanelProps & { path: PathGroup; session: SessionSummary; openAt: OpenSession | null; nowMs: number },
) {
  const { session: s, openAt, path, nowMs } = props;
  const more = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  const details = sessionDetails(s);
  const items: MenuEntry[] = [
    {
      id: 'fork',
      label: 'Fork into…',
      disabled: NO_FORK.has(s.agent) || props.forkTargets.length === 0,
      ...(NO_FORK.has(s.agent)
        ? { hint: `${s.agent} can’t fork` }
        : props.forkTargets.length === 0
          ? { hint: 'No workspaces' }
          : {}),
      items: props.forkTargets.map((t) => ({
        id: `fork-${t.id}`,
        label: t.label,
        onSelect: () => props.onFork(s, t.id),
      })),
    },
    { id: 'copy-id', label: 'Copy session id', onSelect: () => props.onCopyId(s) },
    { id: 'reveal', label: 'Reveal in Finder', onSelect: () => props.onReveal(s) },
  ];
  return (
    <li className={openAt ? 'hist-row hist-row--open' : 'hist-row'} data-session={sessionKey(s.agent, s.id)}>
      <button
        type="button"
        className="hist-row-main"
        title={openAt ? `${details}\nOn board · ${LAMP_LABEL[openAt.lamp]}` : details}
        aria-label={openAt ? `${s.title}, on board, ${LAMP_LABEL[openAt.lamp]}` : s.title}
        onClick={() => (openAt ? props.onJump(openAt.windowId) : props.onResume(s, path))}
      >
        {openAt ? (
          <span className={`hist-lamp hist-lamp--${openAt.lamp}`} aria-hidden="true" />
        ) : (
          <span className="hist-lamp-space" aria-hidden="true" />
        )}
        <span className="hist-row-title">{s.title}</span>
        <span className="hist-time">{relativeTime(s.updatedAt, nowMs)}</span>
      </button>
      {openAt ? (
        <span className="hist-row-hover hist-muted">On board</span>
      ) : (
        <span className="hist-row-hover">
          <button type="button" className="hist-btn" onClick={() => props.onResume(s, path)}>
            Resume
          </button>
          <button
            ref={more}
            type="button"
            className="hist-btn"
            aria-label="More"
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu(!menu)}
          >
            ⋯
          </button>
          <Popover
            open={menu}
            anchor={more}
            placement="bottom-end"
            chrome={false}
            autoFocus={false}
            onClose={() => setMenu(false)}
          >
            <Menu items={items} onClose={() => setMenu(false)} onSelect={() => setMenu(false)} />
          </Popover>
        </span>
      )}
    </li>
  );
}
