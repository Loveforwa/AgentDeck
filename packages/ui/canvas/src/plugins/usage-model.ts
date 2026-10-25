// Usage 插件（PL2）的纯函数：开关和位置怎么存、数字怎么缩写、悬停和小卡片上的文字。不依赖 React，控制器也用
// （放大窗口时给用量条留位置）。
//
// IS-69：agent 自己界面上也有的数字（token 数、上下文百分比、额度、重置时间），写法和取整都照那个 agent 来，
// 各家不统一（用户定的）。每家的写法在下面的 AGENT_FORMATS 表里，注释写着出处（文件 / 函数）。

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

/** 不认识的 agent 用的缩写：312000 → 312k，18400 → 18.4k，1400000 → 1.4M，640 → 640。 */
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
  const p = contextDisplay(u)?.percent;
  return typeof p === 'number' && p >= CONTEXT_ATTENTION_PERCENT;
}

/** 0–100 的整数，进度条宽度和右边的 48%。 */
export function percentText(p: number | null | undefined): string | null {
  if (p === null || p === undefined || !Number.isFinite(p)) return null;
  return `${Math.round(Math.min(100, Math.max(0, p)))}%`;
}

/** 条上各项的悬停说明（不懂 input / output / cache 的人也看得明白）。 */
export const FIELD_HINTS = {
  input: 'Input: tokens sent to the model in this conversation, not counting cached ones',
  output: 'Output: tokens the model wrote back, including its thinking',
  cache: 'Cache: tokens the model re-read from its prompt cache instead of processing again (cheaper and faster)',
  context:
    'Context: how much of the model’s context window this conversation fills right now. When it is full the agent compacts the conversation or you start a new one',
} as const;

// ---------------------------------------------------------------------------------------------
// 各 agent 自己的写法（IS-69）
// ---------------------------------------------------------------------------------------------

/** 去掉一位小数里多余的 .0：1.0 → 1，1.5 → 1.5。 */
function trim1(x: number): string {
  const s = x.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

/**
 * Rust 的 format!("{x:.N}")：按 double 的准确十进制值取整，正好一半时取偶数（1.125 → "1.12"、2.5 → "2"）。
 * JS 的 toFixed 正好一半时进位（"1.13"、"3"），所以 codex 的数字不能直接用 toFixed。只处理非负数。
 */
export function rustFixed(x: number, digits: number): string {
  if (!Number.isFinite(x) || x < 0) return x.toFixed(digits);
  // toFixed(100) 是准确的十进制展开（这里的数都在 1e-48 以上，小数位不超过 100）
  const [int = '0', frac = ''] = x.toFixed(100).split('.');
  const kept = frac.slice(0, digits);
  const rest = frac.slice(digits);
  let n = BigInt(int + kept);
  const first = rest.charAt(0);
  const tailNonZero = /[1-9]/.test(rest.slice(1));
  if (first > '5' || (first === '5' && (tailNonZero || n % 2n === 1n))) n += 1n;
  const s = n.toString().padStart(digits + 1, '0');
  return digits === 0 ? s : `${s.slice(0, -digits)}.${s.slice(-digits)}`;
}

/** kimi 的写法：k 按 1024 算，100k 以上取整（977k），一位小数去掉多余的 .0（kimi-code src/utils/usage/usage-format.ts formatTokenCount）。 */
export function abbreviate1024(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n < 0) return '–';
  if (n >= 1024 * 1024) return `${trim1(n / (1024 * 1024))}M`;
  if (n >= 1024) {
    const k = n / 1024;
    return `${k >= 100 ? Math.round(k) : trim1(k)}k`;
  }
  return String(Math.round(n));
}

/**
 * codex 的写法（codex-rs/tui/src/status/helpers.rs format_tokens_compact）：大写 K / M / B / T；
 * 小于 10 两位小数、小于 100 一位、再大取整，去掉末尾的 0：1,234 → 1.23K，27,756 → 27.8K，475,000 → 475K。
 * 999,999 照它写成 1000K（它不进位到 M）。
 */
export function codexTokens(n: number): string {
  const v = Math.max(0, Math.trunc(n));
  if (v === 0) return '0';
  if (v < 1000) return String(v);
  const [scaled, suffix] =
    v >= 1e12 ? [v / 1e12, 'T'] : v >= 1e9 ? [v / 1e9, 'B'] : v >= 1e6 ? [v / 1e6, 'M'] : [v / 1e3, 'K'];
  const decimals = scaled < 10 ? 2 : scaled < 100 ? 1 : 0;
  let s = rustFixed(scaled, decimals);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return `${s}${suffix}`;
}

// claude 的 formatNumber 要两个格式器（新建很慢，缓存起来，claude 自己也这样）
let claudeConsistent: Intl.NumberFormat | null = null;
let claudeLoose: Intl.NumberFormat | null = null;

/**
 * claude 的写法（claude-code src/utils/format.ts formatTokens / formatNumber，2.1.291 的二进制里同样）：
 * Intl 的 en-US compact，≥ 1000 时固定一位小数，转小写，再去掉第一个 “.0”：52,476 → 52.5k，1,000,000 → 1m。
 */
export function claudeTokens(n: number): string {
  const consistent = n >= 1000;
  const f = consistent
    ? (claudeConsistent ??= new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1, minimumFractionDigits: 1 }))
    : (claudeLoose ??= new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1, minimumFractionDigits: 0 }));
  return f.format(n).toLowerCase().replace('.0', '');
}

/**
 * pi 的写法（@earendil-works/pi-coding-agent dist/modes/interactive/components/footer.js formatTokens）：
 * 小于 1 万一位小数（1.2k），小于 100 万取整（52k），小于 1000 万一位小数（1.0M，不去 .0），再大取整。
 */
export function piTokens(n: number): string {
  if (n < 1000) return n.toString();
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${Math.round(n / 1_000_000)}M`;
}

/**
 * omp 的写法（@oh-my-pi/pi-utils src/format.ts formatNumber，状态栏 status-line/segments.ts 用它）：
 * 大写 K / M / B；首位小于 10 时一位小数并去掉 .0（1.5K、1K），否则取整（52K、1M）。
 */
export function ompTokens(n: number): string {
  if (n < 1_000) return n.toString();
  if (n < 10_000) return `${trim1(n / 1_000)}K`;
  if (n < 1_000_000) return `${Math.round(n / 1_000)}K`;
  if (n < 10_000_000) return `${trim1(n / 1_000_000)}M`;
  if (n < 1_000_000_000) return `${Math.round(n / 1_000_000)}M`;
  if (n < 10_000_000_000) return `${trim1(n / 1_000_000_000)}B`;
  return `${Math.round(n / 1_000_000_000)}B`;
}

/** codex 算上下文占比时先扣掉的基线（codex-rs/tui/src/token_usage.rs 的 BASELINE_TOKENS）。 */
export const CODEX_BASELINE_TOKENS = 12_000;

/** 上下文的百分比：value 给进度条和变黄（0–100，用了多少），text 是照 agent 写的那段字。 */
interface ContextPercent {
  value: number;
  text: string;
}

/** 重置时间用 12 小时还是 24 小时制。 */
export type ClockFormat = '12h' | '24h';

/**
 * 系统的时钟习惯，同 codex 的 ClockFormat::system()（codex-rs/tui/src/clock_format.rs：macOS 看 locale 的 “j” 模板）。
 * 这里看 Intl 的 hourCycle；看不出来时和 codex 一样当 12 小时制。
 */
export function systemClock(): ClockFormat {
  try {
    const hc = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle;
    return hc === 'h23' || hc === 'h24' ? '24h' : '12h';
  } catch {
    return '12h';
  }
}

interface LimitRow {
  label: string;
  text: string;
}

interface AgentFormat {
  /** token 数（条上的 Input / Output / Cache、上下文的用量和窗口、小卡片）。 */
  tokens(n: number): string;
  /** 上下文百分比；window 不知道时只能用服务报的 reported。 */
  contextPercent(tokens: number, window: number | null, reported: number | null): ContextPercent | null;
  /** 账号额度的一行。现在只有 codex 的会话文件带额度，别的 agent 用 genericLimit。 */
  limit?(w: RateLimitWindow, isSecondary: boolean, now: Date, clock: ClockFormat): LimitRow;
}

const clamp100 = (p: number) => Math.min(100, Math.max(0, p));

/** 照 Math.round 的整数百分比（claude、不认识的 agent）。 */
function roundedPercent(tokens: number, window: number | null, reported: number | null): ContextPercent | null {
  const p = window ? (tokens / window) * 100 : reported;
  if (p === null || !Number.isFinite(p)) return null;
  const r = Math.round(p);
  return { value: clamp100(r), text: `${r}%` };
}

/** 一位小数的百分比（pi、omp：`${percent.toFixed(1)}%`）。 */
function oneDecimalPercent(tokens: number, window: number | null, reported: number | null): ContextPercent | null {
  const p = window ? (tokens / window) * 100 : reported;
  if (p === null || !Number.isFinite(p)) return null;
  return { value: clamp100(p), text: `${p.toFixed(1)}%` };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * codex 的重置时间（codex-rs/tui/src/status/helpers.rs format_reset_timestamp + clock_format.rs time_format）：
 * 同一天只写时间，24 小时制 “14:05”、12 小时制 “2:05 PM”；不是同一天加 “ on 27 Oct”。
 */
export function codexResetTime(iso: string, now: Date, clock: ClockFormat): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const mm = String(d.getMinutes()).padStart(2, '0');
  const time =
    clock === '24h' ? `${String(d.getHours()).padStart(2, '0')}:${mm}` : `${d.getHours() % 12 || 12}:${mm} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? time : `${time} on ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/**
 * codex 额度窗口的名字（codex-rs/tui/src/chatwidget/rate_limits.rs get_limits_duration，±5% 算同一种；
 * status/rate_limits.rs 首字母大写再加 “ limit”）：5h limit、Daily / Weekly / Monthly / Annual limit，
 * 认不出时 Usage limit / Secondary usage limit。
 */
export function limitLabel(w: RateLimitWindow, isSecondary = false): string {
  const near = (m: number, expected: number) => m >= expected * 0.95 && m <= expected * 1.05;
  const m = w.windowMinutes === null ? null : Math.max(0, w.windowMinutes);
  const day = 24 * 60;
  const name =
    m === null
      ? null
      : near(m, 5 * 60)
        ? '5h'
        : near(m, day)
          ? 'Daily'
          : near(m, 7 * day)
            ? 'Weekly'
            : near(m, 30 * day)
              ? 'Monthly'
              : near(m, 365 * day)
                ? 'Annual'
                : null;
  return `${name ?? (isSecondary ? 'Secondary usage' : 'Usage')} limit`;
}

/**
 * codex 额度的那一段字（codex-rs/tui/src/status/card.rs rate_limit_row_lines + status/rate_limits.rs format_status_limit_summary）：
 * codex 写 “还剩多少”：“99% left (resets 14:05)”。数是先取整再减：app-server 把 used_percent 四舍五入成整数
 * （app-server-protocol/src/protocol/v2/account.rs `value.used_percent.round() as i32`），界面再 100 − used。
 * 所以用了 0.6% 时 codex 写 99% left；直接写 “1% used” 或者 Math.round(0.4) 得 “0% used” 都和它对不上。
 */
export function codexLimitText(w: RateLimitWindow, now: Date, clock: ClockFormat): string {
  const used = Number.isFinite(w.usedPercent) ? Math.round(w.usedPercent) : 0;
  const left = clamp100(100 - used);
  const at = w.resetsAt ? codexResetTime(w.resetsAt, now, clock) : '';
  return at ? `${left}% left (resets ${at})` : `${left}% left`;
}

/** 别的 agent 有额度时的通用写法（目前没有 agent 走到这里）：“23% used · resets 14:05”。 */
function genericLimit(w: RateLimitWindow, isSecondary: boolean, now: Date): LimitRow {
  const used = `${percentText(w.usedPercent) ?? '–'} used`;
  const at = w.resetsAt ? historyTime(w.resetsAt, now) : '';
  return { label: limitLabel(w, isSecondary), text: at ? `${used} · resets ${at}` : used };
}

/**
 * 每个 agent 的写法。出处：
 * - claude：src/utils/format.ts formatTokens；/context 的百分比 src/utils/analyzeContext.ts
 *   `Math.round((totalTokens / contextWindow) * 100)`，界面 components/ContextVisualization.tsx 写 “52.5k/1m tokens (5%)”。
 *   底栏的 “x% until auto-compact” 是按自动压缩的阈值算的另一个数，不照它。
 * - codex：token 数 status/helpers.rs format_tokens_compact；上下文 token_usage.rs percent_of_context_window_remaining
 *   （先扣 12000 基线、round），底栏 bottom_pane/footer.rs 写 “97% context left”，/status 写 “97% left (27.8K used / 475K)”，
 *   状态栏的 “Context 3% used” 是 100 − 那个取过整的 left（chatwidget/status_controls.rs）。我们写 “97% left”，进度条按用了的 3%。
 * - pi：footer.js formatTokens；上下文 core/agent-session.js getContextUsage `tokens / contextWindow * 100`，底栏 `toFixed(1)`（“5.2%/1.0M”）。
 * - omp：pi-utils formatNumber；上下文 status-line/context-thresholds.ts formatContextUsage `toFixed(1)`（“5.2%/1M”）。
 * - kimi：src/utils/usage/usage-format.ts formatTokenCount（1024 进位）、usagePercent（向上取整，夹在 0–100）。
 */
export const AGENT_FORMATS: Record<'claude' | 'codex' | 'pi' | 'omp' | 'kimi', AgentFormat> = {
  claude: { tokens: claudeTokens, contextPercent: roundedPercent },
  codex: {
    tokens: codexTokens,
    contextPercent: (tokens, window) => {
      if (!window) return null;
      let left = 0;
      if (window > CODEX_BASELINE_TOKENS) {
        const effective = window - CODEX_BASELINE_TOKENS;
        const used = Math.max(0, tokens - CODEX_BASELINE_TOKENS);
        left = Math.round(clamp100((Math.max(0, effective - used) / effective) * 100));
      }
      return { value: 100 - left, text: `${left}% left` };
    },
    limit: (w, isSecondary, now, clock) => ({ label: limitLabel(w, isSecondary), text: codexLimitText(w, now, clock) }),
  },
  pi: { tokens: piTokens, contextPercent: oneDecimalPercent },
  omp: { tokens: ompTokens, contextPercent: oneDecimalPercent },
  kimi: {
    tokens: (n) => abbreviate1024(n),
    contextPercent: (tokens, window) => {
      if (!window || window <= 0) return null;
      const p = clamp100(Math.ceil((tokens / window) * 100));
      return { value: p, text: `${p}%` };
    },
  },
};

/** 不认识的 agent（或 agent 是 null）。 */
const FALLBACK_FORMAT: AgentFormat = { tokens: (n) => abbreviate(n), contextPercent: roundedPercent };

export function agentFormat(agent: AgentKind | null | undefined): AgentFormat {
  return agent && agent in AGENT_FORMATS ? AGENT_FORMATS[agent as keyof typeof AGENT_FORMATS] : FALLBACK_FORMAT;
}

/** 照这个 agent 的写法写一个 token 数；不知道时 “–”。 */
export function tokensText(agent: AgentKind | null | undefined, n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  return agentFormat(agent).tokens(Math.max(0, n));
}

export interface ContextDisplay {
  used: string;
  window: string | null;
  /** 0–100，用了多少（进度条宽度、变黄）；没有窗口大小、服务也没报时为 null。 */
  percent: number | null;
  /** 百分比照 agent 自己的写法：claude “5%”、codex “97% left”、pi / omp “5.2%”、kimi “8%”。 */
  percentText: string | null;
}

/** 上下文那一格照 agent 自己界面上的写法算，和终端里看到的对得上（各家的写法见 AGENT_FORMATS）。 */
export function contextDisplay(u: TerminalUsage | null): ContextDisplay | null {
  const ctx = u?.context;
  if (!u || !ctx || ctx.tokens === null || ctx.tokens === undefined) return null;
  const f = agentFormat(u.agent);
  const window = ctx.window && ctx.window > 0 ? ctx.window : null;
  const p = f.contextPercent(ctx.tokens, window, ctx.percent ?? null);
  return {
    used: tokensText(u.agent, ctx.tokens),
    window: window ? tokensText(u.agent, window) : null,
    percent: p ? p.value : null,
    percentText: p ? p.text : null,
  };
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
    const p = contextDisplay(u)?.percentText;
    lines.push(`Context ${exact(ctx.tokens)}${ctx.window !== null ? ` of ${exact(ctx.window)}` : ''}${p ? ` (${p})` : ''}`);
  }
  if (u.model) lines.push(u.model);
  if (u.match === 'inferred') lines.push(INFERRED_NOTE);
  return lines.join('\n');
}

/** 小卡片里最近一次请求那一行：Input 2.1k · Output 640 · Cache 94k（缓存写不为 0 时 94k / 1.2k）。数照 agent 的写法。 */
export function lastRequestText(t: TokenCounts | null, agent: AgentKind | null = null): string {
  if (!t) return '–';
  const n = (x: number | null) => tokensText(agent, x);
  const cache = t.cacheWrite ? `${n(t.cacheRead)} / ${n(t.cacheWrite)}` : n(t.cacheRead);
  return `Input ${n(t.input)} · Output ${n(t.output)} · Cache ${cache}`;
}

/** 一个额度窗口那一行的字（照 agent 的写法；codex 是 “99% left (resets 14:05)”）。 */
export function limitText(w: RateLimitWindow, agent: AgentKind | null = 'codex', now: Date = new Date(), clock: ClockFormat = systemClock()): string {
  const f = agentFormat(agent);
  return f.limit ? f.limit(w, false, now, clock).text : genericLimit(w, false, now).text;
}

/** 小卡片里额度的几行（只有 codex 有）。 */
export function limitRows(u: TerminalUsage, now: Date = new Date(), clock: ClockFormat = systemClock()): LimitRow[] {
  const rows: LimitRow[] = [];
  const r = u.rateLimits;
  if (!r) return rows;
  const f = agentFormat(u.agent);
  const row = (w: RateLimitWindow, isSecondary: boolean) => (f.limit ? f.limit(w, isSecondary, now, clock) : genericLimit(w, isSecondary, now));
  if (r.primary) rows.push(row(r.primary, false));
  if (r.secondary) rows.push(row(r.secondary, true));
  return rows;
}
