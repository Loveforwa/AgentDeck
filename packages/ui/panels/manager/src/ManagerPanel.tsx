// 左边管理面板（MP2，画板“左边管理面板”MP0，2026-10-30 用户确认）：取代 N11 的历史会话和 V5 / CO4 的 BoardNav。
// 从上到下：标题（白板名）· New、Search · NEEDS YOU · PINNED · 项目 → 工作路径 → 行 · Other folders。
// 一个终端只有一行：开着的有状态灯，单击跳到它的窗口；关掉的写时间，单击在它的工作区框里 Resume。悬停出 ⋯，右键同一个菜单。
// 会话列表从 window.agentdeck.history.list() 取，每 15 秒刷新；对话主题从 terminals.list() 取。
// 白板数据和动作由组装方（apps/desktop）用 props 给，不 import 白板内部，也不 import 别的面板。

import { useCallback, useEffect, useId, useMemo, useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from 'react';
import type { AgentDeckApi, AgentKind, BoardPin, ProjectId, SessionSummary, WorkspaceId } from '@agentdeck/contracts';
import { boardPinKey } from '@agentdeck/contracts';
import { Menu, Popover, type MenuEntry, type PopoverAnchor } from '@agentdeck/ui-kit';
import { LAMP_LABEL, rowShortcut, statusText, type BoardInput } from './board.ts';
import { screenReplyReader, type LastReplyReader } from './lastReply.ts';
import { buildManager, relativeTime, sessionDetails, type PathGroup, type PathRef, type PinnedItem, type ProjectGroup, type Row } from './model.ts';
import { focusVisible, ReplyTip, TIP_DELAY_MS, useReplyTip } from './ReplyTip.tsx';
import { useTopics } from './useTopics.ts';
import './manager.css';

export const HISTORY_REFRESH_MS = 15_000;
/** Other folders 开着没有，记在这台电脑的浏览器存储里（每个人自己的习惯，不随白板走）。默认收着。 */
export const OTHER_OPEN_KEY = 'agentdeck.history.otherFoldersOpen';
/** 每个工作路径先显示几行（开着的总是都显示）。 */
export const FIRST_ROWS = 5;
/** 时长（“4m”）多久刷新一次，和标题栏一样。 */
const TICK_MS = 30_000;
/** 拖动置顶换顺序时 dataTransfer 里的类型。 */
const PIN_DRAG_TYPE = 'application/x-agentdeck-pin';

/** 不能 fork 的 agent（X4：kimi 没有 fork 参数）。 */
const NO_FORK = new Set<AgentKind>(['kimi']);

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

export type ManagerApi = Pick<AgentDeckApi, 'terminals' | 'on'>;

export interface ManagerPanelProps extends BoardInput {
  /** 标题：白板名。 */
  title: string;
  /** 置顶（BoardState.pins），按置顶的先后。 */
  pins: readonly BoardPin[];
  /** 顶栏选中的项目，放最上面。 */
  activeProjectId: ProjectId | null;
  /** New 菜单的项（和右键白板同一份：Terminal ▸、Browser、Workspace…、Add project…），打开时取。 */
  newMenu(): MenuEntry[];
  /** Fork into ▸ 里列的工作区。 */
  forkTargets: readonly { id: WorkspaceId; label: string }[];
  onTogglePin(pin: BoardPin): void;
  /** 拖动置顶换顺序：第 from 项挪到第 to 项的位置（BoardState.pins 里的下标）。 */
  onMovePin(from: number, to: number): void;
  /** 单击开着的一行：跳过去、闪一下并聚焦（⌘J 的走法）。 */
  onJump(windowId: string): void;
  /** Resume：在 path 那个工作区的框里（没有工作区时散放）开一个终端接着这段对话。 */
  onResume(session: SessionSummary, path: PathRef): void;
  onFork(session: SessionSummary, workspaceId: WorkspaceId): void;
  onCopyId(sessionId: string): void;
  onReveal(session: SessionSummary): void;
  onRename(windowId: string): void;
  onClose(windowId: string): void;
  /** 单击置顶的工作路径：框不在白板上就放上来，然后选中它、缩放到它。 */
  onOpenWorkspace(workspaceId: WorkspaceId): void;
  /** 默认 window.agentdeck.history.list。 */
  load?: () => Promise<SessionSummary[]>;
  refreshMs?: number;
  /** 对话主题用；默认 window.agentdeck。 */
  api?: ManagerApi;
  /** 悬停提示的最后一条回复：应用里先读会话记录（agentReplyReader），默认只认屏幕。 */
  lastReply?: LastReplyReader;
  /** 测试用：固定 “现在”。 */
  now?: () => number;
  /** 标题栏右边的按钮（收起左边栏）。 */
  headerActions?: ReactNode;
  /** 家目录，目录写成 ~ 开头。 */
  home?: string | null;
}

function useSessions(load: () => Promise<SessionSummary[]>, refreshMs: number): { sessions: SessionSummary[] | null; error: boolean } {
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

function useNow(fixed: (() => number) | undefined): number {
  const [now, setNow] = useState(() => (fixed ?? Date.now)());
  useEffect(() => {
    if (fixed) return;
    const t = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(t);
  }, [fixed]);
  return fixed ? fixed() : now;
}

interface OpenMenu {
  anchor: PopoverAnchor;
  items: MenuEntry[];
  label: string;
}

export function ManagerPanel(props: ManagerPanelProps) {
  const { pins, headerActions } = props;
  const defaultLoad = useCallback(() => window.agentdeck.history.list(), []);
  const { sessions, error } = useSessions(props.load ?? defaultLoad, props.refreshMs ?? HISTORY_REFRESH_MS);
  const topics = useTopics(props.api ?? window.agentdeck);
  const readReply = useMemo(() => props.lastReply ?? screenReplyReader(props.api ?? window.agentdeck), [props.lastReply, props.api]);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const q = searching ? query.trim() : '';
  const view = useMemo(
    () =>
      buildManager({
        projects: props.projects,
        workspaces: props.workspaces,
        frames: props.frames,
        windows: props.windows,
        statuses: props.statuses,
        badges: props.badges,
        sessions: sessions ?? [],
        pins,
        activeProjectId: props.activeProjectId,
        query: q,
        topics,
        home: props.home ?? null,
      }),
    [props.projects, props.workspaces, props.frames, props.windows, props.statuses, props.badges, sessions, pins, props.activeProjectId, q, topics, props.home],
  );
  const pinKeys = useMemo(() => new Set(pins.map(boardPinKey)), [pins]);
  const now = useNow(props.now);

  // 展开 / 收起：工作路径没动过的照默认（白板上有框的、有开着的窗口的、搜索时都展开）；项目默认展开，Other folders 默认收着
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [otherOpen, setOtherOpen] = useState(readOtherOpen);
  const pathOpen = (p: PathGroup) => toggled[p.key] ?? (q !== '' || p.onBoard || p.rows.some((r) => r.open));
  const projectOpen = (g: ProjectGroup) => q !== '' || (g.id === 'other' ? otherOpen : !collapsed[g.id]);
  const toggleProject = (g: ProjectGroup) => {
    if (g.id === 'other') {
      saveOtherOpen(!otherOpen);
      setOtherOpen(!otherOpen);
    } else setCollapsed((c) => ({ ...c, [g.id]: !c[g.id] }));
  };
  const sections = useRef(new Map<string, HTMLElement>());
  const goToProject = (id: ProjectId) => {
    setCollapsed((c) => ({ ...c, [id]: false }));
    requestAnimationFrame(() => sections.current.get(id)?.scrollIntoView?.({ block: 'start' }));
  };

  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const newButton = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const tipId = useId();
  const { tip, show, hide, replyOf } = useReplyTip(readReply);
  const tipRow = tip ? findRow(view, tip.row.key) : undefined;
  useEffect(() => {
    if (tip && !tipRow) hide();
  }, [tip, tipRow, hide]);

  const pinItem = (pin: BoardPin): MenuEntry => ({
    id: 'pin',
    label: pinKeys.has(boardPinKey(pin)) ? 'Unpin' : 'Pin',
    onSelect: () => props.onTogglePin(pin),
  });

  const rowMenu = (row: Row): MenuEntry[] => {
    const s = row.session;
    const sessionId = s?.id ?? row.open?.sessionId ?? null;
    const copy: MenuEntry[] = sessionId ? [{ id: 'copy-id', label: 'Copy session id', onSelect: () => props.onCopyId(sessionId) }] : [];
    if (row.open) {
      const id = row.open.id;
      return [
        { id: 'open', label: 'Open', shortcut: '↩', onSelect: () => props.onJump(id) },
        pinItem(row.pin),
        { id: 'rename', label: 'Rename…', onSelect: () => props.onRename(id) },
        ...copy,
        { type: 'separator' },
        { id: 'close', label: row.open.kind === 'terminal' ? 'Close terminal' : 'Close window', onSelect: () => props.onClose(id) },
      ];
    }
    if (!s) return [];
    const noFork = NO_FORK.has(s.agent);
    return [
      { id: 'resume', label: 'Resume', shortcut: '↩', onSelect: () => props.onResume(s, row.path) },
      pinItem(row.pin),
      {
        id: 'fork',
        label: 'Fork into…',
        disabled: noFork || props.forkTargets.length === 0,
        ...(noFork ? { hint: `${s.agent} can’t fork` } : props.forkTargets.length === 0 ? { hint: 'No workspaces' } : {}),
        items: props.forkTargets.map((t) => ({ id: `fork-${t.id}`, label: t.label, onSelect: () => props.onFork(s, t.id) })),
      },
      ...copy,
      { id: 'reveal', label: 'Reveal in Finder', onSelect: () => props.onReveal(s) },
    ];
  };

  const openMenu = (anchor: PopoverAnchor, items: MenuEntry[], label: string) => {
    hide();
    if (items.length) setMenu({ anchor, items, label });
  };
  const atPointer = (e: MouseEvent) => {
    e.preventDefault();
    return { x: e.clientX, y: e.clientY };
  };
  const activate = (row: Row) => {
    hide();
    if (row.open) props.onJump(row.open.id);
    else if (row.session) props.onResume(row.session, row.path);
  };

  const rowProps = (row: Row, shortcut: string | null = null) => ({
    row,
    now,
    tipId: tip?.row.key === row.key ? tipId : undefined,
    onActivate: () => activate(row),
    onMenu: (anchor: PopoverAnchor) => openMenu(anchor, rowMenu(row), row.title),
    onContextMenu: (e: MouseEvent) => openMenu(atPointer(e), rowMenu(row), row.title),
    onHover: (el: HTMLElement, delay: number) => {
      if (row.open?.kind === 'terminal' && row.agent !== 'shell' && row.agent !== 'custom') show(row, shortcut, el, delay);
    },
    onLeave: hide,
  });

  const stopSearch = () => {
    setSearching(false);
    setQuery('');
  };
  useEffect(() => {
    if (searching) searchInput.current?.focus();
  }, [searching]);

  const loading = sessions === null && !error;
  const nothing = view.needsYou.length === 0 && view.pinned.length === 0 && view.projects.every((p) => p.paths.every((x) => x.rows.length === 0));

  return (
    <nav className="mgr" aria-label="Manager">
      <div className="mgr-top">
        <h2 className="mgr-title">{props.title}</h2>
        <span className="mgr-spacer" />
        {headerActions}
      </div>
      <div className="mgr-actions">
        <button
          ref={newButton}
          type="button"
          className="mgr-action"
          aria-haspopup="menu"
          aria-expanded={menu?.label === 'New'}
          onClick={() => openMenu(newButton, [{ type: 'heading', label: 'NEW' }, ...props.newMenu()], 'New')}
        >
          <PlusIcon />
          New
        </button>
        {searching ? (
          <input
            ref={searchInput}
            className="mgr-search"
            type="search"
            placeholder="Search"
            aria-label="Search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                stopSearch();
              }
            }}
            onBlur={() => {
              if (!query.trim()) stopSearch();
            }}
          />
        ) : (
          <button type="button" className="mgr-action" onClick={() => setSearching(true)}>
            <SearchIcon />
            Search
          </button>
        )}
      </div>
      <div className="mgr-body">
        {error && sessions === null ? <p className="mgr-note">Couldn’t read the session history.</p> : null}
        {!loading && nothing ? <p className="mgr-note">{q ? 'No matches.' : 'Nothing here yet. Use New to start a terminal.'}</p> : null}

        {view.needsYou.length > 0 ? (
          <section className="mgr-section mgr-needs" aria-label="Needs you">
            <h3 className="mgr-heading">NEEDS YOU · {view.needsYou.length}</h3>
            <ul className="mgr-rows">
              {view.needsYou.map((row, i) => (
                <RowItem key={row.key} {...rowProps(row, rowShortcut(i))} showWhere attention />
              ))}
            </ul>
          </section>
        ) : null}

        {view.pinned.length > 0 ? (
          <section className="mgr-section" aria-label="Pinned">
            <h3 className="mgr-heading">
              <PinIcon />
              PINNED
            </h3>
            <ul className="mgr-rows">
              {view.pinned.map((item) => (
                <PinnedRow
                  key={boardPinKey(item.pin)}
                  item={item}
                  onMove={props.onMovePin}
                  {...(item.kind === 'row'
                    ? { rowProps: rowProps(item.row) }
                    : {
                        onActivate: () => (item.kind === 'project' ? goToProject(item.project.id) : props.onOpenWorkspace(item.workspace.id)),
                        onContextMenu: (e: MouseEvent) => openMenu(atPointer(e), [pinItem(item.pin)], 'Pinned'),
                      })}
                />
              ))}
            </ul>
          </section>
        ) : null}

        {view.projects.map((g) => {
          const isOpen = projectOpen(g);
          const pin: BoardPin | null = g.id === 'loose' || g.id === 'other' ? null : { kind: 'project', projectId: g.id };
          const total = g.paths.reduce((n, x) => n + x.count, 0);
          return (
            <section
              className="mgr-project"
              key={g.id}
              aria-label={g.name}
              ref={(el) => {
                if (el) sections.current.set(g.id, el);
                else sections.current.delete(g.id);
              }}
            >
              <h3 className="mgr-project-name">
                <button
                  type="button"
                  className="mgr-project-row"
                  aria-expanded={isOpen}
                  title={g.path ?? undefined}
                  onClick={() => toggleProject(g)}
                  onContextMenu={pin ? (e) => openMenu(atPointer(e), [pinItem(pin)], g.name) : undefined}
                >
                  <span className="mgr-project-label">{g.name}</span>
                  {g.id === 'other' ? <span className="mgr-muted mgr-detail">not in AgentDeck</span> : null}
                  <span className="mgr-spacer" />
                  {!isOpen ? <span className="mgr-count">{total}</span> : null}
                  <span className="mgr-caret" aria-hidden="true">
                    {isOpen ? '▾' : '▸'}
                  </span>
                </button>
              </h3>
              {isOpen && g.paths.length === 0 ? <p className="mgr-note mgr-indent">No workspaces on the board.</p> : null}
              {isOpen
                ? g.paths.map((path) =>
                    g.id === 'loose' ? (
                      <ul className="mgr-rows" key={path.key}>
                        {path.rows.map((row) => (
                          <RowItem key={row.key} {...rowProps(row)} />
                        ))}
                      </ul>
                    ) : (
                      <PathSection
                        key={path.key}
                        project={g}
                        path={path}
                        open={pathOpen(path)}
                        onToggle={() => setToggled((t) => ({ ...t, [path.key]: !pathOpen(path) }))}
                        onContextMenu={path.workspaceId ? (e) => openMenu(atPointer(e), [pinItem({ kind: 'workspace', workspaceId: path.workspaceId! })], path.label) : undefined}
                        renderRow={(row) => <RowItem key={row.key} {...rowProps(row)} />}
                      />
                    ),
                  )
                : null}
            </section>
          );
        })}
      </div>
      {menu ? (
        <Popover open anchor={menu.anchor} placement="bottom-start" chrome={false} autoFocus={false} onClose={() => setMenu(null)}>
          <Menu items={menu.items} aria-label={menu.label} onClose={() => setMenu(null)} onSelect={() => setMenu(null)} />
        </Popover>
      ) : null}
      {tip && tipRow ? <ReplyTip id={tipId} target={tip} row={tipRow} now={now} reply={replyOf(tipRow)} /> : null}
    </nav>
  );
}

function findRow(view: ReturnType<typeof buildManager>, key: string): Row | undefined {
  return (
    view.needsYou.find((r) => r.key === key) ??
    view.pinned.flatMap((p) => (p.kind === 'row' ? [p.row] : [])).find((r) => r.key === key) ??
    view.projects.flatMap((g) => g.paths.flatMap((p) => p.rows)).find((r) => r.key === key)
  );
}

function PathSection(props: {
  project: ProjectGroup;
  path: PathGroup;
  open: boolean;
  onToggle(): void;
  onContextMenu: ((e: MouseEvent) => void) | undefined;
  renderRow(row: Row): ReactNode;
}) {
  const { project, path, open } = props;
  const [all, setAll] = useState(false);
  const first = Math.max(FIRST_ROWS, path.rows.filter((r) => r.open).length);
  const rows = all ? path.rows : path.rows.slice(0, first);
  return (
    <div className="mgr-path" role="group" aria-label={`${project.name} · ${path.label}`}>
      <button type="button" className="mgr-path-row" aria-expanded={open} title={path.cwd ?? undefined} onClick={props.onToggle} onContextMenu={props.onContextMenu}>
        <span className="mgr-caret" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className={path.mono ? 'mgr-path-label mgr-mono' : 'mgr-path-label'}>{path.label}</span>
        {path.detail ? <span className="mgr-muted mgr-detail">{path.detail}</span> : null}
        <span className="mgr-spacer" />
        <span className="mgr-count">{path.count}</span>
      </button>
      {open ? (
        <>
          {path.rows.length === 0 ? <p className="mgr-note mgr-indent">No sessions yet.</p> : null}
          <ul className="mgr-rows">{rows.map((r) => props.renderRow(r))}</ul>
          {path.rows.length > first ? (
            <button type="button" className="mgr-more" onClick={() => setAll(!all)}>
              {all ? 'Show fewer' : `Show ${path.rows.length - first} more`}
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

interface RowItemProps {
  row: Row;
  now: number;
  tipId: string | undefined;
  /** NEEDS YOU、PINNED 里写上在哪（“shop · feat/login”）。 */
  showWhere?: boolean;
  /** NEEDS YOU：浅黄底。 */
  attention?: boolean;
  onActivate(): void;
  onMenu(anchor: PopoverAnchor): void;
  onContextMenu(e: MouseEvent): void;
  onHover(el: HTMLElement, delay: number): void;
  onLeave(): void;
  /** 置顶的行可以拖动换顺序。 */
  drag?: DragProps;
}

interface DragProps {
  draggable: true;
  onDragStart(e: DragEvent): void;
  onDragOver(e: DragEvent): void;
  onDrop(e: DragEvent): void;
}

function RowItem(props: RowItemProps) {
  const { row, now, showWhere, attention } = props;
  const more = useRef<HTMLButtonElement>(null);
  const o = row.open;
  const right = o ? statusText(o, now) : relativeTime(row.updatedAt, now);
  const details = row.session ? sessionDetails(row.session) : row.title;
  const label = [row.title, o?.group, o ? (o.detail ?? (o.lamp ? LAMP_LABEL[o.lamp] : 'Open')) : null, showWhere ? row.where : null].filter(Boolean).join(', ');
  return (
    <li
      className={`mgr-row${o ? ' mgr-row--open' : ''}${attention && o?.waiting ? ' mgr-row--waiting' : ''}`}
      data-key={row.key}
      data-window-id={o?.id}
      {...props.drag}
    >
      <button
        type="button"
        className="mgr-row-main"
        title={o ? undefined : details}
        aria-label={label}
        aria-describedby={props.tipId}
        onClick={props.onActivate}
        onContextMenu={props.onContextMenu}
        onMouseEnter={(e) => props.onHover(e.currentTarget, TIP_DELAY_MS)}
        onMouseLeave={props.onLeave}
        onFocus={(e) => {
          if (focusVisible(e.currentTarget)) props.onHover(e.currentTarget, 0);
        }}
        onBlur={props.onLeave}
      >
        {o?.lamp ? <span className={`mgr-lamp mgr-lamp--${o.lamp}`} aria-hidden="true" title={o.detail ?? LAMP_LABEL[o.lamp]} /> : <span className="mgr-lamp-space" aria-hidden="true" />}
        {row.agent ? <span className="mgr-agent" data-agent={row.agent} aria-hidden="true" title={row.agent} /> : <WindowIcon />}
        <span className="mgr-row-title">{row.title}</span>
        {o?.group ? <span className="mgr-muted mgr-mono mgr-group">{o.group}</span> : null}
        {showWhere && row.where ? <span className="mgr-muted mgr-where">{row.where}</span> : null}
        <span className="mgr-spacer" />
        {right ? <span className={`mgr-time${o?.waiting ? ' mgr-time--waiting' : o?.lamp === 'error' ? ' mgr-time--error' : ''}`}>{right}</span> : null}
      </button>
      <button
        ref={more}
        type="button"
        className="mgr-more-btn"
        aria-label={`More for ${row.title}`}
        aria-haspopup="menu"
        onClick={() => props.onMenu(more)}
      >
        ⋯
      </button>
    </li>
  );
}

function PinnedRow(props: {
  item: PinnedItem;
  onMove(from: number, to: number): void;
  rowProps?: Omit<RowItemProps, 'drag'>;
  onActivate?(): void;
  onContextMenu?(e: MouseEvent): void;
}) {
  const { item } = props;
  const drag: DragProps = {
    draggable: true,
    onDragStart: (e) => {
      e.dataTransfer.setData(PIN_DRAG_TYPE, String(item.index));
      e.dataTransfer.effectAllowed = 'move';
    },
    onDragOver: (e) => {
      if (e.dataTransfer.types.includes(PIN_DRAG_TYPE)) e.preventDefault();
    },
    onDrop: (e) => {
      const from = Number(e.dataTransfer.getData(PIN_DRAG_TYPE));
      if (!Number.isInteger(from)) return;
      e.preventDefault();
      props.onMove(from, item.index);
    },
  };
  if (item.kind === 'row' && props.rowProps) return <RowItem {...props.rowProps} showWhere drag={drag} />;
  const name = item.kind === 'project' ? item.project.name : item.kind === 'workspace' ? item.label : '';
  return (
    <li className="mgr-row" data-key={boardPinKey(item.pin)} {...drag}>
      <button type="button" className="mgr-row-main" aria-label={name} onClick={props.onActivate} onContextMenu={props.onContextMenu}>
        <span className="mgr-lamp-space" aria-hidden="true" />
        <FolderIcon />
        <span className={item.kind === 'workspace' ? 'mgr-row-title' : 'mgr-row-title mgr-strong'}>{name}</span>
      </button>
    </li>
  );
}

function PlusIcon() {
  return (
    <svg className="mgr-icon" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      <path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg className="mgr-icon" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      <circle cx="5.2" cy="5.2" r="3.4" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M7.8 7.8L10.5 10.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg className="mgr-icon mgr-heading-icon" viewBox="0 0 10 10" width="9" height="9" aria-hidden="true">
      <path d="M3 1h4l-.6 3 1.6 1.6H2L3.6 4 3 1zM5 5.6V9" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg className="mgr-icon" viewBox="0 0 10 10" width="10" height="10" aria-hidden="true" data-icon="folder">
      <path d="M0.75 2.25h3l1 1h4.5v5.5h-8.5z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
    </svg>
  );
}

function WindowIcon() {
  return (
    <svg className="mgr-icon" viewBox="0 0 10 10" width="10" height="10" aria-hidden="true" data-icon="window">
      <rect x="0.75" y="0.75" width="8.5" height="8.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1" />
      <line x1="0.75" y1="3.25" x2="9.25" y2="3.25" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

