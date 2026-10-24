// 整体布局（需求「1 · 整体布局」）：顶栏、白板、右侧面板。面板的内容由组装方给（线 3 的源代码管理面板），
// 宽度和开关属于白板状态，跟着布局一起保存。

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import type { AgentDeckApi, Workspace } from '@agentdeck/contracts';
import { ToastProvider, useToast, type MenuEntry } from '@agentdeck/ui-kit';
import { Topbar } from '@agentdeck/ui-topbar';
import { usePointerDrag } from '@agentdeck/ui-window-shell';
import { BoardController, type BoardControllerOptions } from '../controller.ts';
import { summarize, waitingPosition } from '../model/attention.ts';
import { Board } from './Board.tsx';
import { BoardProvider, useBoardState, useController } from './context.tsx';
import { useShortcuts } from './useShortcuts.ts';

export interface PanelContext {
  /** 聚焦的窗口所在的工作区，或选中的框；都没有时为 null。 */
  workspace: Workspace | null;
}

export interface WorkbenchProps extends Omit<BoardControllerOptions, 'api' | 'notify'> {
  api: AgentDeckApi;
  /** 自己建的控制器（测试、dev 页面要直接操作它时）。给了就忽略 api 等选项。 */
  controller?: BoardController;
  /** 右侧面板的内容。 */
  renderPanel?(ctx: PanelContext): ReactNode;
  onOpenSettings?(): void;
  boardName?: string;
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
  const { api, controller: given, renderPanel, onOpenSettings, boardName, ...options } = props;
  const [controller] = useState(
    () => given ?? new BoardController({ ...options, api, notify: (message) => toastRef.current.show({ message }) }),
  );

  useEffect(() => {
    if (given) given.setNotify((message) => toastRef.current.show({ message }));
    void controller.start();
    const flush = () => void controller.flush();
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      if (!given) controller.dispose();
    };
  }, [controller, given]);

  useShortcuts(controller);

  return (
    <BoardProvider controller={controller}>
      <ReactFlowProvider>
        <div className="ad-workbench">
          <BoardTopbar boardName={boardName} onOpenSettings={onOpenSettings} />
          <div className="ad-workbench-main">
            <Board />
            <Panel renderPanel={renderPanel} />
          </div>
        </div>
      </ReactFlowProvider>
    </BoardProvider>
  );
}

function BoardTopbar({ boardName, onOpenSettings }: { boardName: string | undefined; onOpenSettings: (() => void) | undefined }) {
  const c = useController();
  const frames = useBoardState((s) => s.frames.length);
  const terminals = useBoardState((s) => s.windows.filter((w) => w.type === 'terminal').length);
  const running = useBoardState((s) => summarize(s).running);
  const waiting = useBoardState((s) => summarize(s).waiting.length);
  // 聚焦的窗口在 ⌘J 顺序里排第几，顶栏显示“2/3 waiting”
  const position = useBoardState((s) => waitingPosition(summarize(s).waiting, s.focusedId));
  const projects = useBoardState((s) => s.projects);
  const menu = useMemo<MenuEntry[]>(
    () => [
      ...projects.map((p) => ({
        id: `project-${p.id}`,
        label: p.missing ? `${p.name} (Folder not found)` : p.name,
        items: [{ id: `new-${p.id}`, label: 'New workspace…', disabled: p.missing, onSelect: () => c.openNewWorkspace({ projectId: p.id }) }],
      })),
      ...(projects.length ? [{ type: 'separator' as const }] : []),
      { id: 'add-project', label: 'Add project…', onSelect: () => void c.addProject() },
    ],
    [c, projects],
  );
  return (
    <Topbar
      boardName={boardName ?? 'My Board'}
      workspaces={frames}
      terminals={terminals}
      running={running}
      waiting={waiting}
      {...(position ? { waitingPosition: position } : {})}
      projectsMenu={menu}
      onWaitingClick={() => c.jumpToNextWaiting()}
      {...(onOpenSettings ? { onSettings: onOpenSettings } : {})}
    />
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
  if (!open || !renderPanel) return null;
  return (
    <aside className="ad-panel" style={{ width }} aria-label="Side panel">
      <div className="ad-panel-resizer" onPointerDown={onPointerDown} role="separator" aria-orientation="vertical" aria-label="Resize panel" />
      {renderPanel({ workspace })}
    </aside>
  );
}
