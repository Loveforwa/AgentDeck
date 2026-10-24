// pi 和 omp（pi 的分支）的会话文件：<agent 目录>/sessions/<目录名>/<ISO 时间>_<会话 id>.jsonl。
//   pi：~/.pi/agent/sessions/--<cwd 的 / 换成 ->--/…；omp：~/.omp/agent/sessions/…（目录名规则各版本不同，所以按文件名找）。
// 实测（2026-10-25，pi 0.83.0、omp 18.0.4 写的文件）：
//   - type:"session" 行带会话 id；type:"message" 行 message.role 为 "assistant" 时有 message.usage
//     {input, output, cacheRead, cacheWrite, reasoning?, totalTokens}。input 不含缓存（input+output+cacheRead+cacheWrite = totalTokens），
//     reasoning 是 output 的一部分（pi-ai 的 Usage 注释）。每条 assistant 一次请求，按行 id 去重。
//   - 模型在 message.model；type:"compaction" 是压缩。
//   - 窗口不在文件里：由 AgentDeck 的扩展调 ctx.getContextUsage() 报上来（服务合并，见 service.ts）。
//     没报之前上下文用最后一条 assistant 的 totalTokens（pi 自己 calculateContextTokens 的算法），窗口 null。

import type { TokenCounts } from '@agentdeck/contracts';
import type { Json, ParsedUsage, UsageParser } from './types.ts';
import { addCounts, contextOf, isoOf, isZero, num, obj, parseLine, str, subCounts, zeroCounts } from './types.ts';

function countsOf(u: Json): TokenCounts | null {
  const input = num(u['input']);
  const output = num(u['output']);
  if (input === null && output === null) return null;
  return {
    input: input ?? 0,
    output: output ?? 0,
    cacheRead: num(u['cacheRead']) ?? 0,
    cacheWrite: num(u['cacheWrite']) ?? 0,
    reasoning: num(u['reasoning']) ?? num(u['reasoningTokens']),
  };
}

export class PiUsageParser implements UsageParser {
  private readonly byId = new Map<string, TokenCounts>();
  private total: TokenCounts = zeroCounts(0, null);
  private last: TokenCounts | null = null;
  private model: string | null = null;
  private contextTokens: number | null = null;
  private updatedAt: string | null = null;
  private sessionId: string | null = null;
  private anon = 0;

  feed(line: string): void {
    if (!line.includes('"assistant"') && !line.includes('"session"') && !line.includes('"compaction"') && !line.includes('model_change'))
      return;
    const d = parseLine(line);
    if (!d) return;
    switch (d['type']) {
      case 'session':
        this.sessionId = str(d['id']) ?? this.sessionId;
        return;
      case 'model_change':
        this.model = str(d['modelId']) ?? this.model;
        return;
      case 'compaction':
        this.contextTokens = null;
        return;
      case 'message':
        break;
      default:
        return;
    }
    const m = obj(d['message']);
    if (!m || m['role'] !== 'assistant') return;
    const u = obj(m['usage']);
    const counts = u && countsOf(u);
    if (!u || !counts) return;
    this.model = str(m['model']) ?? this.model;
    // 中断、出错的回答 usage 全是 0，不算一次请求
    if (isZero(counts)) return;
    const id = str(d['id']) ?? `anon-${++this.anon}`;
    const prev = this.byId.get(id);
    if (prev) this.total = subCounts(this.total, prev);
    this.byId.set(id, counts);
    this.total = addCounts(this.total, counts);
    this.last = counts;
    this.contextTokens = num(u['totalTokens']) ?? counts.input + counts.output + counts.cacheRead + (counts.cacheWrite ?? 0);
    this.updatedAt = isoOf(d['timestamp']) ?? isoOf(m['timestamp']) ?? this.updatedAt;
  }

  snapshot(): ParsedUsage {
    const requests = this.byId.size;
    return {
      model: this.model,
      total: requests > 0 ? { ...this.total } : null,
      last: this.last ? { ...this.last } : null,
      requests,
      context: requests > 0 ? contextOf(this.contextTokens, null, null) : null,
      rateLimits: null,
      updatedAt: this.updatedAt,
      sessionId: this.sessionId,
    };
  }
}
