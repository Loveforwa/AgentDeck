// LimitService 的假实现（插件 Auto-resume · PL4）：内存里的受限账号表，每次变化发 limits.changed（带完整列表）。
// 控制方法：hit（撞上）、reset（到了恢复时间，按先后开始续）、finish（续跑这一轮做完）、hitAgain，
// 以及 playHitWaitResume / playCancel 回放“撞上 → 等 → 续上”和“取消”。不真的等时间，也不发按键。

import type {
  AbsPath,
  AccountKey,
  AccountLimit,
  AgentKind,
  IsoTime,
  LimitedTerminal,
  LimitedTerminalState,
  LimitOwner,
  LimitScope,
  LimitService,
  TerminalId,
  UsageLimit,
} from '@agentdeck/contracts';
import { FakeEventBus } from './bus.ts';
import { clone, fail, nowIso } from './util.ts';

export interface FakeLimitHit {
  agent: AgentKind;
  configDir: AbsPath;
  scope?: LimitScope;
  kind?: UsageLimit['kind'];
  resetsAt: IsoTime | null;
  detail?: string | null;
  /** 按被打断的先后。state 默认 interrupted，owner 默认 auto-resume。 */
  terminals: { terminalId: TerminalId; state?: LimitedTerminalState; owner?: LimitOwner; lostSubagents?: number }[];
}

/** 续跑间隔（毫秒），同主进程的默认 30 秒。只用来算 resumeAt。 */
const STAGGER_MS = 30_000;

/** 还在等着续的状态。 */
const WAITING: readonly LimitedTerminalState[] = ['interrupted', 'idle'];
/** 已经了结的状态：一个账号的终端都了结了就不再列出。 */
const SETTLED: readonly LimitedTerminalState[] = ['took-over', 'resumed', 'skipped', 'handed-off'];

export class FakeLimitService implements LimitService {
  readonly bus: FakeEventBus;
  private readonly accounts = new Map<AccountKey, AccountLimit>();
  /** setOwner 带的提示词，测试断言用。 */
  readonly prompts = new Map<TerminalId, string>();
  /** reset / resumeNow 时“发了续跑”的终端，按先后。 */
  readonly resumed: TerminalId[] = [];
  /** 每个终端续了又撞的次数。 */
  private readonly again = new Map<TerminalId, number>();

  constructor(opts: { bus?: FakeEventBus } = {}) {
    this.bus = opts.bus ?? new FakeEventBus();
  }

  async list(): Promise<AccountLimit[]> {
    return clone([...this.accounts.values()]);
  }

  async resumeNow(account: AccountKey, terminalIds?: TerminalId[]): Promise<void> {
    this.start(this.require(account), terminalIds);
  }

  async skip(terminalId: TerminalId): Promise<void> {
    const { account, terminal } = this.find(terminalId);
    terminal.state = 'skipped';
    terminal.resumeAt = null;
    this.changed(account);
  }

  async cancel(account: AccountKey): Promise<void> {
    const a = this.require(account);
    for (const t of a.terminals) {
      if (!SETTLED.includes(t.state)) {
        t.state = 'skipped';
        t.resumeAt = null;
      }
    }
    this.changed(a);
  }

  async setOwner(terminalId: TerminalId, owner: LimitOwner, prompt?: string): Promise<void> {
    const { account, terminal } = this.find(terminalId);
    terminal.owner = owner;
    if (owner === 'run' || owner === 'agent') terminal.resumeAt = null;
    if (prompt !== undefined) this.prompts.set(terminalId, prompt);
    this.changed(account);
  }

  // ---- 假实现专用 ----

  static keyOf(agent: AgentKind, configDir: AbsPath, scope: LimitScope = 'all'): AccountKey {
    return `${agent}:${configDir}:${scope}`;
  }

  /** 撞上：建账号（已有就把终端加进去），算好每个终端几点续。返回账号键。 */
  hit(init: FakeLimitHit): AccountKey {
    const scope = init.scope ?? 'all';
    const key = FakeLimitService.keyOf(init.agent, init.configDir, scope);
    const a: AccountLimit = this.accounts.get(key) ?? {
      key,
      agent: init.agent,
      configDir: init.configDir,
      scope,
      kind: init.kind ?? 'five_hour',
      resetsAt: init.resetsAt,
      at: nowIso(),
      detail: init.detail ?? null,
      terminals: [],
      needsYou: init.resetsAt === null ? 'reset-unknown' : null,
    };
    for (const t of init.terminals) {
      a.terminals = a.terminals.filter((x) => x.terminalId !== t.terminalId);
      a.terminals.push({
        terminalId: t.terminalId,
        state: t.state ?? 'interrupted',
        owner: t.owner ?? 'auto-resume',
        resumeAt: null,
        lostSubagents: t.lostSubagents ?? 0,
      });
    }
    this.schedule(a);
    this.accounts.set(key, a);
    this.changed(a);
    return key;
  }

  /** 到了恢复时间：owner 为 auto-resume 的按先后开始续（crew 的等调度器调 resumeNow，agent 的自己续）。 */
  reset(account: AccountKey): void {
    const a = this.require(account);
    this.start(a, a.terminals.filter((t) => t.owner === 'auto-resume').map((t) => t.terminalId));
  }

  /** 续跑这一轮做完（agent 回到空闲）。 */
  finish(terminalId: TerminalId): void {
    const { account, terminal } = this.find(terminalId);
    if (terminal.state !== 'resuming') fail('invalid-argument', `Terminal ${terminalId} is not resuming`);
    terminal.state = 'resumed';
    terminal.lostSubagents = 0;
    this.changed(account);
  }

  /** 续了又撞：第一次回到 interrupted 等下一次，第二次 gave-up。 */
  hitAgain(terminalId: TerminalId): void {
    const { account, terminal } = this.find(terminalId);
    const n = (this.again.get(terminalId) ?? 0) + 1;
    this.again.set(terminalId, n);
    terminal.state = n >= 2 ? 'gave-up' : 'interrupted';
    terminal.resumeAt = null;
    this.changed(account);
  }

  /** 回放：两个终端撞上（第三个同账号、当时空闲）→ 等 → 到点按先后续上 → 都做完，账号从列表里消失。 */
  playHitWaitResume(terminals: TerminalId[], opts: { agent?: AgentKind; configDir?: AbsPath; resetsAt?: IsoTime } = {}): AccountKey {
    const [first, second, idle] = terminals;
    if (first === undefined) fail('invalid-argument', 'Need at least one terminal');
    const key = this.hit({
      agent: opts.agent ?? 'codex',
      configDir: opts.configDir ?? '/Users/you/.codex',
      resetsAt: opts.resetsAt ?? new Date(Date.now() + 60 * 60_000).toISOString(),
      terminals: [
        { terminalId: first },
        ...(second ? [{ terminalId: second }] : []),
        ...(idle ? [{ terminalId: idle, state: 'idle' as const }] : []),
      ],
    });
    this.reset(key);
    for (const id of [first, second, idle]) if (id !== undefined) this.finish(id);
    return key;
  }

  /** 回放：撞上 → Don’t resume，账号的终端都变 skipped，账号从列表里消失。 */
  async playCancel(terminals: TerminalId[], opts: { agent?: AgentKind; configDir?: AbsPath } = {}): Promise<AccountKey> {
    const key = this.hit({
      agent: opts.agent ?? 'codex',
      configDir: opts.configDir ?? '/Users/you/.codex',
      resetsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      terminals: terminals.map((terminalId) => ({ terminalId })),
    });
    await this.cancel(key);
    return key;
  }

  private start(a: AccountLimit, terminalIds?: TerminalId[]): void {
    const chosen = a.terminals.filter(
      (t) =>
        WAITING.includes(t.state) &&
        (terminalIds ? terminalIds.includes(t.terminalId) : t.owner === 'auto-resume' || t.owner === 'crew'),
    );
    for (const t of chosen) {
      // 当时空闲的不发续跑提示，只是放开排着的提示词（PL3）；之后照样 finish
      if (t.state === 'interrupted') this.resumed.push(t.terminalId);
      t.state = 'resuming';
    }
    a.needsYou = null;
    this.changed(a);
  }

  private schedule(a: AccountLimit): void {
    const base = a.resetsAt === null ? null : Date.parse(a.resetsAt) + 60_000;
    let i = 0;
    for (const t of a.terminals) {
      if (base === null || t.owner !== 'auto-resume' || !WAITING.includes(t.state)) {
        t.resumeAt = null;
        continue;
      }
      t.resumeAt = new Date(base + i * STAGGER_MS).toISOString();
      i += 1;
    }
  }

  private changed(a: AccountLimit): void {
    if (a.terminals.every((t) => SETTLED.includes(t.state))) this.accounts.delete(a.key);
    this.bus.emit({ type: 'limits.changed', limits: clone([...this.accounts.values()]) });
  }

  private require(key: AccountKey): AccountLimit {
    const a = this.accounts.get(key);
    if (!a) fail('not-found', 'No usage limit for this account');
    return a;
  }

  private find(terminalId: TerminalId): { account: AccountLimit; terminal: LimitedTerminal } {
    for (const account of this.accounts.values()) {
      const terminal = account.terminals.find((t) => t.terminalId === terminalId);
      if (terminal) return { account, terminal };
    }
    fail('not-found', 'Terminal is not paused by a usage limit');
  }
}
