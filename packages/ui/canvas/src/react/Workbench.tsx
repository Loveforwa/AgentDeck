// 整体布局（需求「1 · 整体布局」）：顶栏、白板、右侧面板。面板的内容由组装方给（线 3 的源代码管理面板），
// 宽度和开关属于白板状态，跟着布局一起保存。收起时（MVP v2 · V4）面板变成 28px 的竖条。

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import type { AgentDeckApi, AbsPath, Workspace } from '@agentdeck/contracts';
import { ToastProvider, useToast, type MenuEntry } from '@agentdeck/ui-kit';
import { Topbar } from '@agentdeck/ui-topbar';
import { usePointerDrag } from '@agentdeck/ui-window-shell';
import { BoardController, type BoardControllerOptions } from '../controller.ts';
import { summarize, waitingPosition } from '../model/attention.ts';
import { Board } from './Board.tsx';
import { BoardProvider, useBoardState, useController } from './context.tsx';
import { SettingsDialogHost } from './SettingsDialog.tsx';
import { useShortcuts } from './useShortcuts.ts';
import { PLUGINS } from '../plugins/index.ts';

export interface PanelContext {
  /** 聚焦的窗口所在的工作区，或选中的框；都没有时为 null。 */
  workspace: Workspace | null;
  /** 收起面板的按钮（aria-label “Collapse panel”，MVP v2 · V4）。面板内容把它放在自己标题栏的右边。 */
  collapseButton: ReactNode;
  /** 收起面板（和 ⌘B 相同）。 */
  collapse(): void;
}

/** 左边栏（N11）：收起按钮放在内容自己的标题栏右边。 */
export interface LeftPanelContext {
  collapseButton: ReactNode;
  collapse(): void;
}

export interface WorkbenchProps extends Omit<BoardControllerOptions, 'api' | 'notify'> {
  api: AgentDeckApi;
  /** 自己建的控制器（测试、dev 页面要直接操作它时）。给了就忽略 api 等选项。 */
  controller?: BoardController;
  /** 右侧面板的内容。 */
  renderPanel?(ctx: PanelContext): ReactNode;
  /** 左边栏的内容（N11 历史会话）。不给就没有左边栏，顶栏也没有它的按钮。 */
  renderLeftPanel?(ctx: LeftPanelContext): ReactNode;
  /** Settings 对话框底部的 Open settings.json。不给就不显示这个按钮。 */
  onOpenSettingsFile?(): void;
  boardName?: string;
  /** macOS 的 hiddenInset 标题栏：顶栏左边给系统的红黄绿按钮留位置（MVP v2 · V1）。 */
  trafficLights?: boolean;
}

/** 顶栏 + 白板 + 右侧面板，外面包好 ToastProvider 和 React Flow 的 provider。 */
export function Workbench(props: WorkbenchProps) {
  return (
    <ToastProvider>
      <WorkbenchInner {...props} />
    </ToastProvider>
  );
}

function WorkbenchInner(props: WorkbenchProps) {
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const { api, controller: given, renderPanel, renderLeftPanel, onOpenSettingsFile, boardName, trafficLights, ...options } = props;
  const [controller] = useState(
    () => given ?? new BoardController({ ...options, api, notify: (message) => toastRef.current.show({ message }) }),
  );

  useEffect(() => {
    if (given) given.setNotify((message) => toastRef.current.show({ message }));
    void controller.start();
    // 要在后台一直跑的插件（PL3 Prompt queue）
    const stops = PLUGINS.flatMap((p) => (p.start ? [p.start(controller)] : []));
    const flush = () => void controller.flush();
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      for (const stop of stops) stop();
      if (!given) controller.dispose();
    };
  }, [controller, given]);

  useShortcuts(controller);

  return (
    <BoardProvider controller={controller}>
      <ReactFlowProvider>
        <div className="ad-workbench">
          {/*
            拖动窗口的那一条（IS-63）：顶栏浮在白板上，拖动区不放在顶栏上，单独一个元素，DOM 里排最前、画在白板下面。
            Electron 按页面报上来的顺序把 drag 区域并进来、no-drag 区域减掉（和层叠无关），这一条在 DOM 顺序和绘制顺序里
            都排最前，后面压在它上面的窗口节点、框、面板、浮层（canvas.css 里 no-drag）都能从拖动区里挖掉，能点；
            空着的地方仍然拖得动窗口。
          */}
          <div className="ad-workbench-drag" aria-hidden="true" />
          <BoardTopbar boardName={boardName} trafficLights={trafficLights === true} hasLeftPanel={!!renderLeftPanel} />
          <div className="ad-workbench-main">
            <LeftPanel renderLeftPanel={renderLeftPanel} />
            <Board />
            <Panel renderPanel={renderPanel} />
          </div>
        </div>
        <SettingsDialogHost onOpenSettingsFile={onOpenSettingsFile} />
      </ReactFlowProvider>
    </BoardProvider>
  );
}

function BoardTopbar({ boardName, trafficLights, hasLeftPanel }: { boardName: string | undefined; trafficLights: boolean; hasLeftPanel: boolean }) {
  const c = useController();
  const leftOpen = useBoardState((s) => s.leftPanel.open);
  const frames = useBoardState((s) => s.frames.length);
  const windows = useBoardState((s) => s.windows.length);
  // 左边：聚焦的窗口（或选中的框）所在的项目和工作区（“main · 3 windows”）；都没有时是整块白板
  const activeId = useBoardState((s) => c.activeWorkspaceId(s));
  const active = useBoardState((s) => (activeId ? s.workspaces[activeId] : undefined));
  const activeWindows = useBoardState((s) => (activeId ? s.windows.filter((w) => w.workspaceId === activeId).length : 0));
  const projectName = useBoardState((s) => (active ? s.projects.find((p) => p.id === active.projectId)?.name : undefined));
  const running = useBoardState((s) => summarize(s).running);
  const waiting = useBoardState((s) => summarize(s).waiting.length);
  // 聚焦的窗口在 ⌘J 顺序里排第几，顶栏显示“2/3 waiting”
  const position = useBoardState((s) => waitingPosition(summarize(s).waiting, s.focusedId));
  const projects = useBoardState((s) => s.projects);
  // X3：在等“允许一次”的请求数，顶栏据此显示 Approve all…
  const approvable = useBoardState((s) => c.approvals.approvable(s).length);
  const menu = useMemo<MenuEntry[]>(
    () => [
      ...projects.map((p) => ({
        id: `project-${p.id}`,
        label: p.missing ? `${p.name} (Folder not found)` : p.name,
        items: [
          { id: `new-${p.id}`, label: 'New workspace…', disabled: p.missing, onSelect: () => c.openNewWorkspace({ projectId: p.id }) },
          { id: `settings-${p.id}`, label: 'Project settings…', onSelect: () => c.openSettings({ section: 'projects', projectId: p.id }) },
        ],
      })),
      ...(projects.length ? [{ type: 'separator' as const }] : []),
      { id: 'add-project', label: 'Add project…', onSelect: () => void c.addProject() },
    ],
    [c, projects],
  );
  return (
    <Topbar
      boardName={boardName ?? 'My Board'}
      projectName={projectName ?? null}
      workspace={active ? { label: active.branch ?? active.name, windows: activeWindows } : null}
      workspaces={frames}
      windows={windows}
      trafficLights={trafficLights}
      running={running}
      waiting={waiting}
      {...(position ? { waitingPosition: position } : {})}
      projectsMenu={menu}
      onWaitingClick={() => c.jumpToNextWaiting()}
      approvable={approvable}
      onApproveAll={() => c.approvals.openApproveAll()}
      onSettings={() => c.openSettings()}
      {...(hasLeftPanel ? { leftPanelOpen: leftOpen, onToggleLeftPanel: () => c.toggleLeftPanel() } : {})}
    />
  );
}

/** 左边栏（N11，画板 14）：和右边栏一个样子，在白板左边占一列（白板跟着变窄）；收起时整个不画，只剩顶栏最左边的按钮。 */
function LeftPanel({ renderLeftPanel }: { renderLeftPanel: WorkbenchProps['renderLeftPanel'] }) {
  const c = useController();
  const open = useBoardState((s) => s.leftPanel.open);
  const width = useBoardState((s) => s.leftPanel.width);
  const startWidth = useRef(width);
  const onPointerDown = usePointerDrag({
    onStart: () => {
      startWidth.current = c.state.leftPanel.width;
    },
    onMove: (dx) => c.setLeftPanelWidth(startWidth.current + dx),
  });
  if (!renderLeftPanel || !open) return null;
  const collapse = () => c.toggleLeftPanel();
  const collapseButton = (
    <button type="button" className="ad-panel-toggle" aria-label="Hide history" title="Hide history" onClick={collapse}>
      <ExpandIcon />
    </button>
  );
  return (
    <aside className="ad-left-panel" style={{ width }} aria-label="History panel">
      <div className="ad-panel-body">{renderLeftPanel({ collapseButton, collapse })}</div>
      <div className="ad-left-panel-resizer" onPointerDown={onPointerDown} role="separator" aria-orientation="vertical" aria-label="Resize history panel" />
    </aside>
  );
}

function Panel({ renderPanel }: { renderPanel: WorkbenchProps['renderPanel'] }) {
  const c = useController();
  const open = useBoardState((s) => s.panel.open);
  const width = useBoardState((s) => s.panel.width);
  const workspace = useBoardState((s) => {
    const id = c.activeWorkspaceId(s);
    return id ? (s.workspaces[id] ?? null) : null;
  });
  const startWidth = useRef(width);
  const onPointerDown = usePointerDrag({
    onStart: () => {
      startWidth.current = c.state.panel.width;
    },
    onMove: (dx) => c.setPanelWidth(startWidth.current - dx),
  });
  if (!renderPanel) return null;
  if (!open) return <PanelRail workspace={workspace} onExpand={() => c.togglePanel()} />;
  const collapse = () => c.togglePanel();
  const collapseButton = (
    <button type="button" className="ad-panel-toggle" aria-label="Collapse panel" title="Collapse panel (⌘B)" onClick={collapse}>
      <CollapseIcon />
    </button>
  );
  return (
    <aside className="ad-panel" style={{ width }} aria-label="Side panel">
      <div className="ad-panel-resizer" onPointerDown={onPointerDown} role="separator" aria-orientation="vertical" aria-label="Resize panel" />
      <div className="ad-panel-body">{renderPanel({ workspace, collapseButton, collapse })}</div>
    </aside>
  );
}

/**
 * 收起后的竖条（MVP v2 · V4）：展开按钮、分支图标，聚焦的工作区有未提交的改动时分支图标旁一个点。
 * 没有聚焦的工作区时分支图标也在，颜色更淡（IS-67）；点只跟着聚焦的工作区。
 */
function PanelRail({ workspace, onExpand }: { workspace: Workspace | null; onExpand(): void }) {
  const dirty = useUncommitted(workspace);
  const branch = workspace ? (workspace.branch ?? workspace.name) : null;
  const title = branch === null ? 'No workspace in focus' : dirty ? `${branch} · uncommitted changes` : branch;
  return (
    <aside className="ad-panel-rail" aria-label="Side panel (collapsed)">
      <button type="button" className="ad-panel-toggle" aria-label="Expand panel" title="Expand panel (⌘B)" onClick={onExpand}>
        <ExpandIcon />
      </button>
      <span className={`ad-panel-rail-branch${branch === null ? ' ad-panel-rail-branch--idle' : ''}`} title={title}>
        <BranchIcon />
        {dirty ? <span className="ad-panel-rail-dot" role="img" aria-label="Uncommitted changes" /> : null}
      </span>
    </aside>
  );
}

/** 工作区的仓库里有没有未提交的改动：先问一次 git.status，之后跟着 git.status 事件更新。 */
function useUncommitted(workspace: Workspace | null): boolean {
  const c = useController();
  const [dirty, setDirty] = useState<ReadonlyMap<AbsPath, boolean>>(new Map());
  const key = workspace ? repoPaths(workspace).join('\n') : '';
  useEffect(() => {
    setDirty(new Map());
    if (!key) return;
    const paths = new Set(key.split('\n') as AbsPath[]);
    let alive = true;
    const note = (repo: AbsPath, files: number) => {
      if (alive && paths.has(repo)) setDirty((m) => new Map(m).set(repo, files > 0));
    };
    const off = c.api.on('git.status', (e) => note(e.status.repo, e.status.files.length));
    for (const repo of paths) {
      c.api.git.status(repo).then(
        (st) => note(repo, st.files.length),
        () => undefined, // 读不到就不显示点，展开面板时那边会报错
      );
    }
    return () => {
      alive = false;
      off();
    };
  }, [c, key]);
  return [...dirty.values()].some(Boolean);
}

function repoPaths(w: Workspace): AbsPath[] {
  // 刚初始化仓库的主目录工作区，repos 可能还是空的（和源代码管理面板一样用工作区目录本身）
  if (w.repos.length === 0) return w.mode === 'main-folder' ? [w.path] : [];
  return w.repos.map((r) => r.path);
}

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** ⇥：向右的箭头顶着一道竖线 */
const CollapseIcon = () => (
  <Icon>
    <path d="M2.5 8h8M7.5 5l3 3-3 3M13.5 3.5v9" />
  </Icon>
);

/** ⇤：向左的箭头顶着一道竖线 */
const ExpandIcon = () => (
  <Icon>
    <path d="M13.5 8h-8M8.5 5l-3 3 3 3M2.5 3.5v9" />
  </Icon>
);

const BranchIcon = () => (
  <Icon>
    <circle cx="5" cy="3.5" r="1.5" />
    <circle cx="5" cy="12.5" r="1.5" />
    <circle cx="11" cy="5.5" r="1.5" />
    <path d="M5 5v6M11 7c0 2.5-6 1.5-6 4" />
  </Icon>
);
