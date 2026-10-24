// 快速定位列表（MVP v2 · V5）：什么都没选中时右侧面板显示整块白板的目录。
// 项目 → 工作区（分支）→ 窗口（状态灯、名字、对话主题）；单击一行由组装方跳过去（和 ⌘J 一样平移、闪一下、聚焦）。
// 白板数据由组装方用普通 props 传进来；对话主题自己从 window.agentdeck.terminals.list() 取。

import { useMemo, type ReactNode } from 'react';
import type { WindowId } from '@agentdeck/contracts';
import { buildTree, LAMP_LABEL, type BoardNavInput, type NavWindow } from './model.ts';
import { useTopics, type BoardNavApi } from './useTopics.ts';
import './board-nav.css';

export interface BoardNavProps extends BoardNavInput {
  /** 单击一行。组装方平移白板、让窗口闪一下并聚焦它。 */
  onJump(windowId: WindowId): void;
  /** 默认 window.agentdeck。测试传假实现。 */
  api?: BoardNavApi;
  /** 对话主题多久刷新一次，默认 3 秒。 */
  refreshMs?: number;
  /** 标题栏右边的按钮，例如白板给的收起面板按钮（MVP v2 · V4）。 */
  headerActions?: ReactNode;
}

export function BoardNav(props: BoardNavProps) {
  const { projects, workspaces, frames, windows, statuses, badges, onJump, api: apiProp, refreshMs, headerActions } = props;
  const api = apiProp ?? window.agentdeck;
  const topics = useTopics(api, refreshMs);
  const tree = useMemo(
    () => buildTree({ projects, workspaces, frames, windows, statuses, badges }),
    [projects, workspaces, frames, windows, statuses, badges],
  );
  const empty = tree.projects.length === 0 && tree.loose.length === 0;

  return (
    <nav className="bnav" aria-label="Board">
      <div className="bnav-top">
        <h2 className="bnav-title">BOARD</h2>
        {headerActions}
      </div>
      <div className="bnav-body">
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
      </div>
    </nav>
  );
}

function WindowRows({ windows, topics, onJump }: { windows: NavWindow[]; topics: Readonly<Record<string, string>>; onJump(id: WindowId): void }) {
  if (windows.length === 0) return null;
  return (
    <ul className="bnav-windows">
      {windows.map((w) => {
        const topic = w.terminalId ? (topics[w.terminalId] ?? null) : null;
        // 读屏念的名字：“claude, Running, Check local git history”
        const label = [w.name, w.detail ?? (w.lamp ? LAMP_LABEL[w.lamp] : null), topic].filter(Boolean).join(', ');
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
