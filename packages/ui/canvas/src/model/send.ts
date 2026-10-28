// CO3 · Send selection to ▸：把一个终端里选中的文字当作一次粘贴放进白板上别的终端（只粘贴，不按回车）。
// 这里是纯函数：子菜单里列哪些终端、怎么分组、怎么排；送之前怎么整理文字。

import type { FrameNode, StatusSnapshot, WindowId, WindowNode, WindowStatusBadge, WorkspaceId } from '@agentdeck/contracts';
import { groupTitle, lampOf, type Lamp } from './groups.ts';
import { windowOrder } from './navigation.ts';
import { defaultName, isTerminal, terminalIdOf } from './windows.ts';

export interface SendTarget {
  windowId: WindowId;
  /** 标题栏上的等宽名字：claude、codex、zsh、harlequin。 */
  name: string;
  /** 名字后面的灰字：用户改的名字，或窗口组的 lead / sub-2 · ui；都没有为 null。 */
  label: string | null;
  lamp: Lamp;
}

export interface SendGroup {
  /** 散放的终端为 null。 */
  workspaceId: WorkspaceId | null;
  targets: SendTarget[];
}

export interface SendTargetList {
  /** 源终端所在的框在最前，然后别的框（按白板上的位置），散放的最后。空的组不出现。 */
  groups: SendGroup[];
  /** 因为在等你（等批准、等回答）没列出来的终端个数：不往确认框里打字（和 AH7 同一条规矩）。 */
  skippedWaiting: number;
}

export interface SendTargetInput {
  windows: readonly WindowNode[];
  frames: readonly FrameNode[];
  statuses: Readonly<Record<string, StatusSnapshot>>;
  badges: Readonly<Record<string, WindowStatusBadge>>;
}

/**
 * Send selection to ▸ 的目标：白板上除了源窗口以外的所有终端（agent、shell、自定义命令都算，收起的组成员也算）。
 * 不列：在等你的（计入 skippedWaiting）、进程已经退出的（含出错退出）、没有 terminalId 的（会话没了，要先 Restore）。
 */
export function sendTargets(input: SendTargetInput, from: WindowId): SendTargetList {
  const { windows, frames, statuses, badges } = input;
  const source = windows.find((w) => w.id === from);
  const byId = new Map(windows.map((w) => [w.id, w] as const));
  const framed = new Set(frames.map((f) => f.workspaceId));
  const groups = new Map<string, SendGroup>();
  let skippedWaiting = 0;
  for (const id of windowOrder(windows, frames)) {
    const w = byId.get(id);
    if (!w || w.id === from || !isTerminal(w) || !terminalIdOf(w)) continue;
    const lamp = lampOf(w, statuses, badges);
    if (lamp === 'waiting') {
      skippedWaiting++;
      continue;
    }
    // 进程已经没了（以 0 或非 0 退出、启动失败）：贴进去也没人收
    const status = statuses[terminalIdOf(w) ?? '']?.status;
    if (lamp === 'exited' || status === 'exited' || status === 'error') continue;
    const ws = w.workspaceId && framed.has(w.workspaceId) ? w.workspaceId : null;
    const key = ws ?? '';
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { workspaceId: ws, targets: [] }));
    g.targets.push({ windowId: w.id, name: defaultName(w, 'Terminal'), label: w.title ?? groupTitle(windows, w), lamp });
  }
  const list = [...groups.values()];
  // 源终端所在的框排第一；散放的源终端只是让散放的那组排第一
  const home = source ? (source.workspaceId && framed.has(source.workspaceId) ? source.workspaceId : null) : undefined;
  const first = list.findIndex((g) => g.workspaceId === home);
  if (first > 0) list.unshift(...list.splice(first, 1));
  return { groups: list, skippedWaiting };
}

/**
 * 送出去之前整理文字：去掉末尾的换行（三击选一行时 tmux 会带上），免得目标程序没开 bracketed paste 时等于按了回车，
 * 开了也多一个空行。中间的换行、行首缩进、`--` 注释都原样保留。
 */
export function trimForSend(text: string): string {
  return text.replace(/[\r\n]+$/, '');
}
