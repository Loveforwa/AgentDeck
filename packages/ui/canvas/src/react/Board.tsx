// 白板画布（任务 B1）：React Flow。手势（N6）：两指滚动在空白处平移、在窗口上滚窗口内容，捏合和 ⌘ + 滚轮缩放（25%–200%），
// 按住空格拖动或拖空白处平移，规则见 model/gestures.ts；
// 20px 点阵，缩到 50% 以下隐藏。框和窗口都是不可拖的节点，移动和改大小由我们自己的手势做（只能拖标题栏）。

import { useEffect, useMemo, useRef, type MouseEvent as ReactMouseEvent } from 'react';
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  useReactFlow,
  type Node,
  type NodeTypes,
  type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import { Button, Menu, Popover, type MenuEntry } from '@agentdeck/ui-kit';
import { useState } from 'react';
import { MAX_ZOOM, MIN_ZOOM } from '../model/geometry.ts';
import { BoardMenu, terminalItems } from './BoardMenu.tsx';
import { BoardDialogs } from './dialogs.tsx';
import { ApprovalDialogs } from './approvals.tsx';
import { FrameNodeView, PendingFrameView } from './FrameNodeView.tsx';
import { WindowNodeView } from './WindowNodeView.tsx';
import {
  BACKGROUND_SIDEBAR_TYPE,
  BACKGROUND_TRANSCRIPT_TYPE,
  BackgroundSidebarNode,
  BackgroundTranscriptNode,
  backgroundNodes,
} from './Background.tsx';
import { GROUP_SIDEBAR_TYPE, GroupSidebarNode, groupSidebarNodes } from './GroupSidebar.tsx';
import { hiddenMembers } from '../model/groups.ts';
import { useBoardState, useController } from './context.tsx';
import { Clawd } from './Clawd.tsx';
import { ShortcutHints } from './ShortcutHints.tsx';
import { Guides, useTrackMeta } from './Guides.tsx';
import { FLOW_GESTURES, WINDOW_NODE_CLASS } from '../model/gestures.ts';
import { useSpacePan, useWindowZoomWheel } from './gestures.ts';
import { SelectionBox, useBoxSelect } from './selection.tsx';
import '../canvas.css';

const nodeTypes: NodeTypes = {
  window: WindowNodeView as NodeTypes[string],
  frame: FrameNodeView as NodeTypes[string],
  pending: PendingFrameView as NodeTypes[string],
  [GROUP_SIDEBAR_TYPE]: GroupSidebarNode as NodeTypes[string],
  [BACKGROUND_SIDEBAR_TYPE]: BackgroundSidebarNode as NodeTypes[string],
  [BACKGROUND_TRANSCRIPT_TYPE]: BackgroundTranscriptNode as NodeTypes[string],
};

/** 窗口永远在框上面。 */
const WINDOW_Z = 1000;

export function Board() {
  const c = useController();
  const rf = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);
  const frames = useBoardState((s) => s.frames);
  const windows = useBoardState((s) => s.windows);
  const resizing = useBoardState((s) => s.resizing);
  const pending = useBoardState((s) => s.pending);
  const backgroundPanels = useBoardState((s) => s.backgroundPanels);
  const viewport = useBoardState((s) => s.viewport);
  const loaded = useBoardState((s) => s.loaded);
  useTrackMeta();
  const spacePan = useSpacePan();
  useWindowZoomWheel(wrapper, c);
  // X10：Shift + 左键拖空白处框选
  const boxSelect = useBoxSelect(c, spacePan);

  // 让控制器能做带动画的平移缩放（⌘J、⌘1、放大窗口）
  useEffect(() => {
    c.viewportApi = {
      setViewport: (vp, opts) => void rf.setViewport(vp, opts),
      origin: () => {
        const r = wrapper.current?.getBoundingClientRect();
        return { x: r?.left ?? 0, y: r?.top ?? 0 };
      },
    };
    return () => {
      c.viewportApi = null;
    };
  }, [c, rf]);

  useEffect(() => {
    const el = wrapper.current;
    if (!el) return;
    // 面板浮在白板右边（canvas.css）：白板能用的宽度减掉面板占的部分（面板左边到白板右边）
    const panelOf = () => el.parentElement?.querySelector<HTMLElement>(':scope > .ad-panel, :scope > .ad-panel-rail') ?? null;
    const measure = () => {
      const panel = panelOf();
      const inset = panel ? Math.max(0, Math.round(el.getBoundingClientRect().right - panel.getBoundingClientRect().left)) : 0;
      el.style.setProperty('--pane-inset-right', `${inset}px`);
      c.setPane({ w: Math.max(0, el.clientWidth - inset), h: el.clientHeight });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // 面板收起、展开时换成另一个元素，拖宽度时变宽：跟着换要量的元素
    let watched = panelOf();
    if (watched) ro.observe(watched);
    const mo = typeof MutationObserver === 'undefined' ? null : new MutationObserver(() => {
      const now = panelOf();
      if (now === watched) return;
      if (watched) ro.unobserve(watched);
      watched = now;
      if (watched) ro.observe(watched);
      measure();
    });
    if (el.parentElement) mo?.observe(el.parentElement, { childList: true });
    return () => {
      ro.disconnect();
      mo?.disconnect();
    };
  }, [c]);

  const nodes = useMemo<Node[]>(() => {
    // 节点不可拖、不可选时 React Flow 会给它 pointer-events: none，这里自己处理手势，所以打开
    const base = { draggable: false, selectable: false, connectable: false, focusable: false } as const;
    // N2：收起的子终端不画（进程照常运行）；每个窗口组在 lead 右边画侧边栏
    const hidden = hiddenMembers(windows);
    return [
      ...pending.map((p) => ({
        ...base,
        id: `pending:${p.id}`,
        type: 'pending',
        position: { x: p.rect.x, y: p.rect.y },
        data: { pendingId: p.id },
        style: { width: p.rect.w, height: p.rect.h, pointerEvents: 'all' as const },
        zIndex: 0,
      })),
      ...frames.map((f) => ({
        ...base,
        id: `frame:${f.workspaceId}`,
        type: 'frame',
        position: { x: f.rect.x, y: f.rect.y },
        data: { workspaceId: f.workspaceId },
        style: { width: f.rect.w, height: f.rect.h, pointerEvents: 'all' as const },
        zIndex: f.z,
      })),
      ...windows.filter((w) => !hidden.has(w.id)).map((w) => {
        const r = resizing?.id === w.id ? resizing.rect : w.rect;
        return {
          ...base,
          id: w.id,
          type: 'window',
          className: WINDOW_NODE_CLASS,
          position: { x: r.x, y: r.y },
          data: { id: w.id },
          style: { width: r.w, height: r.h, pointerEvents: 'all' as const },
          zIndex: WINDOW_Z + w.z,
        };
      }),
      ...groupSidebarNodes(c, windows, resizing, WINDOW_Z),
      // N10：后台 agent 的侧边栏和记录窗口
      ...backgroundNodes(c, windows, backgroundPanels, resizing, hidden, WINDOW_Z),
    ];
  }, [c, frames, windows, resizing, pending, backgroundPanels]);

  const openPaneMenu = (e: ReactMouseEvent | MouseEvent) => {
    e.preventDefault();
    c.openMenu({
      screen: { x: e.clientX, y: e.clientY },
      flow: c.clientToFlow({ x: e.clientX, y: e.clientY }),
      target: { kind: 'pane' },
    });
  };

  return (
    <div
      ref={wrapper}
      className={spacePan ? 'ad-board ad-board--space-pan' : 'ad-board'}
      {...boxSelect}
      onDoubleClick={(e) => {
        // 双击空白处也弹出菜单（不直接创建，避免误触）
        if ((e.target as Element).classList.contains('react-flow__pane')) openPaneMenu(e);
      }}
    >
      {loaded ? (
        <ReactFlow
          nodes={nodes}
          nodeTypes={nodeTypes}
          viewport={viewport}
          onViewportChange={(vp: Viewport) => c.viewportChanged(vp)}
          minZoom={MIN_ZOOM}
          maxZoom={MAX_ZOOM}
          {...FLOW_GESTURES}
          panOnDrag={[...FLOW_GESTURES.panOnDrag]}
          selectionOnDrag={false}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          autoPanOnNodeFocus={false}
          disableKeyboardA11y
          deleteKeyCode={null}
          selectionKeyCode={null}
          multiSelectionKeyCode={null}
          onPaneClick={() => {
            c.closeMenu();
            c.focusWindow(null);
            c.clearSelection();
          }}
          onPaneContextMenu={openPaneMenu}
        >
          {viewport.zoom >= 0.5 ? <Background variant={BackgroundVariant.Dots} gap={20} size={2} color="var(--line-strong)" /> : null}
        </ReactFlow>
      ) : null}
      <Guides />
      <SelectionBox />
      <EmptyState />
      <ZoomControl />
      <ShortcutHints />
      <Clawd />
      <BoardMenu />
      <BoardDialogs />
      <ApprovalDialogs />
    </div>
  );
}

/** 空白状态：视口中间一句话和两个按钮。 */
function EmptyState() {
  const c = useController();
  const empty = useBoardState((s) => s.loaded && s.frames.length === 0 && s.windows.length === 0 && s.pending.length === 0);
  const agents = useBoardState((s) => s.agents);
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  if (!empty) return null;
  return (
    <div className="ad-board-empty">
      <p>Add a project to get started, or right-click to open a terminal.</p>
      <div className="ad-board-empty-actions">
        <Button variant="primary" onClick={() => void c.addProject()}>
          Add project
        </Button>
        <Button ref={ref} onClick={() => setOpen(true)}>
          New terminal
        </Button>
        <Popover open={open} anchor={ref} chrome={false} autoFocus={false} onClose={() => setOpen(false)}>
          <Menu
            items={terminalItems(agents, (agent) => void c.newTerminal({ agent, workspaceId: null }))}
            aria-label="New terminal"
            defaultActive="first"
            onClose={() => setOpen(false)}
          />
        </Popover>
      </div>
    </div>
  );
}

/** 左下角的缩放比例，单击弹出 25%、50%、100%、200%、Show all。 */
function ZoomControl() {
  const c = useController();
  const zoom = useBoardState((s) => s.viewport.zoom);
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const items: MenuEntry[] = [
    ...[0.25, 0.5, 1, 2].map((z) => ({ id: `z${z}`, label: `${z * 100}%`, onSelect: () => c.zoomTo(z) })),
    { type: 'separator' as const },
    { id: 'show-all', label: 'Show all', shortcut: '⌘1', onSelect: () => c.showAll() },
  ];
  return (
    <div className="ad-board-zoom">
      <Button ref={ref} size="sm" variant="ghost" aria-label="Zoom" onClick={() => setOpen((v) => !v)}>
        {Math.round(zoom * 100)}%
      </Button>
      <Popover open={open} anchor={ref} placement="top-start" chrome={false} autoFocus={false} onClose={() => setOpen(false)}>
        <Menu items={items} aria-label="Zoom" onClose={() => setOpen(false)} />
      </Popover>
    </div>
  );
}
