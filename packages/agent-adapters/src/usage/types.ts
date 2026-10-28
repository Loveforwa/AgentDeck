// 用量读取器的公共部分：每种 agent 一个 UsageParser，一行一行喂会话文件，随时能取当前的统计。
// 原则：认不出的行一律跳过；某一项 agent 不报就是 null，不估。

import type { ContextUsage, IsoTime, RateLimitWindow, TokenCounts, UsageLimit } from '@agentdeck/contracts';

/** 读取器从会话文件里得到的东西。服务再加上终端、会话 id、文件路径拼成 TerminalUsage。 */
export interface ParsedUsage {
  model: string | null;
  total: TokenCounts | null;
  last: TokenCounts | null;
  requests: number;
  context: ContextUsage | null;
  rateLimits: { primary: RateLimitWindow | null; secondary: RateLimitWindow | null } | null;
  updatedAt: IsoTime | null;
  /** 文件里写的会话 id（codex 的 session_meta、pi 的 session 行），对不上时服务据此报错。 */
  sessionId: string | null;
  /** PL3：最近碰到的额度上限、之后还没有成功的请求。读取器不支持时不填。 */
  limit?: UsageLimit | null;
}

export interface UsageParser {
  /** 一行（不含换行符）。坏行、认不出的行直接忽略。 */
  feed(line: string): void;
  snapshot(): ParsedUsage;
}

export const EMPTY_PARSED: ParsedUsage = {
  model: null,
  total: null,
  last: null,
  requests: 0,
  context: null,
  rateLimits: null,
  updatedAt: null,
  sessionId: null,
};

export function zeroCounts(cacheWrite: number | null = 0, reasoning: number | null = null): TokenCounts {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite, reasoning };
}

/** a + b。某一项一边是 null 时按另一边（都 null 才是 null）。 */
export function addCounts(a: TokenCounts, b: TokenCounts): TokenCounts {
  const nullable = (x: number | null, y: number | null) => (x === null && y === null ? null : (x ?? 0) + (y ?? 0));
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: nullable(a.cacheWrite, b.cacheWrite),
    reasoning: nullable(a.reasoning, b.reasoning),
  };
}

export function subCounts(a: TokenCounts, b: TokenCounts): TokenCounts {
  const nullable = (x: number | null, y: number | null) => (x === null && y === null ? null : (x ?? 0) - (y ?? 0));
  return {
    input: a.input - b.input,
    output: a.output - b.output,
    cacheRead: a.cacheRead - b.cacheRead,
    cacheWrite: nullable(a.cacheWrite, b.cacheWrite),
    reasoning: nullable(a.reasoning, b.reasoning),
  };
}

export function isZero(c: TokenCounts): boolean {
  return c.input === 0 && c.output === 0 && c.cacheRead === 0 && !c.cacheWrite;
}

export function contextOf(
  tokens: number | null,
  window: number | null,
  windowSource: ContextUsage['windowSource'],
): ContextUsage {
  const percent = tokens !== null && window !== null && window > 0 ? Math.round((tokens / window) * 1000) / 10 : null;
  return { tokens, window, percent, windowSource: window === null ? null : windowSource };
}

// ---- 解析小工具 ----

export type Json = Record<string, unknown>;

export function parseLine(line: string): Json | null {
  if (!line || line.charCodeAt(0) !== 123 /* { */) return null;
  try {
    const v: unknown = JSON.parse(line);
    return obj(v);
  } catch {
    return null;
  }
}

export function obj(v: unknown): Json | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null;
}

/** 非负有限数，否则 null。 */
export function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

export function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

/** ISO 时间串或毫秒数 → ISO。认不出为 null。 */
export function isoOf(v: unknown): IsoTime | null {
  if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return new Date(v).toISOString();
  return null;
}
