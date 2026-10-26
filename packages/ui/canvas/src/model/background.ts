// 后台 agent（MVP v3 · N10，画板 13）：agent 自带的子 agent，跑在主 agent 的进程里，没有终端，只读。
// 数据来自 SubagentService（subagents.changed），不随白板保存。界面三样东西：
// - 小提示：主终端底边右侧，有“这一轮”的后台 agent 才出现（hintOf）；
// - 侧边栏：主终端右边一列（和 N2 窗口组的侧边栏同一个位置；主终端本身是 lead 时就并进那一列）；
// - 记录窗口：选中一个后台 agent 时贴在侧边栏右边（N2 的停靠处），只读。

import type { BackgroundAgent, Rect } from '@agentdeck/contracts';
import { dockSlot } from './groups.ts';

/** 一个主终端的后台 agent 面板（开着才有）。selected：右边打开记录的那个。 */
export interface BackgroundPanel {
  selected: string | null;
}

export type HintTone = 'running' | 'error' | 'done';

/** 小提示的样子：“5 background agents · 3 running”，有出错的红点，全部做完灰色 “✓ 5 done”。没有这一轮的后台 agent 时为 null。 */
export function hintOf(agents: readonly BackgroundAgent[]): { tone: HintTone; text: string; count: number } | null {
  const round = agents.filter((a) => a.current || a.state === 'running');
  const n = round.length;
  if (n === 0) return null;
  const running = round.filter((a) => a.state === 'running').length;
  const failed = round.filter((a) => a.state === 'failed').length;
  if (running === 0 && failed === 0) return { tone: 'done', text: `✓ ${n} done`, count: n };
  const parts = [failed > 0 ? `${failed} failed` : null, running > 0 ? `${running} running` : null].filter(Boolean);
  return { tone: failed > 0 ? 'error' : 'running', text: `${n} ${n === 1 ? 'background agent' : 'background agents'} · ${parts.join(' · ')}`, count: n };
}

/** 侧边栏一行的名字：任务描述，没有就写类型。 */
export function agentLabel(a: BackgroundAgent): string {
  return a.description?.trim() || a.agentType || `Agent ${a.id.slice(0, 6)}`;
}

/** 用了多久：做完的按 agent 报的（没有就按开始、结束的时间），跑着的按现在。 */
export function agentElapsedMs(a: BackgroundAgent, now: number): number | null {
  if (a.durationMs !== null) return a.durationMs;
  const start = Date.parse(a.startedAt);
  if (Number.isNaN(start)) return null;
  const end = a.endedAt ? Date.parse(a.endedAt) : now;
  return Number.isNaN(end) ? null : Math.max(0, end - start);
}

/** “9s”、“1m 2s”、“1h 5m”。 */
export function formatElapsed(ms: number | null): string {
  if (ms === null) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** “40.8k tokens”。 */
export function formatTokens(n: number | null): string {
  if (n === null) return '';
  if (n < 1000) return `${n} tokens`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k tokens`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M tokens`;
}

export const STATE_LABEL: Record<BackgroundAgent['state'], string> = { running: 'Running', done: 'Done', failed: 'Failed' };

/** 记录窗口的宽度（白板坐标）。 */
export const TRANSCRIPT_W = 460;

/** 记录窗口的位置：侧边栏右边（N2 的停靠处），和主终端一样高。 */
export function transcriptRect(anchor: Rect): Rect {
  return { ...dockSlot(anchor), w: TRANSCRIPT_W, h: anchor.h };
}
