// Usage 插件（PL2）的纯函数：开关和位置怎么存、数字怎么缩写、悬停和小卡片上的文字。不依赖 React，控制器也用
// （放大窗口时给用量条留位置）。

import type { AgentKind, RateLimitWindow, TerminalUsage, TerminalWindowData, TokenCounts, UsageStripSettings, WindowNode } from '@agentdeck/contracts';
import { historyTime } from '../approvals/text.ts';
import { isTerminal } from '../model/windows.ts';

/** 支持的 agent（DR-55：各自读会话文件）。shell、自定义命令灰掉，写 “Not supported for shell”。 */
export const USAGE_AGENTS: readonly AgentKind[] = ['claude', 'codex', 'pi', 'omp', 'kimi'];

/** 上下文到这个比例时数字和进度条变黄（该压缩或开新对话了）。 */
export const CONTEXT_ATTENTION_PERCENT = 85;

/** 用量条的高度和与外框的间隔，同 design-tokens 的 --plugin-strip-height / --plugin-strip-gap。 */
export const STRIP_HEIGHT = 24;
export const STRIP_GAP = 6;

export type StripPosition = UsageStripSettings['position'];

const DEFAULT: UsageStripSettings = { on: false, position: 'top' };

/** 这个终端上 Usage 的设置；不是终端或没开过时是默认值（关着、贴在上边）。 */
export function usageSettings(node: WindowNode | undefined): UsageStripSettings {
  if (!node || !isTerminal(node)) return DEFAULT;
  const u = (node.data as Partial<TerminalWindowData> | null)?.usage;
  if (!u) return DEFAULT;
  return { on: u.on === true, position: u.position === 'bottom' ? 'bottom' : 'top' };
}

/** 开着而且是支持的 agent（换过 agent 的老数据不画条）。 */
export function usageShown(node: WindowNode | undefined): boolean {
  if (!node || !usageSettings(node).on) return false;
  const agent = (node.data as Partial<TerminalWindowData> | null)?.agent;
  return typeof agent === 'string' && USAGE_AGENTS.includes(agent);
}

/** 用量条在窗口外面占的地方（放大窗口时给它留位置）。没开时都是 0。 */
export function usageOutset(node: WindowNode | undefined): { top: number; bottom: number } {
  if (!usageShown(node)) return { top: 0, bottom: 0 };
  const room = STRIP_HEIGHT + STRIP_GAP;
  return usageSettings(node).position === 'top' ? { top: room, bottom: 0 } : { top: 0, bottom: room };
}

/** 312000 → 312k，18400 → 18.4k，1400000 → 1.4M，640 → 640。 */
export function abbreviate(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  const v = Math.max(0, n);
  if (v < 1000) return String(Math.round(v));
  const scaled = (x: number, unit: string) => {
    const s = x < 100 ? (Math.round(x * 10) / 10).toString() : String(Math.round(x));
    return `${s}${unit}`;
  };
  const k = v / 1000;
  if (k < 999.5) {
    // 999.96k 四舍五入成 1000k 时进到 M
    const s = scaled(k, 'k');
    if (s !== '1000k') return s;
  }
  const m = v / 1_000_000;
  if (m < 999.5) return scaled(m, 'M');
  return scaled(v / 1_000_000_000, 'B');
}

/** 准确数：312,345。 */
export function exact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  return Math.round(n).toLocaleString('en-US');
}

/** 缓存一格：读 / 写；agent 不报缓存写时只写读。 */
export function cacheText(t: TokenCounts | null, format: (n: number | null) => string = abbreviate): string {
  if (!t) return '–';
  return t.cacheWrite === null ? format(t.cacheRead) : `${format(t.cacheRead)} / ${format(t.cacheWrite)}`;
}

export function hasData(u: TerminalUsage | null): u is TerminalUsage & { state: 'ok' } {
  return u !== null && u.state === 'ok';
}

export function contextAttention(u: TerminalUsage | null): boolean {
  const p = u?.context?.percent;
  return typeof p === 'number' && p >= CONTEXT_ATTENTION_PERCENT;
}

/** 0–100 的整数，进度条宽度和右边的 48%。 */
export function percentText(p: number | null | undefined): string | null {
  if (p === null || p === undefined || !Number.isFinite(p)) return null;
  return `${Math.round(Math.min(100, Math.max(0, p)))}%`;
}

export const INFERRED_NOTE = 'Session inferred from the folder and start time; it may be the wrong one';

/** 读不到数据时悬停写的原因。 */
export function noDataReason(u: TerminalUsage | null, error: string | null, terminalId: string | null): string {
  if (!terminalId) return 'The terminal is not running';
  if (error) return error;
  if (!u) return 'Loading…';
  return u.reason ?? (u.state === 'unsupported' ? 'Not supported for this terminal' : 'No usage recorded yet');
}

/** 条的悬停：准确数和模型名；推断出来的会话写明。 */
export function stripTitle(u: TerminalUsage): string {
  const lines: string[] = [];
  const t = u.total;
  if (t) {
    lines.push(`Input ${exact(t.input)} · output ${exact(t.output)}${t.reasoning !== null ? ` (reasoning ${exact(t.reasoning)})` : ''}`);
    lines.push(`Cache read ${exact(t.cacheRead)}${t.cacheWrite !== null ? ` · cache write ${exact(t.cacheWrite)}` : ''}`);
  }
  const ctx = u.context;
  if (ctx) {
    const pct = percentText(ctx.percent);
    lines.push(`Context ${exact(ctx.tokens)}${ctx.window !== null ? ` of ${exact(ctx.window)}` : ''}${pct ? ` (${pct})` : ''}`);
  }
  if (u.model) lines.push(u.model);
  if (u.match === 'inferred') lines.push(INFERRED_NOTE);
  return lines.join('\n');
}

/** 小卡片里最近一次请求那一行：in 2.1k · out 640 · cache 94k（缓存写不为 0 时 94k / 1.2k）。 */
export function lastRequestText(t: TokenCounts | null): string {
  if (!t) return '–';
  const cache = t.cacheWrite ? `${abbreviate(t.cacheRead)} / ${abbreviate(t.cacheWrite)}` : abbreviate(t.cacheRead);
  return `in ${abbreviate(t.input)} · out ${abbreviate(t.output)} · cache ${cache}`;
}

/** codex 的账号额度：300 分钟是 “5-hour limit”，10080 是 “Weekly limit”。 */
export function limitLabel(w: RateLimitWindow, fallback: string): string {
  const m = w.windowMinutes;
  if (m === 10080) return 'Weekly limit';
  if (m === 1440) return 'Daily limit';
  if (m !== null && m > 0 && m % 60 === 0 && m < 1440) return `${m / 60}-hour limit`;
  return fallback;
}

export function limitText(w: RateLimitWindow, now: Date = new Date()): string {
  const used = `${percentText(w.usedPercent) ?? '–'} used`;
  const at = w.resetsAt ? historyTime(w.resetsAt, now) : '';
  return at ? `${used} · resets ${at}` : used;
}

/** 小卡片里额度的几行（只有 codex 有）。 */
export function limitRows(u: TerminalUsage, now: Date = new Date()): { label: string; text: string }[] {
  const rows: { label: string; text: string }[] = [];
  const r = u.rateLimits;
  if (!r) return rows;
  if (r.primary) rows.push({ label: limitLabel(r.primary, 'Primary limit'), text: limitText(r.primary, now) });
  if (r.secondary) rows.push({ label: limitLabel(r.secondary, 'Secondary limit'), text: limitText(r.secondary, now) });
  return rows;
}
