// kimi 的会话文件：~/.kimi-code/sessions/wd_<目录名>_<hash>/session_<uuid>/agents/main/wire.jsonl。
// 实测（2026-10-25，kimi 2.3.1 写的文件）：
//   - 第一行 type:"metadata" {protocol_version, created_at（毫秒）}。
//   - type:"usage.record" 每次请求一条：model（配置里的别名，如 "deepseek/deepseek-v4-pro"），
//     usage {inputOther（不含缓存）, output, inputCacheRead, inputCacheCreation}，time（毫秒）。没有单独的思考 token。
//   - type:"token_counting.measured" {tokens}：kimi 自己量的当前上下文长度（2.3 起才有）。
//   - 窗口在 ~/.kimi-code/config.toml 的 [models."<别名>"] max_context_size（只读）。
//   - 会话索引 ~/.kimi-code/session_index.jsonl：每行 {sessionId: "session_<uuid>", sessionDir, workDir}。
//   - kimi 没有钩子，启动时也不知道会话 id，新会话只能按目录和启动时间推断（service.ts 的 locateKimi）。
//   - 子 agent 在 agents/<别的名字>/wire.jsonl，不算进这次对话。

import type { TokenCounts } from '@agentdeck/contracts';
import type { Json, ParsedUsage, UsageParser } from './types.ts';
import { addCounts, contextOf, isoOf, num, obj, parseLine, str, zeroCounts } from './types.ts';

function countsOf(u: Json): TokenCounts | null {
  const input = num(u['inputOther']);
  const output = num(u['output']);
  if (input === null && output === null) return null;
  return {
    input: input ?? 0,
    output: output ?? 0,
    cacheRead: num(u['inputCacheRead']) ?? 0,
    cacheWrite: num(u['inputCacheCreation']) ?? 0,
    reasoning: null,
  };
}

export class KimiUsageParser implements UsageParser {
  private total: TokenCounts = zeroCounts(0, null);
  private last: TokenCounts | null = null;
  private requests = 0;
  private model: string | null = null;
  private contextTokens: number | null = null;
  private updatedAt: string | null = null;
  /** 第一行 metadata 的 created_at。 */
  createdAt: number | null = null;

  /** windowFor：按模型别名查 config.toml 里的 max_context_size。 */
  constructor(private readonly windowFor: (model: string | null) => number | null = () => null) {}

  feed(line: string): void {
    if (!line.includes('usage.record') && !line.includes('token_counting.measured') && !line.includes('"metadata"')) return;
    const d = parseLine(line);
    if (!d) return;
    switch (d['type']) {
      case 'metadata':
        this.createdAt = num(d['created_at']) ?? this.createdAt;
        return;
      case 'token_counting.measured': {
        const t = num(d['tokens']);
        if (t !== null) this.contextTokens = t;
        return;
      }
      case 'usage.record': {
        const u = obj(d['usage']);
        const counts = u && countsOf(u);
        if (!counts) return;
        this.requests += 1;
        this.total = addCounts(this.total, counts);
        this.last = counts;
        this.model = str(d['model']) ?? this.model;
        // 新的请求之后、kimi 再量一次之前，用这次请求的输入 + 输出当上下文
        this.contextTokens = counts.input + counts.cacheRead + (counts.cacheWrite ?? 0) + counts.output;
        this.updatedAt = isoOf(d['time']) ?? this.updatedAt;
        return;
      }
    }
  }

  snapshot(): ParsedUsage {
    return {
      model: this.model,
      total: this.requests > 0 ? { ...this.total } : null,
      last: this.last ? { ...this.last } : null,
      requests: this.requests,
      context: this.requests > 0 ? contextOf(this.contextTokens, this.windowFor(this.model), 'config') : null,
      rateLimits: null,
      updatedAt: this.updatedAt,
      sessionId: null,
    };
  }
}

/**
 * 从 config.toml 里取每个模型的 max_context_size。只认这一种写法，够用就行：
 *   [models."deepseek/deepseek-v4-pro"]
 *   max_context_size = 1000000
 * 另外取顶层的 default_model。
 */
export function parseKimiConfig(text: string): { windows: Map<string, number>; defaultModel: string | null } {
  const windows = new Map<string, number>();
  let defaultModel: string | null = null;
  let section: string | null = null;
  let top = true;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const header = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
    if (header) {
      top = false;
      const m = /^models\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))$/.exec(header[1]!);
      section = m ? (m[1] ?? m[2] ?? m[3] ?? null) : null;
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    if (top && kv[1] === 'default_model') {
      const v = /^"([^"]*)"|^'([^']*)'/.exec(kv[2]!);
      defaultModel = v ? (v[1] ?? v[2] ?? null) : null;
    }
    if (section && kv[1] === 'max_context_size') {
      const n = Number(kv[2]!.replace(/_/g, ''));
      if (Number.isFinite(n) && n > 0) windows.set(section, n);
    }
  }
  return { windows, defaultModel };
}

export interface KimiIndexEntry {
  sessionId: string;
  sessionDir: string;
  workDir: string;
}

export function parseKimiIndex(text: string): KimiIndexEntry[] {
  const out: KimiIndexEntry[] = [];
  for (const line of text.split('\n')) {
    const d = parseLine(line.trim());
    const sessionId = d && str(d['sessionId']);
    const sessionDir = d && str(d['sessionDir']);
    const workDir = d && str(d['workDir']);
    if (sessionId && sessionDir && workDir) out.push({ sessionId, sessionDir, workDir });
  }
  return out;
}
