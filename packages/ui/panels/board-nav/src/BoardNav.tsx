// 快速定位列表（MVP v2 · V5）：什么都没选中时右侧面板显示整块白板的目录。
// 项目 → 工作区（分支）→ 窗口（状态灯、名字、对话主题）；单击一行由组装方跳过去（和 ⌘J 一样平移、闪一下、聚焦）。
// 白板数据由组装方用普通 props 传进来；对话主题自己从 window.agentdeck.terminals.list() 取。
// CO4：顶上 Board / Agents 切换（记住上次选的）。Agents 只列 agent 终端，按状态分组，悬停看最后一条回复（AgentsView.tsx）。

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import type { WindowId } from '@agentdeck/contracts';
import { buildAgents } from './agents.ts';
import { AgentsView } from './AgentsView.tsx';
import { screenReplyReader, type LastReplyReader } from './lastReply.ts';
import { buildTree, LAMP_LABEL, type BoardNavInput, type NavWindow } from './model.ts';
import { useTopics, type BoardNavApi } from './useTopics.ts';
import './board-nav.css';

export type BoardNavView = 'board' | 'agents';

/** 上次选的视图记在这里（每台电脑一份；读写失败就当 Board）。 */
export const VIEW_STORAGE_KEY = 'agentdeck.board-nav.view';

function loadView(): BoardNavView {
  try {
    return globalThis.localStorage?.getItem(VIEW_STORAGE_KEY) === 'agents' ? 'agents' : 'board';
  } catch {
    return 'board';
  }
}

function saveView(view: BoardNavView): void {
  try {
    globalThis.localStorage?.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    // 存不下就只在这次记住
  }
}

export interface BoardNavProps extends BoardNavInput {
  /** 单击一行。组装方平移白板、让窗口闪一下并聚焦它。 */
  onJump(windowId: WindowId): void;
  /** 默认 window.agentdeck。测试传假实现。 */
  api?: BoardNavApi;
  /** 对话主题多久刷新一次，默认 3 秒。 */
  refreshMs?: number;
  /** 标题栏右边的按钮，例如白板给的收起面板按钮（MVP v2 · V4）。 */
  headerActions?: ReactNode;
  /**
   * Agents 视图悬停提示里的最后一条回复。默认读屏幕最后几行（terminals.lastLines）认出回复；
   * 应用里传 agentReplyReader(api)：先读会话记录（contracts 0.1.22 的 agents.lastReply），读不到再认屏幕。
   */
  lastReply?: LastReplyReader;
  /** 测试用：固定 “现在”。 */
  now?: number;
}

export function BoardNav(props: BoardNavProps) {
  const { projects, workspaces, frames, windows, statuses, badges, onJump, api: apiProp, refreshMs, headerActions, lastReply, now } = props;
  const api = apiProp ?? window.agentdeck;
  const [view, setView] = useState<BoardNavView>(loadView);
  const choose = useCallback((next: BoardNavView) => {
    setView(next);
    saveView(next);
  }, []);
  const readReply = useMemo(() => lastReply ?? screenReplyReader(api), [lastReply, api]);
  const agents = useMemo(
    () => buildAgents({ projects, workspaces, frames, windows, statuses, badges }),
    [projects, workspaces, frames, windows, statuses, badges],
  );

  return (
    <nav className="bnav" aria-label="Board">
      <div className="bnav-top">
        <h2 className="bnav-title">{view === 'agents' ? `AGENTS · ${agents.rows.length}` : 'BOARD'}</h2>
        <ViewSwitch view={view} onChange={choose} />
        {headerActions}
      </div>
      <div className="bnav-body">
        {view === 'agents' ? (
          <AgentsView view={agents} onJump={onJump} readReply={readReply} now={now} />
        ) : (
          <BoardTree {...{ projects, workspaces, frames, windows, statuses, badges }} api={api} refreshMs={refreshMs} onJump={onJump} />
        )}
      </div>
    </nav>
  );
}

/** Board / Agents 两段的切换（按下的那段 `--hover` 底 + 600，和选中的行一样）。 */
function ViewSwitch({ view, onChange }: { view: BoardNavView; onChange(view: BoardNavView): void }) {
  return (
    <div className="bnav-switch" role="group" aria-label="View">
      {(['board', 'agents'] as const).map((v) => (
        <button key={v} type="button" className="bnav-switch-btn" aria-pressed={view === v} onClick={() => onChange(v)}>
          {v === 'board' ? 'Board' : 'Agents'}
        </button>
      ))}
    </div>
  );
}

/** Board 视图：项目 → 工作区（分支）→ 窗口。对话主题只在这个视图开着时取。 */
function BoardTree(props: BoardNavInput & { api: BoardNavApi; refreshMs: number | undefined; onJump(id: WindowId): void }) {
  const { projects, workspaces, frames, windows, statuses, badges, api, refreshMs, onJump } = props;
  const topics = useTopics(api, refreshMs);
  const tree = useMemo(
    () => buildTree({ projects, workspaces, frames, windows, statuses, badges }),
    [projects, workspaces, frames, windows, statuses, badges],
  );
  const empty = tree.projects.length === 0 && tree.loose.length === 0;
  return (
    <>
        {empty ? <p className="bnav-note">Nothing on the board yet.</p> : null}
        {tree.projects.map((p) => (
          <section className="bnav-project" key={p.id} aria-label={p.name}>
            <h3 className="bnav-project-name">{p.name}</h3>
            {p.workspaces.length === 0 ? <p className="bnav-note bnav-indent-1">no workspaces</p> : null}
            {p.workspaces.map((ws) => (
              <div className="bnav-workspace" key={ws.id} role="group" aria-label={`${p.name} · ${ws.label}`}>
                <div className={`bnav-workspace-name bnav-indent-1${ws.isBranch ? ' bnav-mono' : ''}`}>{ws.label}</div>
                {ws.windows.length === 0 ? <p className="bnav-note bnav-indent-2">no windows</p> : null}
                <WindowRows windows={ws.windows} topics={topics} onJump={onJump} />
              </div>
            ))}
          </section>
        ))}
        {tree.loose.length > 0 ? (
          <section className="bnav-project" aria-label="Not in a workspace">
            <h3 className="bnav-project-name">Not in a workspace</h3>
            <WindowRows windows={tree.loose} topics={topics} onJump={onJump} />
          </section>
        ) : null}
    </>
  );
}

function WindowRows({ windows, topics, onJump }: { windows: NavWindow[]; topics: Readonly<Record<string, string>>; onJump(id: WindowId): void }) {
  if (windows.length === 0) return null;
  return (
    <ul className="bnav-windows">
      {windows.map((w) => {
        const topic = w.terminalId ? (topics[w.terminalId] ?? null) : null;
        // 读屏念的名字：“claude, Running, Check local git history”；窗口组里 “claude sub-1 · api, Running”
        const name = w.group ? `${w.name} ${w.group}` : w.name;
        const label = [name, w.detail ?? (w.lamp ? LAMP_LABEL[w.lamp] : null), topic].filter(Boolean).join(', ');
        return (
          <li key={w.id}>
            <button
              type="button"
              className={`bnav-row bnav-indent-2${w.waiting ? ' bnav-row--waiting' : ''}`}
              data-window-id={w.id}
              aria-label={label}
              onClick={() => onJump(w.id)}
            >
              {w.lamp ? (
                <span className={`bnav-lamp bnav-lamp--${w.lamp}`} aria-hidden="true" title={w.detail ?? LAMP_LABEL[w.lamp]} />
              ) : (
                <WindowIcon />
              )}
              <span className={`bnav-name${w.kind === 'terminal' ? ' bnav-mono' : ''}`}>{w.name}</span>
              {/* 窗口组（N2）：和标题栏一样，名字后面灰字 “lead” / “sub-1 · api” */}
              {w.group ? <span className="bnav-group bnav-mono">{w.group}</span> : null}
              {w.waiting ? (
                <span className="bnav-waiting" title={w.detail ?? undefined}>
                  · Waiting
                </span>
              ) : null}
              {topic ? <span className="bnav-topic">· {topic}</span> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** 网页等没有状态灯的窗口：一个小窗口图标。 */
function WindowIcon() {
  return (
    <svg className="bnav-icon" viewBox="0 0 10 10" width="10" height="10" aria-hidden="true" data-icon="window">
      <rect x="0.75" y="0.75" width="8.5" height="8.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1" />
      <line x1="0.75" y1="3.25" x2="9.25" y2="3.25" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}
