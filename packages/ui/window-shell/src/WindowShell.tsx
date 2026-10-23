import type { MouseEvent, ReactNode } from 'react';
import type { WindowStatusBadge } from '@agentdeck/contracts';
import { RESIZE_EDGES, type ResizeEdge } from './geometry.ts';
import { usePointerDrag } from './usePointerDrag.ts';
import './window-shell.css';

/** 标题栏高度（px）。白板据此算内容区大小。 */
export const TITLE_BAR_HEIGHT = 28;

export interface WindowShellProps {
  /** 等宽显示的名字，例如命令名 claude、zsh，或者网页的主机名。 */
  name: string;
  /** 用户用 Rename 起的名字，名字后面淡色显示。 */
  label?: string | null;
  status?: WindowStatusBadge | null;
  focused?: boolean;
  /** 在等你且没有聚焦：橙色边框。 */
  attention?: boolean;
  /** 正在被拖动：浮起来的阴影。 */
  lifted?: boolean;
  /** 已经开着的窗口被再次打开时闪一下。改变 flashKey 触发。 */
  flashKey?: number;
  maximized?: boolean;
  /** 能不能拖边改大小，默认 true（放大时白板会关掉）。 */
  resizable?: boolean;
  className?: string;
  contentClassName?: string;
  /** 在窗口任何地方按下鼠标（包括内容区），用来聚焦和提到最上层。 */
  onActivate?(): void;
  onMoveStart?(): void;
  /** 拖标题栏：从按下到现在的总位移，屏幕像素。 */
  onMove?(dx: number, dy: number, e: PointerEvent): void;
  onMoveEnd?(moved: boolean, e: PointerEvent): void;
  onResizeStart?(edge: ResizeEdge): void;
  onResize?(edge: ResizeEdge, dx: number, dy: number): void;
  onResizeEnd?(edge: ResizeEdge): void;
  onTitleDoubleClick?(): void;
  onTitleContextMenu?(e: MouseEvent<HTMLDivElement>): void;
  onToggleMaximize?(): void;
  onClose?(): void;
  children?: ReactNode;
}

/** 白板上一个窗口的外框：标题栏、状态、放大和关闭按钮、改大小的边和角。只管样子和手势，位置由白板算。 */
export function WindowShell(props: WindowShellProps) {
  const {
    name,
    label,
    status,
    focused = false,
    attention = false,
    lifted = false,
    flashKey,
    maximized = false,
    resizable = true,
    className,
    contentClassName,
    children,
  } = props;

  const onTitlePointerDown = usePointerDrag({
    onStart: () => props.onMoveStart?.(),
    onMove: (dx, dy, e) => props.onMove?.(dx, dy, e),
    onEnd: (moved, e) => props.onMoveEnd?.(moved, e),
  });

  const cls = [
    'ad-window',
    focused && 'ad-window--focused',
    attention && !focused && 'ad-window--attention',
    lifted && 'ad-window--lifted',
    maximized && 'ad-window--maximized',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={cls} onPointerDownCapture={() => props.onActivate?.()} data-focused={focused || undefined}>
      {flashKey ? <span key={flashKey} className="ad-window-flash" aria-hidden="true" /> : null}
      <div
        className="ad-window-titlebar"
        onPointerDown={onTitlePointerDown}
        onDoubleClick={(e) => {
          if ((e.target as Element).closest('button')) return;
          props.onTitleDoubleClick?.();
        }}
        onContextMenu={(e) => props.onTitleContextMenu?.(e)}
      >
        <StatusDot status={status ?? null} />
        <span className="ad-window-name">{name}</span>
        <span className="ad-window-label">{label}</span>
        {status?.text ? <span className={`ad-window-status ad-window-status--${status.tone}`}>{status.text}</span> : null}
        <span className="ad-window-actions">
          <button
            type="button"
            className="ad-window-button"
            aria-label={maximized ? 'Restore' : 'Maximize'}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => props.onToggleMaximize?.()}
          >
            {maximized ? <RestoreIcon /> : <MaximizeIcon />}
          </button>
          <button
            type="button"
            className="ad-window-button"
            aria-label="Close"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => props.onClose?.()}
          >
            <CloseIcon />
          </button>
        </span>
      </div>
      <div className={['ad-window-content', contentClassName].filter(Boolean).join(' ')}>{children}</div>
      {resizable && !maximized
        ? RESIZE_EDGES.map((edge) => (
            <ResizeHandle
              key={edge}
              edge={edge}
              onStart={() => props.onResizeStart?.(edge)}
              onMove={(dx, dy) => props.onResize?.(edge, dx, dy)}
              onEnd={() => props.onResizeEnd?.(edge)}
            />
          ))
        : null}
    </div>
  );
}

function ResizeHandle(p: { edge: ResizeEdge; onStart(): void; onMove(dx: number, dy: number): void; onEnd(): void }) {
  const onPointerDown = usePointerDrag({
    onStart: p.onStart,
    onMove: p.onMove,
    onEnd: (moved) => {
      if (moved) p.onEnd();
    },
  });
  return <div className={`ad-window-resize ad-window-resize--${p.edge}`} data-edge={p.edge} onPointerDown={onPointerDown} />;
}

/** 标题栏左边的状态点：filled 实心、hollow 空心、none 一条短线（已退出、出错）。没有状态时不画。 */
export function StatusDot({ status }: { status: WindowStatusBadge | null }) {
  if (!status) return <span className="ad-window-dot ad-window-dot--empty" aria-hidden="true" />;
  return <span className={`ad-window-dot ad-window-dot--${status.dot} ad-window-dot--${status.tone}`} aria-hidden="true" />;
}

const iconProps = {
  width: 12,
  height: 12,
  viewBox: '0 0 12 12',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.3,
  strokeLinecap: 'round' as const,
  'aria-hidden': true,
};

function MaximizeIcon() {
  return (
    <svg {...iconProps}>
      <path d="M7 2h3v3M5 10H2V7M10 2 6.8 5.2M2 10l3.2-3.2" />
    </svg>
  );
}

function RestoreIcon() {
  return (
    <svg {...iconProps}>
      <path d="M10 5H7V2M2 7h3v3M7 5l3-3M5 7l-3 3" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg {...iconProps}>
      <path d="M3 3l6 6M9 3 3 9" />
    </svg>
  );
}
