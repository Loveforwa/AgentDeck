// 拖窗口时松手落在哪个框（任务 W3、W5）。
// - 拖着窗口往自己框外走：框跟着变大，窗口出不去（W3）。
// - 指针进了别的框：那个框显示可以放下；松手时终端弹回原处，提示在那个框里新开一个（W5）；
//   不是终端的窗口（网页）直接换到那个框。散放的窗口拖进框同理。

import type { FrameNode, WindowNode, WorkspaceId } from '@agentdeck/contracts';
import { containsPoint, type Point } from './geometry.ts';
import { isPinnedToWorkspace } from './windows.ts';

/** 指针下最上面的框（z 大的在上，同 z 时后面的在上），不算窗口自己的框。 */
export function dropTargetAt(
  pointer: Point,
  frames: readonly Pick<FrameNode, 'workspaceId' | 'rect' | 'z'>[],
  own: WorkspaceId | null,
): WorkspaceId | null {
  let best: { id: WorkspaceId; z: number; i: number } | null = null;
  frames.forEach((f, i) => {
    if (f.workspaceId === own || !containsPoint(f.rect, pointer)) return;
    if (!best || f.z > best.z || (f.z === best.z && i > best.i)) best = { id: f.workspaceId, z: f.z, i };
  });
  return (best as { id: WorkspaceId } | null)?.id ?? null;
}

export type DropDecision =
  /** 留在原来的框（或继续散放）。 */
  | { kind: 'stay' }
  /** 换到 target 框。 */
  | { kind: 'adopt'; workspaceId: WorkspaceId }
  /** 不能换框：弹回拖动前的位置，问要不要在 target 里新开一个。 */
  | { kind: 'bounce'; from: WorkspaceId | null; to: WorkspaceId };

export function decideDrop(node: WindowNode, target: WorkspaceId | null): DropDecision {
  if (!target || target === node.workspaceId) return { kind: 'stay' };
  if (isPinnedToWorkspace(node)) return { kind: 'bounce', from: node.workspaceId, to: target };
  return { kind: 'adopt', workspaceId: target };
}
