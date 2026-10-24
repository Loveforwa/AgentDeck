// 插件的标记（PL0）：每个插件自己画、自己定位置，这里只把登记表里的挨个放上去。

import type { WindowId, WorkspaceId } from '@agentdeck/contracts';
import { PLUGINS } from '../plugins/index.ts';

/** 放在窗口节点里、窗口外框旁边（相对 .ad-window-node 绝对定位）。 */
export function WindowPluginMarks({ windowId }: { windowId: WindowId }) {
  return (
    <>
      {PLUGINS.map((p) => (p.WindowMark ? <p.WindowMark key={p.id} windowId={windowId} /> : null))}
    </>
  );
}

/** 放在框标题里。 */
export function FramePluginMarks({ workspaceId }: { workspaceId: WorkspaceId }) {
  return (
    <>
      {PLUGINS.map((p) => (p.FrameMark ? <p.FrameMark key={p.id} workspaceId={workspaceId} /> : null))}
    </>
  );
}
