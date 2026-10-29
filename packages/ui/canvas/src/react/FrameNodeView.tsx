import type { MouseEvent } from 'react';
import type { NodeProps } from '@xyflow/react';
import type { FrameLayout, WorkspaceId } from '@agentdeck/contracts';
import { Button } from '@agentdeck/ui-kit';
import { RESIZE_EDGES, usePointerDrag, type ResizeEdge } from '@agentdeck/ui-window-shell';
import { LAYOUT_LABEL } from '../model/arrange.ts';
import { runningLabel, waitingLabel, summarize } from '../model/attention.ts';
import { useBoardState, useController } from './context.tsx';
import { FramePluginMarks } from './PluginMarks.tsx';
import { isEmptyBoardTarget } from './selection.tsx';

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
    <div
      className={cls}
      onContextMenu={(e) => menuAt(e, 'frame-body')}
      // X10：单击框里的空白处和单击白板空白处一样，取消多选
      onClick={(e) => {
        if (isEmptyBoardTarget(e.target as Element)) c.clearSelection();
      }}
    >
      <div
        className="ad-frame-header nopan"
        onPointerDown={onTitlePointerDown}
        onDoubleClick={() => c.fitFrame(ws)}
        onContextMenu={(e) => menuAt(e, 'frame-title')}
      >
        <span className="ad-frame-project">{project?.name ?? 'Loading…'}</span>
        {/* 主目录工作区（没有 git 的文件夹）的名字常和项目名一样：一样就只写一次 */}
        {(branch ?? name) && (branch ?? name) !== project?.name ? <span className="ad-frame-branch">{branch ?? name}</span> : null}
        {branch && name && name !== branch ? <span className="ad-frame-name">{name}</span> : null}
        <FramePluginMarks workspaceId={ws} />
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
        {/* N12：一键排版和 Auto-arrange，框里有窗口时才有 */}
        {!empty ? <FrameArrangeButtons ws={ws} /> : null}
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
    onMove: (dx, dy, e) => c.resizeFrame(ws, dx / c.state.viewport.zoom, dy / c.state.viewport.zoom, { snap: !e.metaKey }),
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

const LAYOUT_HINT: Record<FrameLayout, string> = {
  tidy: 'Tidy · compact grid, sizes unchanged',
  columns: 'Columns · side by side, same height',
  rows: 'Rows · stacked, same width',
};

/** 框标题右上角的排版图标（N12，画板 15）：Tidy、Columns、Rows，竖线后面是 Auto-arrange 开关。上次用的排法深色底。 */
function FrameArrangeButtons({ ws }: { ws: WorkspaceId }) {
  const c = useController();
  const arrange = useBoardState((s) => s.frames.find((f) => f.workspaceId === ws)?.arrange ?? null);
  const layout = arrange?.layout ?? null;
  const auto = arrange?.auto ?? false;
  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();
  return (
    <span className="ad-frame-arrange" onPointerDown={stop} onDoubleClick={stop}>
      {(['tidy', 'columns', 'rows'] as const).map((l) => (
        <button
          key={l}
          type="button"
          className="ad-frame-arrange-btn"
          data-layout={l}
          aria-pressed={layout === l}
          aria-label={LAYOUT_LABEL[l]}
          title={LAYOUT_HINT[l]}
          onClick={() => c.arrangeFrame(ws, l)}
        >
          <LayoutIcon layout={l} />
        </button>
      ))}
      <span className="ad-frame-arrange-sep" aria-hidden="true" />
      <button
        type="button"
        className="ad-frame-arrange-btn"
        data-layout="auto"
        aria-pressed={auto}
        aria-label="Auto-arrange new windows"
        title={auto ? `Auto-arrange is on · ${LAYOUT_LABEL[layout ?? 'tidy']}` : 'Auto-arrange new windows'}
        onClick={() => c.setAutoArrange(ws, !auto)}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
          <rect x="1.5" y="1.5" width="11" height="11" rx="2" />
          <path d="M4.5 7.2l1.8 1.8 3.4-3.6" />
        </svg>
      </button>
    </span>
  );
}

function LayoutIcon({ layout }: { layout: FrameLayout }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      {layout === 'tidy' ? (
        <>
          <rect x="1.5" y="1.5" width="4.5" height="4.5" rx="1" />
          <rect x="8" y="1.5" width="4.5" height="4.5" rx="1" />
          <rect x="1.5" y="8" width="4.5" height="4.5" rx="1" />
          <rect x="8" y="8" width="4.5" height="4.5" rx="1" />
        </>
      ) : layout === 'columns' ? (
        <>
          <rect x="1.5" y="1.5" width="3" height="11" rx="1" />
          <rect x="5.5" y="1.5" width="3" height="11" rx="1" />
          <rect x="9.5" y="1.5" width="3" height="11" rx="1" />
        </>
      ) : (
        <>
          <rect x="1.5" y="1.5" width="11" height="3" rx="1" />
          <rect x="1.5" y="5.5" width="11" height="3" rx="1" />
          <rect x="1.5" y="9.5" width="11" height="3" rx="1" />
        </>
      )}
    </svg>
  );
}
