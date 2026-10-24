import { useRef, useState } from 'react';
import { Button, Menu, Popover, type MenuEntry } from '@agentdeck/ui-kit';
import './topbar.css';

/** 当前工作区：分支名（没有分支时用工作区名）和里面的窗口数。 */
export interface TopbarWorkspace {
  label: string;
  windows: number;
}

export interface TopbarProps {
  /** 白板名，MVP 只有一块：“My Board”。没有聚焦的项目时项目菜单按钮上写它。 */
  boardName?: string;
  /** 聚焦的窗口（或选中的框）所在的项目名；没有时显示 boardName。 */
  projectName?: string | null;
  /** 聚焦的窗口（或选中的框）所在的工作区；没有时显示整块白板的“2 workspaces · 5 windows”。 */
  workspace?: TopbarWorkspace | null;
  workspaces: number;
  windows: number;
  running: number;
  waiting: number;
  /** 聚焦的窗口是第几个在等你的（从 1 开始），显示成“2/3 waiting”；不在里面时不给。 */
  waitingPosition?: number;
  /** 项目菜单的内容，由白板按项目列表生成。 */
  projectsMenu: readonly MenuEntry[];
  /** 单击“n waiting”：跳到下一个在等你的窗口（和 ⌘J 相同）。 */
  onWaitingClick?(): void;
  /** 在等“允许一次”的请求数（X3）。大于 0 时在 waiting 后面显示 “Approve all…”（不设快捷键）。 */
  approvable?: number;
  /** 单击 “Approve all…”：白板弹出确认列表。 */
  onApproveAll?(): void;
  onSettings?(): void;
  /**
   * macOS 的 hiddenInset 标题栏：系统的红黄绿按钮画在顶栏左边，顶栏左边留出它们的位置（MVP v2 · V1）。
   * 不给时（浏览器里的 dev 页面、其他平台）不留。
   */
  trafficLights?: boolean;
}

/** “2 workspaces · 5 windows” */
export function summaryText(workspaces: number, windows: number): string {
  return `${plural(workspaces, 'workspace')} · ${plural(windows, 'window')}`;
}

/** “main · 3 windows” */
export function workspaceText(workspace: TopbarWorkspace): string {
  return `${workspace.label} · ${plural(workspace.windows, 'window')}`;
}

/** “3 waiting”；聚焦的窗口在里面时“2/3 waiting”。 */
export function waitingText(waiting: number, position?: number): string {
  return position && position <= waiting ? `${position}/${waiting} waiting` : `${waiting} waiting`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * 顶栏（B4，MVP v2 · V1 改成一行）：和系统标题栏合成一行，整条是窗口的拖动区。
 * 左边项目菜单和当前工作区，右边状态灯和齿轮（Settings）。
 */
export function Topbar(props: TopbarProps) {
  const { boardName = 'My Board', workspaces, windows, running, waiting, projectsMenu } = props;
  const projectsRef = useRef<HTMLButtonElement>(null);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const title = props.projectName ?? boardName;
  const approvable = props.approvable ?? 0;
  const context = props.workspace ? workspaceText(props.workspace) : summaryText(workspaces, windows);

  return (
    <header className={`ad-topbar${props.trafficLights ? ' ad-topbar--traffic-lights' : ''}`}>
      <Button
        ref={projectsRef}
        size="sm"
        variant="ghost"
        className="ad-topbar-project"
        aria-haspopup="menu"
        aria-expanded={projectsOpen}
        title="Projects"
        onClick={() => setProjectsOpen((v) => !v)}
      >
        <span className="ad-topbar-project-name">{title}</span>
        <ChevronIcon />
      </Button>
      <Popover open={projectsOpen} anchor={projectsRef} chrome={false} autoFocus={false} onClose={() => setProjectsOpen(false)}>
        <Menu items={projectsMenu} aria-label="Projects" onClose={() => setProjectsOpen(false)} />
      </Popover>
      <span className="ad-topbar-summary">{context}</span>
      <span className="ad-topbar-spacer" />
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
      {approvable > 0 && props.onApproveAll ? (
        <Button
          size="sm"
          className="ad-topbar-approve-all"
          title={`Review and approve ${approvable} waiting permission request${approvable === 1 ? '' : 's'}`}
          onClick={() => props.onApproveAll?.()}
        >
          Approve all…
        </Button>
      ) : null}
      <Button
        size="sm"
        variant="ghost"
        className="ad-topbar-icon"
        aria-label="Settings"
        title="Settings (⌘,)"
        onClick={() => props.onSettings?.()}
      >
        <GearIcon />
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

/** 齿轮：外圈八个齿 + 中间一个圆，线条图标。 */
function GearIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="8" r="2" />
      <path d="M6.9 1.5h2.2l.35 1.75 1.2.5 1.5-1 1.55 1.55-1 1.5.5 1.2 1.75.35v2.2l-1.75.35-.5 1.2 1 1.5-1.55 1.55-1.5-1-1.2.5-.35 1.75H6.9l-.35-1.75-1.2-.5-1.5 1-1.55-1.55 1-1.5-.5-1.2L1.5 9.1V6.9l1.75-.35.5-1.2-1-1.5L4.3 2.3l1.5 1 1.2-.5z" />
    </svg>
  );
}
