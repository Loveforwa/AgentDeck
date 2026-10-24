import { useRef, useState } from 'react';
import { Button, Menu, Popover, type MenuEntry } from '@agentdeck/ui-kit';
import './topbar.css';

export interface TopbarProps {
  /** 白板名，MVP 只有一块：“My Board”。 */
  boardName?: string;
  workspaces: number;
  terminals: number;
  running: number;
  waiting: number;
  /** 聚焦的窗口是第几个在等你的（从 1 开始），显示成“2/3 waiting”；不在里面时不给。 */
  waitingPosition?: number;
  /** Projects ▾ 菜单的内容，由白板按项目列表生成。 */
  projectsMenu: readonly MenuEntry[];
  /** 单击“n waiting”：跳到下一个在等你的窗口（和 ⌘J 相同）。 */
  onWaitingClick?(): void;
  onSettings?(): void;
}

/** “2 workspaces · 4 terminals” */
export function summaryText(workspaces: number, terminals: number): string {
  return `${plural(workspaces, 'workspace')} · ${plural(terminals, 'terminal')}`;
}

/** “3 waiting”；聚焦的窗口在里面时“2/3 waiting”。 */
export function waitingText(waiting: number, position?: number): string {
  return position && position <= waiting ? `${position}/${waiting} waiting` : `${waiting} waiting`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** 顶栏（任务 B4）：左边白板名和数量，右边 Projects ▾、运行中、在等你、Settings。 */
export function Topbar(props: TopbarProps) {
  const { boardName = 'My Board', workspaces, terminals, running, waiting, projectsMenu } = props;
  const projectsRef = useRef<HTMLButtonElement>(null);
  const [projectsOpen, setProjectsOpen] = useState(false);

  return (
    <header className="ad-topbar">
      <span className="ad-topbar-name">{boardName}</span>
      <span className="ad-topbar-summary">{summaryText(workspaces, terminals)}</span>
      <span className="ad-topbar-spacer" />
      <Button
        ref={projectsRef}
        size="sm"
        aria-haspopup="menu"
        aria-expanded={projectsOpen}
        onClick={() => setProjectsOpen((v) => !v)}
      >
        Projects
        <ChevronIcon />
      </Button>
      <Popover open={projectsOpen} anchor={projectsRef} chrome={false} autoFocus={false} onClose={() => setProjectsOpen(false)}>
        <Menu items={projectsMenu} aria-label="Projects" onClose={() => setProjectsOpen(false)} />
      </Popover>
      {/* 状态灯（MVP v2 · V2）：前面一个彩色的点，后面 running / waiting */}
      {running > 0 ? (
        <span className="ad-topbar-count ad-topbar-count--running">
          <span className="ad-topbar-lamp" aria-hidden="true" />
          {running} running
        </span>
      ) : null}
      {waiting > 0 ? (
        <button
          type="button"
          className="ad-topbar-waiting"
          title="Jump to the next window waiting for you (⌘J, previous ⌘⇧J)"
          onClick={() => props.onWaitingClick?.()}
        >
          <span className="ad-topbar-lamp ad-topbar-lamp--waiting" aria-hidden="true" />
          {waitingText(waiting, props.waitingPosition)}
        </button>
      ) : null}
      <Button size="sm" variant="ghost" onClick={() => props.onSettings?.()}>
        Settings
      </Button>
    </header>
  );
}

function ChevronIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <path d="M2.5 4 5 6.5 7.5 4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
