import { useMemo, type MouseEvent } from 'react';
import type { NodeProps } from '@xyflow/react';
import type { OpenWindowRequest, WindowCommand, WindowComponentProps, WindowId, WindowStatusBadge } from '@agentdeck/contracts';
import { WindowShell } from '@agentdeck/ui-window-shell';
import { isWaiting } from '../model/attention.ts';
import { defaultName } from '../model/windows.ts';
import { groupTitle } from '../model/groups.ts';
import { SUMMARY_ZOOM } from '../controller.ts';
import { useBoardState, useController, useWindowType } from './context.tsx';
import { WindowStopConfirm } from './dialogs.tsx';
import { metaHeld } from './Guides.tsx';
import { passWheelToContent } from './gestures.ts';
import { WindowPluginMarks } from './PluginMarks.tsx';

export type WindowNodeData = { id: WindowId };

/** 白板上的一个窗口：外框（window-shell）+ 注册表里这种窗口的组件。 */
export function WindowNodeView({ data }: NodeProps & { data: WindowNodeData }) {
  const id = data.id;
  const c = useController();
  const node = useBoardState((s) => s.windows.find((w) => w.id === id));
  const def = useWindowType(node?.type ?? '');
  const focused = useBoardState((s) => s.focusedId === id);
  const badge = useBoardState((s) => s.badges[id] ?? null);
  const lifted = useBoardState((s) => s.lifted === id || s.resizing?.id === id);
  const flash = useBoardState((s) => s.flash[id] ?? 0);
  const stopConfirm = useBoardState((s) => (s.dialog?.kind === 'stop-terminal' && s.dialog.windowId === id ? s.dialog : null));
  const waiting = useBoardState((s) => {
    const w = s.windows.find((n) => n.id === id);
    return w ? isWaiting(w, s) : false;
  });
  const workspace = useBoardState((s) => (node?.workspaceId ? (s.workspaces[node.workspaceId] ?? null) : null));
  const visible = useBoardState((s) => (node ? c.isVisible(node.rect, s) : false));
  const zoomedOut = useBoardState((s) => s.viewport.zoom < SUMMARY_ZOOM);
  // N2：窗口组里的标题栏灰字是 “lead” / “sub-2 · ui”（用户没改名时）
  const groupLabel = useBoardState((s) => (node?.group ? groupTitle(s.windows, node) : null));

  const actions = useMemo(
    () => ({
      updateData: (patch: object) => c.updateData(id, patch),
      setStatus: (b: WindowStatusBadge | null) => c.setBadge(id, b),
      requestFocus: () => c.focusWindow(id),
      openWindow: <T,>(req: OpenWindowRequest<T>) => void c.openWindow(id, req),
      close: () => c.closeWindow(id),
      toggleMaximize: () => c.toggleMaximize(id),
      onCommand: (listener: (command: WindowCommand) => void) => c.onWindowCommand(id, listener),
    }),
    [c, id],
  );

  if (!node) return null;
  const summary = c.isSummary(node, node.rect, zoomedOut ? 0 : 1);
  const maximized = c.isMaximized(node);
  const props: WindowComponentProps = {
    window: node,
    workspace,
    focused,
    contentSize: c.contentSizeOf(node.rect),
    summary,
    visible,
    ...actions,
  };
  const Component = def?.component;

  const flowPoint = (e: { clientX: number; clientY: number }) => c.clientToFlow({ x: e.clientX, y: e.clientY });
  const zoom = () => c.state.viewport.zoom;
  const onTitleContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    c.focusWindow(id);
    c.openMenu({ screen: { x: e.clientX, y: e.clientY }, flow: flowPoint(e), target: { kind: 'window', windowId: id } });
  };

  return (
    <div className="ad-window-node" data-window-id={id} data-summary={summary || undefined}>
      <WindowShell
        name={defaultName(node, def?.label)}
        label={node.title ?? groupLabel}
        status={badge}
        focused={focused}
        attention={waiting}
        lifted={lifted}
        flashKey={flash}
        maximized={maximized}
        resizable={!maximized}
        className="nopan nodrag nowheel"
        contentClassName="nowheel"
        onActivate={() => {
          c.closeMenu();
          if (!focused && !summary) c.focusWindow(id);
        }}
        onMoveStart={() => c.moveWindowStart(id)}
        onMove={(dx, dy, e) => c.moveWindow(id, dx / zoom(), dy / zoom(), flowPoint(e), { snap: !e.metaKey })}
        onMoveEnd={(moved) => {
          if (moved) c.moveWindowEnd(id);
        }}
        onResizeStart={(edge) => c.resizeWindowStart(id, edge)}
        onResize={(_edge, dx, dy) => c.resizeWindow(id, dx / zoom(), dy / zoom(), { snap: !metaHeld() })}
        onResizeEnd={() => c.resizeWindowEnd(id)}
        onTitleDoubleClick={() => c.toggleMaximize(id)}
        onTitleContextMenu={onTitleContextMenu}
        onToggleMaximize={() => c.toggleMaximize(id)}
        onClose={() => c.closeWindow(id)}
      >
        {Component ? <Component {...props} /> : <div className="ad-window-missing">Unknown window type: {node.type}</div>}
        {stopConfirm ? <WindowStopConfirm dialog={stopConfirm} /> : null}
        {/* 没聚焦时盖一层：第一下单击只聚焦，滚轮交给下面的内容（N6，不平移白板）；摘要卡单击恢复大小 */}
        {!focused || summary ? (
          <div
            className="ad-window-cover"
            onClick={() => (summary ? c.expandSummary(id) : c.focusWindow(id))}
            onWheel={(e) => passWheelToContent(e.currentTarget, e.nativeEvent)}
            aria-hidden="true"
          />
        ) : null}
      </WindowShell>
      {/* 插件的标记（PL0）：贴在外框外面（Auto-approve 的书签在底边左侧），不盖住内容 */}
      <WindowPluginMarks windowId={id} />
    </div>
  );
}
