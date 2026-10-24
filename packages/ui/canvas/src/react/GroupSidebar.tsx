// 窗口组的侧边栏（MVP v3 · N2，形态 A）：贴在 lead 窗口右边的一列，“3 subagents”，每个子终端一行（状态灯 + “sub-2 · ui”）。
// 单击一行：只显示这个子终端，贴在侧边栏右边，其余收起（进程照常运行）。Show all 平铺，Collapse group 只剩侧边栏。
// 在等你的行是浅黄底（和快速定位列表一样）。侧边栏是一个单独的 React Flow 节点，位置由 lead 算出来，跟着 lead 走。

import type { Node, NodeProps } from '@xyflow/react';
import type { Rect, WindowGroupId, WindowNode } from '@agentdeck/contracts';
import { Button } from '@agentdeck/ui-kit';
import type { BoardController } from '../controller.ts';
import { LAMP_LABEL, groupView, lampOf, listGroups, memberName, sidebarRect } from '../model/groups.ts';
import { WINDOW_NODE_CLASS } from '../model/gestures.ts';
import { useBoardState, useController } from './context.tsx';
import '../group-sidebar.css';

export type GroupSidebarData = { groupId: WindowGroupId };

export const GROUP_SIDEBAR_TYPE = 'group-sidebar';

/** 白板上每个窗口组的侧边栏节点。lead 放大中不画（侧边栏会在视口外面）。z 和 lead 一样，排在窗口后面所以压在 lead 上面一层。 */
export function groupSidebarNodes(
  c: BoardController,
  windows: readonly WindowNode[],
  resizing: { id: string; rect: Rect } | null,
  zBase: number,
): Node[] {
  return listGroups(windows)
    .filter((g) => !c.isMaximized(g.lead))
    .map((g) => {
      const r = sidebarRect(resizing?.id === g.lead.id ? resizing.rect : g.lead.rect);
      return {
        id: `group:${g.id}`,
        type: GROUP_SIDEBAR_TYPE,
        className: WINDOW_NODE_CLASS,
        position: { x: r.x, y: r.y },
        data: { groupId: g.id },
        style: { width: r.w, height: r.h, pointerEvents: 'all' as const },
        zIndex: zBase + g.lead.z,
        draggable: false,
        selectable: false,
        connectable: false,
        focusable: false,
      };
    });
}

export function GroupSidebarNode({ data }: NodeProps & { data: GroupSidebarData }) {
  return <GroupSidebar groupId={data.groupId} />;
}

export function GroupSidebar({ groupId }: { groupId: WindowGroupId }) {
  const c = useController();
  const windows = useBoardState((s) => s.windows);
  const statuses = useBoardState((s) => s.statuses);
  const badges = useBoardState((s) => s.badges);
  const focusedId = useBoardState((s) => s.focusedId);
  const g = listGroups(windows).find((x) => x.id === groupId);
  if (!g) return null;
  const view = groupView(g);
  const n = g.members.length;
  const selectedId = view.mode === 'one' ? view.shown : view.mode === 'all' ? focusedId : null;
  return (
    <div
      className="ad-group-sidebar nopan nodrag nowheel"
      data-group-id={groupId}
      data-view={view.mode}
      onPointerDown={() => c.closeMenu()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="ad-group-sidebar-head">{n === 1 ? '1 subagent' : `${n} subagents`}</div>
      <ul className="ad-group-sidebar-rows" aria-label="Subagents">
        {g.members.map((m) => {
          const lamp = lampOf(m, statuses, badges);
          const selected = m.id === selectedId;
          const cls = ['ad-group-row', selected ? 'ad-group-row--selected' : '', lamp === 'waiting' ? 'ad-group-row--waiting' : '']
            .filter(Boolean)
            .join(' ');
          const name = memberName(g, m);
          return (
            <li key={m.id}>
              <button
                type="button"
                className={cls}
                data-window-id={m.id}
                aria-pressed={selected}
                title={`${name} · ${LAMP_LABEL[lamp]}`}
                onClick={() => c.selectGroupMember(m.id)}
              >
                <span className={`ad-group-lamp ad-group-lamp--${lamp}`} role="img" aria-label={LAMP_LABEL[lamp]} />
                <span className="ad-group-row-name">{name}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="ad-group-sidebar-actions">
        <Button size="sm" variant="ghost" disabled={view.mode === 'all'} onClick={() => c.showAllGroup(groupId)}>
          Show all
        </Button>
        <Button size="sm" variant="ghost" disabled={view.mode === 'collapsed'} onClick={() => c.collapseGroup(groupId)}>
          Collapse group
        </Button>
      </div>
    </div>
  );
}
