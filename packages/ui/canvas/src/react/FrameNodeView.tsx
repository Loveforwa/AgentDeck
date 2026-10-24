import type { MouseEvent } from 'react';
import type { NodeProps } from '@xyflow/react';
import type { WorkspaceId } from '@agentdeck/contracts';
import { Button } from '@agentdeck/ui-kit';
import { RESIZE_EDGES, usePointerDrag, type ResizeEdge } from '@agentdeck/ui-window-shell';
import { runningLabel, waitingLabel, summarize } from '../model/attention.ts';
import { useBoardState, useController } from './context.tsx';

export type FrameNodeData = { workspaceId: WorkspaceId };
export type PendingNodeData = { pendingId: string };

/** 工作区框（任务 W3）：标题“项目 · 分支”，拖标题带走里面的窗口，拖边改大小，右边是状态灯：绿“2 running”、黄“1 waiting”，为 0 时不显示（MVP v2 · V2，IS-64）。 */
export function FrameNodeView({ data }: NodeProps & { data: FrameNodeData }) {
  const ws = data.workspaceId;
  const c = useController();
  const workspace = useBoardState((s) => s.workspaces[ws]);
  const project = useBoardState((s) => (workspace ? s.projects.find((p) => p.id === workspace.projectId) : undefined));
  const selected = useBoardState((s) => s.selectedFrame === ws);
  const dropTarget = useBoardState((s) => s.dropTarget === ws);
  const empty = useBoardState((s) => !s.windows.some((w) => w.workspaceId === ws));
  const waiting = useBoardState((s) => summarize(s).waitingByWorkspace[ws]);
  const running = useBoardState((s) => summarize(s).runningByWorkspace[ws]);
  const zoom = () => c.state.viewport.zoom;

  const onTitlePointerDown = usePointerDrag({
    onStart: () => c.moveFrameStart(ws),
    onMove: (dx, dy, e) => c.moveFrame(ws, dx / zoom(), dy / zoom(), { snap: !e.metaKey }),
    onEnd: (moved) => {
      if (moved) c.moveFrameEnd();
      else c.selectFrame(ws);
    },
  });

  const menuAt = (e: MouseEvent, kind: 'frame-body' | 'frame-title') => {
    e.preventDefault();
    e.stopPropagation();
    c.openMenu({
      screen: { x: e.clientX, y: e.clientY },
      flow: c.clientToFlow({ x: e.clientX, y: e.clientY }),
      target: { kind, workspaceId: ws },
    });
  };

  const branch = workspace?.branch ?? null;
  const name = workspace?.name ?? '';
  const cls = ['ad-frame', selected && 'ad-frame--selected', dropTarget && 'ad-frame--drop'].filter(Boolean).join(' ');

  return (
    <div className={cls} onContextMenu={(e) => menuAt(e, 'frame-body')}>
      <div
        className="ad-frame-header nopan"
        onPointerDown={onTitlePointerDown}
        onDoubleClick={() => c.fitFrame(ws)}
        onContextMenu={(e) => menuAt(e, 'frame-title')}
      >
        <span className="ad-frame-project">{project?.name ?? 'Loading…'}</span>
        <span className="ad-frame-branch">{branch ?? name}</span>
        {branch && name && name !== branch ? <span className="ad-frame-name">{name}</span> : null}
        <span className="ad-frame-spacer" />
        {workspace?.missing ? <span className="ad-frame-note">Folder not found</span> : null}
        {/* 状态灯和顶栏一样：前面一个彩色的点；标题太长时截标题，灯不缩 */}
        {running ? (
          <span className="ad-frame-count ad-frame-running">
            <span className="ad-frame-lamp" aria-hidden="true" />
            {runningLabel(running)}
          </span>
        ) : null}
        {waiting ? (
          <span className="ad-frame-count ad-frame-waiting">
            <span className="ad-frame-lamp ad-frame-lamp--waiting" aria-hidden="true" />
            {waitingLabel(waiting)}
          </span>
        ) : null}
      </div>
      {empty ? <div className="ad-frame-empty">Right-click to add a terminal</div> : null}
      {RESIZE_EDGES.map((edge) => (
        <FrameResizeHandle key={edge} ws={ws} edge={edge} />
      ))}
    </div>
  );
}

function FrameResizeHandle({ ws, edge }: { ws: WorkspaceId; edge: ResizeEdge }) {
  const c = useController();
  const onPointerDown = usePointerDrag({
    onStart: () => c.resizeFrameStart(ws, edge),
    onMove: (dx, dy) => c.resizeFrame(ws, dx / c.state.viewport.zoom, dy / c.state.viewport.zoom),
    onEnd: () => c.resizeFrameEnd(),
  });
  return <div className={`ad-frame-resize ad-frame-resize--${edge} nopan`} data-edge={edge} onPointerDown={onPointerDown} />;
}

/** 正在创建的工作区：先出现框，写“Creating worktree…”；失败时显示 git 的错误和 Retry。 */
export function PendingFrameView({ data }: NodeProps & { data: PendingNodeData }) {
  const c = useController();
  const p = useBoardState((s) => s.pending.find((x) => x.id === data.pendingId));
  if (!p) return null;
  return (
    <div className="ad-frame ad-frame--pending" role="status">
      <div className="ad-frame-header">
        <span className="ad-frame-project">{p.label}</span>
        <span className="ad-frame-spacer" />
        {!p.error ? <span className="ad-frame-note">{p.message}</span> : null}
      </div>
      {p.error ? (
        <div className="ad-frame-error nopan">
          <span>{p.error.message}</span>
          <span className="ad-frame-error-actions">
            {p.error.code === 'branch-exists' && p.request.branch?.kind === 'new' ? (
              <Button size="sm" onClick={() => void c.retryPending(p.id, true)}>
                Use existing branch
              </Button>
            ) : null}
            <Button size="sm" onClick={() => void c.retryPending(p.id)}>
              Retry
            </Button>
            <Button size="sm" variant="ghost" onClick={() => c.dismissPending(p.id)}>
              Delete
            </Button>
          </span>
        </div>
      ) : null}
    </div>
  );
}
