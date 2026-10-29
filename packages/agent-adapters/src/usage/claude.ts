// claude 的会话文件：~/.claude/projects/<目录名>/<sessionId>.jsonl（目录名 = cwd 里非字母数字都换成 -）。
// 实测（2026-10-25，claude 2.1.291）：
//   - type:"assistant" 行的 message.usage {input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
//     output_tokens_details.thinking_tokens}；一次回答按内容块拆成几行，message.id 相同，按 id 去重（后来的行覆盖前面的）。
//   - input_tokens 不含缓存；output_tokens 含思考。
//   - message.model 为 "<synthetic>" 的是 claude 自己插的（出错提示），不是请求，跳过。
//   - 上下文 = 最后一条主线（isSidechain 不为 true）assistant 的 input + cache_read + cache_creation（和 claude 状态栏同一算法）；
//     type:"system" subtype:"compact_boundary" 之后、下一条 assistant 之前不知道。
//   - 子 agent 的记录在 <sessionId>/subagents/ 下的单独文件，不算进这次对话（只看主对话）。
//   - 窗口不写在文件里，按模型查表（下面 CLAUDE_WINDOWS，从 2.1.291 自带的模型表抄的）；
//     看到的上下文超过表里的窗口时，说明用户开了 1M（[1m] 后缀或 beta），按 1M 算，windowSource 为 observed。
//   - 额度用完（PL3，DR-63，2026-10-26 本机真遇到过）：一行 type:"assistant"、error:"rate_limit"、isApiErrorMessage、
//     apiErrorStatus 429，带 quotaLimits { status:"rejected", rateLimitType:"five_hour" | …, resetsAt:<秒> }，message.model
//     是 "<synthetic>"。之后再有成功的回答（带 usage 的非 synthetic assistant）就算恢复了。

import type { LimitScope, TokenCounts, UsageLimit } from '@agentdeck/contracts';
import type { Json, ParsedUsage, UsageParser } from './types.ts';
import { addCounts, contextOf, isoOf, num, obj, parseLine, str, subCounts, zeroCounts } from './types.ts';

const M = 1_000_000;
const K200 = 200_000;

/**
 * 模型名前缀 → 默认窗口。claude 2.1.291 的内置模型表（context.window）：原生 1M 的在这里写 1M，
 * 其余是 200k（可以用 [1m] 开到 1M，文件里看不出来）。前缀匹配，长的优先。
 */
export const CLAUDE_WINDOWS: readonly [prefix: string, window: number][] = [
  ['claude-opus-5', M], // opus-5、opus-5-5
  ['claude-opus-4-8', M],
  ['claude-opus-4-7', M],
  ['claude-opus-4', K200], // 4、4-1、4-5、4-6
  ['claude-sonnet-5', M], // sonnet-5、sonnet-5-5
  ['claude-sonnet-4', K200],
  ['claude-fable-5', M],
  ['claude-mythos', M],
  ['claude-haiku', K200],
  ['claude-3', K200],
];

export function claudeWindow(model: string | null): number {
  if (!model) return K200;
  const m = model.toLowerCase().replace(/\[1m\]$/, '');
  if (/\[1m\]$/i.test(model)) return M;
  let best: [string, number] | null = null;
  for (const row of CLAUDE_WINDOWS) if (m.startsWith(row[0]) && (!best || row[0].length > best[0].length)) best = row;
  return best ? best[1] : K200;
}

/** claude 存会话的目录名：路径里非字母数字的字符都换成 -（"/Users/me/a.b" → "-Users-me-a-b"）。 */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

function countsOf(u: Json): TokenCounts | null {
  const input = num(u['input_tokens']);
  const output = num(u['output_tokens']);
  if (input === null && output === null) return null;
  const details = obj(u['output_tokens_details']);
  return {
    input: input ?? 0,
    output: output ?? 0,
    cacheRead: num(u['cache_read_input_tokens']) ?? 0,
    cacheWrite: num(u['cache_creation_input_tokens']) ?? 0,
    reasoning: details ? num(details['thinking_tokens']) : null,
  };
}

export class ClaudeUsageParser implements UsageParser {
  private readonly byId = new Map<string, TokenCounts>();
  private total: TokenCounts = zeroCounts(0, null);
  private lastId: string | null = null;
  private model: string | null = null;
  /** 最后一条主线回答的上下文；压缩后为 null。 */
  private contextTokens: number | null = null;
  private maxSeen = 0;
  private updatedAt: string | null = null;
  private sessionId: string | null = null;
  private anon = 0;
  private limit: UsageLimit | null = null;

  feed(line: string): void {
    // 先粗筛，大文件里绝大多数是用户消息和工具结果，不用 JSON.parse
    const assistant = line.includes('"assistant"');
    if (assistant && line.includes('"rate_limit"') && line.includes('isApiErrorMessage')) {
      const d = parseLine(line);
      if (d && d['type'] === 'assistant' && d['error'] === 'rate_limit') this.limit = claudeLimitOf(d);
      return;
    }
    const compact = !assistant && line.includes('compact_boundary');
    if (!assistant && !compact) return;
    const d = parseLine(line);
    if (!d) return;
    if (d['type'] === 'system' && d['subtype'] === 'compact_boundary') {
      this.contextTokens = null;
      return;
    }
    if (d['type'] !== 'assistant') return;
    const m = obj(d['message']);
    const u = m && obj(m['usage']);
    if (!m || !u) return;
    const model = str(m['model']);
    if (model === '<synthetic>') return;
    const counts = countsOf(u);
    if (!counts) return;
    // 碰到上限之后又有成功的请求：额度恢复了
    if (this.limit && d['isSidechain'] !== true) this.limit = null;
    const id = str(m['id']) ?? str(d['requestId']) ?? `anon-${++this.anon}`;
    const prev = this.byId.get(id);
    if (prev) this.total = subCounts(this.total, prev);
    this.byId.set(id, counts);
    this.total = addCounts(this.total, counts);
    this.sessionId = str(d['sessionId']) ?? this.sessionId;
    this.updatedAt = isoOf(d['timestamp']) ?? this.updatedAt;
    if (d['isSidechain'] === true) return;
    this.lastId = id;
    if (model) this.model = model;
    const ctx = counts.input + counts.cacheRead + (counts.cacheWrite ?? 0);
    this.contextTokens = ctx;
    this.maxSeen = Math.max(this.maxSeen, ctx);
  }

  snapshot(): ParsedUsage {
    const requests = this.byId.size;
    const last = this.lastId ? (this.byId.get(this.lastId) ?? null) : null;
    let window = claudeWindow(this.model);
    let source: 'model-table' | 'observed' = 'model-table';
    if (this.maxSeen > window) {
      window = M;
      source = 'observed';
    }
    return {
      model: this.model,
      total: requests > 0 ? { ...this.total } : null,
      last: last ? { ...last } : null,
      requests,
      context: requests > 0 ? contextOf(this.contextTokens, window, source) : null,
      rateLimits: null,
      updatedAt: this.updatedAt,
      sessionId: this.sessionId,
      limit: this.limit ? { ...this.limit } : null,
    };
  }
}

const CLAUDE_LIMIT_KIND: Record<string, UsageLimit['kind']> = { five_hour: 'five_hour', seven_day: 'weekly', seven_day_opus: 'weekly', seven_day_sonnet: 'weekly', weekly: 'weekly' };

/** quotaLimits.rateLimitType 是 Opus / Sonnet 单独的每周额度时（PL5：账号键的范围）。 */
const CLAUDE_LIMIT_SCOPE: Record<string, LimitScope> = { seven_day_opus: 'opus', seven_day_sonnet: 'sonnet' };

/** error "rate_limit" 那一行 → 碰到的额度上限。Opus / Sonnet 单独的额度另带 scope（UsageLimit.scope，contracts 0.1.22）。 */
export function claudeLimitOf(d: Json): UsageLimit {
  const q = obj(d['quotaLimits']);
  const type = q ? str(q['rateLimitType']) : null;
  const resets = q ? num(q['resetsAt']) : null;
  const m = obj(d['message']);
  const content = m?.['content'];
  let detail: string | null = null;
  if (Array.isArray(content)) {
    for (const c of content) {
      const t = obj(c);
      if (t?.['type'] === 'text' && str(t['text'])) {
        detail = str(t['text']);
        break;
      }
    }
  }
  const scope = type ? CLAUDE_LIMIT_SCOPE[type] : undefined;
  return {
    kind: (type && CLAUDE_LIMIT_KIND[type]) || (type ? 'other' : 'five_hour'),
    // 秒；毫秒的值也认（大于 1e12）
    resetsAt: resets !== null ? new Date(resets > 1e12 ? resets : resets * 1000).toISOString() : null,
    at: isoOf(d['timestamp']),
    detail,
    ...(scope ? { scope } : {}),
  };
}
