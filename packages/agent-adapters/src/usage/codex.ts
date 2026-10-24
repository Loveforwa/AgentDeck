// codex 的会话文件：~/.codex/sessions/YYYY/MM/DD/rollout-<本地时间>-<会话 id>.jsonl（$CODEX_HOME 可改根目录）。
// 实测（2026-10-25，文件由 codex 0.159–0.164 写）：
//   - type:"event_msg"、payload.type:"token_count"：payload.info.total_token_usage / last_token_usage
//     {input_tokens（含缓存）, cached_input_tokens, cache_write_input_tokens（新版才有）, output_tokens（含思考）,
//      reasoning_output_tokens, total_tokens}，info.model_context_window；payload.rate_limits.primary / secondary
//     {used_percent, window_minutes, resets_at（Unix 秒）}。info 可能是 null（只更新额度）。
//   - 同一次请求的 token_count 可能重复发（total 不变），请求次数按 total_tokens 变化的次数算。
//   - 上下文 = last_token_usage.total_tokens，窗口 = model_context_window（codex 自己报的）。
//     type:"compacted" 之后、下一个 token_count 之前不知道。
//   - 模型在 type:"turn_context" 的 payload.model；会话 id 在 type:"session_meta" 的 payload.id。
//   - 另有 type:"token_usage_record"（每次响应一条，含压缩请求），和 token_count 的累计略有出入；
//     我们跟 codex 自己的 /status 一样用 token_count。

import type { RateLimitWindow, TokenCounts } from '@agentdeck/contracts';
import type { Json, ParsedUsage, UsageParser } from './types.ts';
import { contextOf, isoOf, num, obj, parseLine, str } from './types.ts';

function countsOf(u: Json | null): TokenCounts | null {
  if (!u) return null;
  const input = num(u['input_tokens']);
  const output = num(u['output_tokens']);
  if (input === null && output === null) return null;
  const cached = num(u['cached_input_tokens']) ?? 0;
  return {
    input: Math.max(0, (input ?? 0) - cached),
    output: output ?? 0,
    cacheRead: cached,
    cacheWrite: num(u['cache_write_input_tokens']),
    reasoning: num(u['reasoning_output_tokens']),
  };
}

function windowOf(v: unknown): RateLimitWindow | null {
  const w = obj(v);
  const used = w ? num(w['used_percent']) : null;
  if (!w || used === null) return null;
  const resets = num(w['resets_at']);
  return { usedPercent: used, windowMinutes: num(w['window_minutes']), resetsAt: resets !== null ? new Date(resets * 1000).toISOString() : null };
}

export class CodexUsageParser implements UsageParser {
  private total: TokenCounts | null = null;
  private last: TokenCounts | null = null;
  private lastTotalTokens: number | null = null;
  private requests = 0;
  private contextTokens: number | null = null;
  private window: number | null = null;
  private model: string | null = null;
  private rateLimits: ParsedUsage['rateLimits'] = null;
  private updatedAt: string | null = null;
  private sessionId: string | null = null;

  feed(line: string): void {
    if (!line.includes('token_count') && !line.includes('"turn_context"') && !line.includes('"session_meta"') && !line.includes('"compacted"')) return;
    const d = parseLine(line);
    if (!d) return;
    const p = obj(d['payload']);
    switch (d['type']) {
      case 'session_meta':
        this.sessionId = (p && (str(p['id']) ?? str(p['session_id']))) ?? this.sessionId;
        return;
      case 'turn_context':
        this.model = (p && str(p['model'])) ?? this.model;
        return;
      case 'compacted':
        this.contextTokens = null;
        return;
      case 'event_msg':
        if (p?.['type'] === 'token_count') this.tokenCount(p, d['timestamp']);
        return;
    }
  }

  private tokenCount(p: Json, at: unknown): void {
    const rl = obj(p['rate_limits']);
    if (rl) {
      const primary = windowOf(rl['primary']);
      const secondary = windowOf(rl['secondary']);
      if (primary || secondary) this.rateLimits = { primary, secondary };
    }
    const info = obj(p['info']);
    if (!info) return;
    const totalRaw = obj(info['total_token_usage']);
    const lastRaw = obj(info['last_token_usage']);
    const total = countsOf(totalRaw);
    if (!total) return;
    const totalTokens = (totalRaw && num(totalRaw['total_tokens'])) ?? total.input + total.cacheRead + total.output;
    if (totalTokens !== this.lastTotalTokens) {
      this.requests += 1;
      this.lastTotalTokens = totalTokens;
    }
    this.total = total;
    const last = countsOf(lastRaw);
    if (last) {
      this.last = last;
      const lastTotal = lastRaw && num(lastRaw['total_tokens']);
      this.contextTokens = lastTotal ?? last.input + last.cacheRead + last.output;
    }
    this.window = num(info['model_context_window']) ?? this.window;
    this.updatedAt = isoOf(at) ?? this.updatedAt;
  }

  snapshot(): ParsedUsage {
    return {
      model: this.model,
      total: this.total ? { ...this.total } : null,
      last: this.last ? { ...this.last } : null,
      requests: this.requests,
      context: this.total ? contextOf(this.contextTokens, this.window, 'agent') : null,
      rateLimits: this.rateLimits,
      updatedAt: this.updatedAt,
      sessionId: this.sessionId,
    };
  }
}
