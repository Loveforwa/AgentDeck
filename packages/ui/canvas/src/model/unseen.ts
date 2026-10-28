// Unseen（CO4，画板 O0 第 4 节；照 Shepherd 的 “done since you last looked”、herdr 的 “done 留到你看过”）。
// 一轮结束（agent.turn-end，状态机在一轮做完、变回 idle 时发）时这个终端没聚焦，就在窗口数据上记 unseen: true（TerminalWindowData.unseen，随白板保存）；
// 聚焦它时清掉。标题栏写 “Idle · Unseen”，BoardNav 的 Agents 视图里放进 DONE · UNSEEN、粗体。只是界面状态，不经过服务。
// 只记 agent 终端：Shell、自定义命令没有“一轮”。

import type { TerminalId, TerminalWindowData, WindowId, WindowNode } from '@agentdeck/contracts';
import { terminalIdOf } from './windows.ts';

function isAgentTerminal(w: WindowNode): boolean {
  const agent = (w.data as Partial<TerminalWindowData> | null)?.agent;
  return w.type === 'terminal' && !!agent && agent !== 'shell' && agent !== 'custom';
}

/** 一轮结束：没聚焦的、接着这个终端的 agent 窗口记上 unseen。没有要改的返回原数组。 */
export function markUnseen(windows: WindowNode[], terminalId: TerminalId, focusedId: WindowId | null): WindowNode[] {
  let changed = false;
  const next = windows.map((w) => {
    if (w.id === focusedId || terminalIdOf(w) !== terminalId || !isAgentTerminal(w)) return w;
    if ((w.data as Partial<TerminalWindowData>).unseen === true) return w;
    changed = true;
    return { ...w, data: { ...(w.data as TerminalWindowData), unseen: true } };
  });
  return changed ? next : windows;
}

/** 聚焦了：清掉这个窗口的 unseen。没有要改的返回原数组。 */
export function clearUnseen(windows: WindowNode[], id: WindowId): WindowNode[] {
  const i = windows.findIndex((w) => w.id === id);
  const w = windows[i];
  if (!w || (w.data as Partial<TerminalWindowData> | null)?.unseen !== true) return windows;
  // 去掉这个键（不填当 false），存下来的白板和以前一样
  const { unseen: _, ...data } = w.data as TerminalWindowData;
  const next = [...windows];
  next[i] = { ...w, data };
  return next;
}
