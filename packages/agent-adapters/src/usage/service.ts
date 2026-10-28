// UsageService（插件 PL2 · Usage，DR-55）：按终端读 agent 自己的会话文件，算这次对话的 token 用量。
//
//   lookup(terminalId) → agent、会话 id、cwd、启动时间（组装时由状态机和 store 提供）
//   → locate*（按会话 id 找文件；kimi 按目录和启动时间推断）
//   → JsonlTail（只读新增部分）→ 各 agent 的 UsageParser → TerminalUsage
//   → watch 着的终端有变化时 emit usage.changed（fs.watch 立即触发，另有 pollMs 的兜底轮询）
//
// pi / omp 的上下文窗口由 AgentDeck 的扩展上报（钩子名 USAGE_HOOK，见 tools/agentdeck-notify/bin/agentdeck-pi-extension.mjs），
// claude 的钩子负载带 transcript_path，都经 noteHook 交进来。
// 只读用户数据：不写、不改 ~/.claude ~/.codex ~/.pi ~/.omp ~/.kimi-code 里的任何东西。

import { watch as fsWatch, type FSWatcher } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AbsPath, AgentKind, AgentSessionId, TerminalId, TerminalUsage, UsageEvent, UsageService } from '@agentdeck/contracts';
import { ClaudeUsageParser } from './claude.ts';
import { CodexUsageParser } from './codex.ts';
import { KimiUsageParser, parseKimiConfig } from './kimi.ts';
import type { Located, UsageRoots } from './locate.ts';
import { locateClaude, locateCodex, locateKimi, locatePi } from './locate.ts';
import { PiUsageParser } from './pi.ts';
import { JsonlTail } from './tail.ts';
import type { ParsedUsage, UsageParser } from './types.ts';
import { contextOf, num, obj, str } from './types.ts';

/** pi / omp 扩展上报上下文用的钩子名。和 agentdeck-pi-extension.mjs 的 USAGE_HOOK 一致，测试会核对。 */
export const USAGE_HOOK = 'AgentDeckUsage';

export const USAGE_AGENTS = ['claude', 'codex', 'pi', 'omp', 'kimi'] as const;
type UsageAgent = (typeof USAGE_AGENTS)[number];
const isUsageAgent = (a: AgentKind): a is UsageAgent => (USAGE_AGENTS as readonly string[]).includes(a);

export interface UsageTarget {
  terminalId: TerminalId;
  agent: AgentKind;
  sessionId: AgentSessionId | null;
  /** 启动时的目录。claude 按它算项目目录，kimi 按它推断会话。 */
  cwd: AbsPath | null;
  /** 终端启动的时间（毫秒）。只有 kimi 推断会话时用；不知道为 null。 */
  startedAt: number | null;
}

export interface UsageServiceOptions {
  lookup: (terminalId: TerminalId) => UsageTarget | null;
  /** 所有终端。kimi 推断会话时要看同一目录里还有哪些 kimi 终端。不给时只看自己。 */
  targets?: () => UsageTarget[];
  emit: (event: UsageEvent) => void;
  roots: UsageRoots;
  /** watch 着的终端多久兜底检查一次，默认 1000。 */
  pollMs?: number;
  /** fs.watch 触发后等多久再读（一次写入常触发好几次），默认 100。 */
  throttleMs?: number;
  /** 还没找到文件（或 kimi 推断的会话）时多久重新找一次，默认 3000。 */
  relocateMs?: number;
  /** 默认 true。测试里关掉，只靠 poll。 */
  watchFiles?: boolean;
  now?: () => number;
}

interface ExtReport {
  sessionId: string | null;
  tokens: number | null;
  window: number | null;
  percent: number | null;
  model: string | null;
}

interface Entry {
  terminalId: TerminalId;
  key: string | null;
  located: Located | null;
  locatedAt: number;
  scannedAt: number;
  parser: UsageParser | null;
  tail: JsonlTail | null;
  fsw: FSWatcher | null;
  watching: boolean;
  /** 谁在看（UsageService.watch 的 owner）：最后一个 unwatch 了才停。 */
  owners: Set<string>;
  transcriptPath: string | null;
  ext: ExtReport | null;
  lastJson: string | null;
  last: TerminalUsage | null;
  busy: Promise<void>;
  timer: ReturnType<typeof setTimeout> | null;
}

/** 扫所有 claude 项目目录最多这么久一次（目录名算出来对不上时才扫）。 */
const CLAUDE_SCAN_MS = 15_000;

export class UsageServiceImpl implements UsageService {
  private readonly entries = new Map<TerminalId, Entry>();
  private poller: ReturnType<typeof setInterval> | null = null;
  private kimiConfig: { mtime: number; windows: Map<string, number>; defaultModel: string | null } | null = null;
  private closed = false;

  constructor(private readonly opts: UsageServiceOptions) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  // ---- UsageService ----

  async get(terminalId: TerminalId): Promise<TerminalUsage> {
    const e = this.entry(terminalId);
    await this.refresh(e);
    const usage = e.last ?? this.empty(terminalId, null, 'no-data', 'Unknown terminal');
    // 没在 watch 的只读一次，不留状态
    if (!e.watching) this.drop(e);
    return usage;
  }

  async watch(terminalId: TerminalId, owner = 'default'): Promise<TerminalUsage> {
    const e = this.entry(terminalId);
    e.owners.add(owner);
    e.watching = true;
    this.ensurePoller();
    await this.refresh(e);
    return e.last ?? this.empty(terminalId, null, 'no-data', 'Unknown terminal');
  }

  async unwatch(terminalId: TerminalId, owner = 'default'): Promise<void> {
    const e = this.entries.get(terminalId);
    if (!e) return;
    e.owners.delete(owner);
    if (e.owners.size > 0) return;
    e.watching = false;
    this.drop(e);
  }

  // ---- 组装用 ----

  /**
   * 钩子（HookServer 收到的每一条都可以交进来）。USAGE_HOOK 是 pi / omp 扩展报的上下文，返回 true 表示是给用量的，
   * 不用再交给状态机。claude 钩子负载里的 transcript_path 顺便记下。
   */
  noteHook(hook: { terminalId: TerminalId; agent: AgentKind; hookName: string; payload: unknown }): boolean {
    const p = obj(hook.payload);
    if (hook.hookName === USAGE_HOOK) {
      const e = this.entries.get(hook.terminalId);
      if (e && p) {
        e.ext = {
          sessionId: str(p['session_id']),
          tokens: num(p['tokens']),
          window: num(p['contextWindow']),
          percent: num(p['percent']),
          model: str(p['model']),
        };
        this.schedule(e);
      }
      return true;
    }
    const transcript = p && str(p['transcript_path']);
    if (transcript && hook.agent === 'claude') {
      const e = this.entries.get(hook.terminalId);
      if (e && e.transcriptPath !== transcript) {
        e.transcriptPath = transcript;
        this.schedule(e);
      }
    }
    return false;
  }

  /** 会话 id 可能变了（status.changed 带了新 id）：watch 着的马上重读。 */
  noteSession(terminalId: TerminalId): void {
    const e = this.entries.get(terminalId);
    if (e?.watching) this.schedule(e);
  }

  close(): void {
    this.closed = true;
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    for (const e of [...this.entries.values()]) this.drop(e);
  }

  // ---- 内部 ----

  private entry(terminalId: TerminalId): Entry {
    let e = this.entries.get(terminalId);
    if (!e) {
      e = {
        terminalId,
        key: null,
        located: null,
        locatedAt: -Infinity,
        scannedAt: -Infinity,
        parser: null,
        tail: null,
        fsw: null,
        watching: false,
        owners: new Set(),
        transcriptPath: null,
        ext: null,
        lastJson: null,
        last: null,
        busy: Promise.resolve(),
        timer: null,
      };
      this.entries.set(terminalId, e);
    }
    return e;
  }

  private drop(e: Entry): void {
    e.fsw?.close();
    e.fsw = null;
    if (e.timer) clearTimeout(e.timer);
    e.timer = null;
    this.entries.delete(e.terminalId);
    if (![...this.entries.values()].some((x) => x.watching) && this.poller) {
      clearInterval(this.poller);
      this.poller = null;
    }
  }

  private ensurePoller(): void {
    if (this.poller || this.closed) return;
    this.poller = setInterval(() => {
      for (const e of this.entries.values()) if (e.watching) void this.refresh(e);
    }, this.opts.pollMs ?? 1000);
    this.poller.unref?.();
  }

  private schedule(e: Entry): void {
    if (!e.watching || e.timer) return;
    e.timer = setTimeout(() => {
      e.timer = null;
      void this.refresh(e);
    }, this.opts.throttleMs ?? 100);
    e.timer.unref?.();
  }

  /** 同一个终端的刷新排队进行。 */
  private refresh(e: Entry): Promise<void> {
    e.busy = e.busy.then(() => this.doRefresh(e)).catch(() => undefined);
    return e.busy;
  }

  private async doRefresh(e: Entry): Promise<void> {
    const usage = await this.compute(e);
    e.last = usage;
    const json = JSON.stringify(usage);
    if (json === e.lastJson) return;
    e.lastJson = json;
    if (e.watching && !this.closed && this.entries.get(e.terminalId) === e) this.opts.emit({ type: 'usage.changed', usage });
  }

  private reset(e: Entry): void {
    e.fsw?.close();
    e.fsw = null;
    e.located = null;
    e.parser = null;
    e.tail = null;
    e.locatedAt = -Infinity;
  }

  private async compute(e: Entry): Promise<TerminalUsage> {
    const t = this.opts.lookup(e.terminalId);
    if (!t) return this.empty(e.terminalId, null, 'no-data', 'Unknown terminal');
    if (!isUsageAgent(t.agent)) return this.empty(e.terminalId, t.agent, 'unsupported', `Usage is not available for ${t.agent}`);
    const agent = t.agent;
    const key = `${agent}|${t.sessionId ?? ''}|${e.transcriptPath ?? ''}`;
    if (key !== e.key) {
      e.key = key;
      this.reset(e);
    }
    const now = this.now();
    const relocateMs = this.opts.relocateMs ?? 3000;
    // kimi 推断的会话也定期重找（用户可能 /new 开了新会话）
    const due = now - e.locatedAt >= relocateMs;
    if ((!e.located || e.located.match === 'inferred') && due) {
      e.locatedAt = now;
      const found = await this.locate(agent, t, e, now);
      if (found && found.file !== e.located?.file) {
        this.reset(e);
        e.locatedAt = now;
        e.located = found;
      } else if (!found && e.located?.match === 'inferred') {
        this.reset(e);
        e.locatedAt = now;
      }
    }
    if (!e.located) {
      const reason = !t.sessionId && agent !== 'kimi' && !e.transcriptPath ? 'Waiting for the session id' : 'No session file yet';
      return this.empty(e.terminalId, agent, 'no-data', reason, t.sessionId);
    }
    if (agent === 'kimi') await this.loadKimiConfig();
    if (!e.tail || !e.parser) {
      e.parser = this.parserFor(agent);
      e.tail = new JsonlTail(
        e.located.file,
        (line) => e.parser?.feed(line),
        // 文件被截短或替换：从头再算
        () => {
          e.parser = this.parserFor(agent);
        },
      );
      this.watchFile(e);
    }
    await e.tail.poll();
    return this.toUsage(e, agent, t, e.parser.snapshot());
  }

  private async locate(agent: UsageAgent, t: UsageTarget, e: Entry, now: number): Promise<Located | null> {
    const roots = this.opts.roots;
    switch (agent) {
      case 'claude': {
        const scan = now - e.scannedAt >= CLAUDE_SCAN_MS;
        if (scan) e.scannedAt = now;
        return locateClaude(roots.claude, { sessionId: t.sessionId, cwd: t.cwd, transcriptPath: e.transcriptPath, scan });
      }
      case 'codex':
        return locateCodex(roots.codex, t.sessionId);
      case 'pi':
        return locatePi(roots.pi, t.sessionId);
      case 'omp':
        return locatePi(roots.omp, t.sessionId);
      case 'kimi': {
        const peers = (this.opts.targets?.() ?? [])
          .filter((x) => x.agent === 'kimi' && x.terminalId !== t.terminalId && x.cwd === t.cwd && x.startedAt !== null)
          .map((x) => x.startedAt!);
        return locateKimi(roots.kimi, { sessionId: t.sessionId, cwd: t.cwd, startedAt: t.startedAt, peers });
      }
    }
  }

  private parserFor(agent: UsageAgent): UsageParser {
    switch (agent) {
      case 'claude':
        return new ClaudeUsageParser();
      case 'codex':
        return new CodexUsageParser();
      case 'pi':
      case 'omp':
        return new PiUsageParser();
      case 'kimi':
        return new KimiUsageParser((model) => {
          const cfg = this.kimiConfig;
          const m = model ?? cfg?.defaultModel ?? null;
          return m ? (cfg?.windows.get(m) ?? null) : null;
        });
    }
  }

  private async loadKimiConfig(): Promise<void> {
    const file = join(this.opts.roots.kimi, 'config.toml');
    try {
      const st = await stat(file);
      if (this.kimiConfig?.mtime === st.mtimeMs) return;
      const parsed = parseKimiConfig(await readFile(file, 'utf8'));
      this.kimiConfig = { mtime: st.mtimeMs, ...parsed };
    } catch {
      this.kimiConfig = null;
    }
  }

  private watchFile(e: Entry): void {
    if (!e.watching || e.fsw || this.opts.watchFiles === false || !e.located) return;
    try {
      e.fsw = fsWatch(e.located.file, { persistent: false }, () => this.schedule(e));
      e.fsw.on('error', () => {
        e.fsw?.close();
        e.fsw = null;
      });
    } catch {
      e.fsw = null; // 靠轮询
    }
  }

  private toUsage(e: Entry, agent: UsageAgent, t: UsageTarget, p: ParsedUsage): TerminalUsage {
    const located = e.located!;
    let context = p.context;
    let model = p.model;
    // pi / omp：扩展报的上下文（会话 id 对得上时）比从文件里推的准，而且有窗口
    const ext = e.ext;
    if ((agent === 'pi' || agent === 'omp') && ext && (!ext.sessionId || !located.sessionId || ext.sessionId === located.sessionId)) {
      const percent = ext.percent !== null ? Math.round(ext.percent * 10) / 10 : null;
      context = { ...contextOf(ext.tokens, ext.window, 'agent'), ...(percent !== null ? { percent } : {}) };
      model = model ?? ext.model;
    }
    const base = {
      terminalId: e.terminalId,
      agent,
      sessionId: (located.sessionId ?? t.sessionId) as AgentSessionId | null,
      match: located.match,
      file: located.file,
    };
    if (p.requests === 0) {
      return { ...this.empty(e.terminalId, agent, 'no-data', 'No usage recorded yet', base.sessionId), ...base, model, limit: p.limit ?? null };
    }
    return {
      ...base,
      state: 'ok',
      reason: null,
      model,
      total: p.total,
      last: p.last,
      requests: p.requests,
      context,
      rateLimits: p.rateLimits,
      updatedAt: p.updatedAt,
      limit: p.limit ?? null,
    };
  }

  private empty(
    terminalId: TerminalId,
    agent: AgentKind | null,
    state: TerminalUsage['state'],
    reason: string,
    sessionId: AgentSessionId | null = null,
  ): TerminalUsage {
    return {
      terminalId,
      agent,
      state,
      reason,
      sessionId,
      match: null,
      file: null,
      model: null,
      total: null,
      last: null,
      requests: 0,
      context: null,
      rateLimits: null,
      updatedAt: null,
      limit: null,
    };
  }
}
