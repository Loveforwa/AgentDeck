// LimitService（插件 Auto-resume，M7 · PL5）：认出被额度打断的终端、按账号归组、恢复后错开续跑。主进程里只有这一份，
// Auto-resume、Prompt queue（PL3）和集群（CR8）共用。需求见设计画布“MVP 插件”页 PluginResume，调研 DR-63、DR-84。
//
//   钩子（noteHook）：claude StopFailure error "rate_limit" → 这一轮是被额度结束的；Notification quota_auto_resume_* → claude 自己续跑的进展；
//                     UserPromptSubmit（不是 claude 自己插的）→ 你接手了；SubagentStart → 续跑那一轮重派了子 agent
//   用量（noteUsage，usage.changed）：TerminalUsage.limit → 恢复时间、哪种额度、范围（codex 只能靠它认出撞上）
//   状态（noteStatus，status.changed）：续跑这一轮在跑 / 做完；claude 自己开始续了
//   输入（noteInput，terminal.input）：撞完以后你打过字 → took-over（自己发的按键不算）
//   时钟（tick，5 秒一次，另按下一件事的时间叫醒）：恢复时间 + 1 分钟按被打断的先后、隔 30 秒发续跑提示；Mac 睡过头先问你
//   → limits.changed（完整列表）；setKeepAwake；sendKeys（bracketed paste + Enter，同 PL3）
//
// Auto-resume 默认关（2026-10-28 用户定）：开关没开的终端照样列出来（账号受限是事实，PL3、收件箱、CR8 要用），
// 但不发任何按键、不阻止睡眠；到了恢复时间，被打断的变 skipped（这次不续）。你点 Resume now（resumeNow）不看开关。
// 状态只在内存里：重开应用后从会话记录重新认（usage.get），恢复时间已经过了 30 分钟以上的先问你。

import { AgentDeckError } from '@agentdeck/contracts';
import type {
  AbsPath,
  AccountKey,
  AccountLimit,
  AccountLimitNeedsYou,
  AgentHookEvent,
  AgentKind,
  BackgroundAgent,
  BoardState,
  LimitedTerminal,
  LimitedTerminalState,
  LimitEvent,
  LimitOwner,
  LimitScope,
  LimitService,
  StatusSnapshot,
  SubagentService,
  TerminalId,
  TerminalStatus,
  TerminalUsage,
  UsageLimit,
  UsageService,
} from '@agentdeck/contracts';
import { isClaudeSyntheticPrompt } from '../subagents/claude.ts';
import {
  accountKey,
  effectiveAutoResume,
  hasQueuedPrompts,
  IGNORE_RESET_OLDER_THAN_MS,
  isLimitAgent,
  KEEP_AWAKE_WITHIN_MS,
  limitScopeOf,
  lostSubagents,
  MAX_REHITS,
  pasteKeys,
  REHIT_WINDOW_MS,
  RESET_UNKNOWN_AFTER_MS,
  RESUME_GRACE_MS,
  RESUME_STAGGER_MS,
  resumePromptText,
  scopeMatches,
  SELF_RESUME_FALLBACK_MS,
  SELF_RESUME_MAX_WAIT_MS,
  SLEPT_AFTER_MS,
  WATCH_GAP_MS,
} from './rules.ts';

/** 组装方告诉服务的一个终端。 */
export interface LimitTarget {
  terminalId: TerminalId;
  agent: AgentKind;
  /** 账号的配置目录（limitConfigDir）；认不出额度的 agent 为 null。 */
  configDir: AbsPath | null;
  /** claude 会不会在额度恢复后自己续（claudeSelfResumes(版本)）。别的 agent 为 false。 */
  selfResumes: boolean;
}

export interface LimitServiceOptions {
  emit: (event: LimitEvent) => void;
  /** 一个终端的 agent、账号目录。不认识的为 null。 */
  lookup: (terminalId: TerminalId) => LimitTarget | null;
  /** 所有终端（标“同一账号、当时空闲”的那些）。 */
  targets: () => LimitTarget[];
  /** tmux send-keys（apps/desktop 注入）。 */
  sendKeys: (terminalId: TerminalId, keys: string[]) => Promise<void>;
  /** 有终端在等恢复（离恢复 12 小时以内）时 true。不给就不管。 */
  setKeepAwake?: (on: boolean) => void;
  /** 读会话记录里的额度上限：codex 一直 watch，claude 撞上后 watch，第一次见到时 get 一次。 */
  usage: Pick<UsageService, 'get' | 'watch' | 'unwatch'>;
  /** 跟着额度断掉的 claude 后台子 agent（N10）。不给就不点名。 */
  subagents?: Pick<SubagentService, 'list'>;
  /** 白板（Auto-resume 开关、Prompt queue 排着的）。不给时开关都算关。 */
  board?: () => Promise<BoardState>;
  /** Settings › Agents › Resume prompt。 */
  resumePrompt?: () => string | null | undefined;
  /** 续跑间隔，默认 30 秒（AGENTDECK_RESUME_STAGGER_MS）。 */
  staggerMs?: number;
  /** 恢复时间后再等多久，默认 1 分钟（AGENTDECK_LIMIT_GRACE_MS）。 */
  graceMs?: number;
  /** 多久检查一次，默认 5 秒。 */
  tickMs?: number;
  /** 粘贴和回车之间等多久，默认 250 毫秒（同 PL3）。 */
  pasteDelayMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

/** 还在等着续的状态。 */
const WAITING: readonly LimitedTerminalState[] = ['interrupted', 'idle'];
/** 了结了的状态：一个账号的终端都了结了就不再列出（同 FakeLimitService）。 */
const SETTLED: readonly LimitedTerminalState[] = ['took-over', 'resumed', 'skipped', 'handed-off'];
/** 自己发的按键之后这么久里的 terminal.input、UserPromptSubmit 不算你接手。 */
const SELF_INPUT_MS = 3_000;
/** 发不出去（tmux 出错）最多重试几次。 */
const MAX_SEND_FAILURES = 3;
/** idle 的终端排在被打断的后面。 */
const IDLE_ORDER = 1e15;

interface Term {
  id: TerminalId;
  agent: AgentKind;
  state: LimitedTerminalState;
  owner: LimitOwner;
  /** owner 是 setOwner 定的，或者运行中改的（disabled、3 分钟兜底、fired），不再按默认算。 */
  ownerFixed: boolean;
  /** setOwner 带的提示词。 */
  prompt: string | null;
  /** 排序：被打断的按撞上的时间，idle 的在后面。 */
  order: number;
  /** 这个终端自己撞上的时间（idle 的为 null）。 */
  hitAt: number | null;
  /** 见过的最近一次撞上（去重）。 */
  lastHitAt: number;
  /** 连续续了又撞的次数。 */
  rehits: number;
  /** 定好的发送时间（这一轮开始续以后）。 */
  slot: number | null;
  /** 发续跑（或 claude 自己开始续）的时间。 */
  sentAt: number | null;
  /** 续跑之后看到它离开过空闲。 */
  sawWork: boolean;
  resumedAt: number | null;
  /** 下一次发的是续跑提示还是只按回车（claude stale 时你点 Continue）。 */
  sendEnter: boolean;
  /** claude 的 quota_auto_resume_*。 */
  fired: boolean;
  stale: boolean;
  /** 续跑以后见到的 SubagentStart 次数。 */
  subagentStarts: number;
  /** claude 自己续完后补发过子 agent 那一段。 */
  followUpSent: boolean;
  lost: BackgroundAgent[];
  failures: number;
  checking: boolean;
}

interface Account {
  key: AccountKey;
  agent: AgentKind;
  configDir: AbsPath;
  scope: LimitScope;
  kind: UsageLimit['kind'];
  resetsAt: number | null;
  /** 恢复时间是从哪一条记录（的时间）来的：更早的记录不覆盖。 */
  resetFrom: number;
  /** 第一次撞上。 */
  at: number;
  /** 最近一次撞上。 */
  latestAt: number;
  detail: string | null;
  needsYou: AccountLimitNeedsYou | null;
  /** 这一次的恢复已经看过（判断过睡没睡过头）。 */
  sawReset: boolean;
  /** 从什么时候起一直看着：恢复时就在看是恢复时间，否则是醒来后第一次看的时间（claude 3 分钟兜底从这里算）。 */
  watchedFrom: number | null;
  /** 这一次的续跑开始了（定了每个终端的发送时间）。 */
  runStarted: boolean;
  lastSlot: number | null;
  terms: Term[];
}

interface Hit {
  at: number;
  resetsAt: number | null;
  kind: UsageLimit['kind'] | null;
  detail: string | null;
  scope: LimitScope;
}

export class LimitServiceImpl implements LimitService {
  private readonly accounts = new Map<AccountKey, Account>();
  private readonly status = new Map<TerminalId, TerminalStatus>();
  private readonly models = new Map<TerminalId, string>();
  /** 见过的终端（第一次见到时读一次会话记录）。 */
  private readonly seen = new Set<TerminalId>();
  /** 正在 watch 用量的终端。 */
  private readonly watching = new Set<TerminalId>();
  /** setOwner 先说好的（集群在撞上之前就登记）。 */
  private readonly prefs = new Map<TerminalId, { owner: LimitOwner; prompt: string | null }>();
  /** 自己发按键的时间窗：这之前的输入不算你。 */
  private readonly selfInputUntil = new Map<TerminalId, number>();
  /** at 为 null 的 limit 第一次见到的时间（同一条不算新撞上）。 */
  private readonly nullAt = new Map<TerminalId, { sig: string; at: number }>();
  private board: BoardState | null = null;
  private lastTick: number;
  private awake = false;
  private lastJson = '[]';
  private ticking: Promise<void> | null = null;
  private again = false;
  private interval: ReturnType<typeof setInterval> | null = null;
  private wake: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private readonly staggerMs: number;
  private readonly graceMs: number;
  private readonly tickMs: number;

  constructor(private readonly opts: LimitServiceOptions) {
    this.staggerMs = Math.max(0, opts.staggerMs ?? RESUME_STAGGER_MS);
    this.graceMs = Math.max(0, opts.graceMs ?? RESUME_GRACE_MS);
    this.tickMs = Math.max(10, opts.tickMs ?? 5_000);
    this.lastTick = this.now();
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  // ---- LimitService ----

  async list(): Promise<AccountLimit[]> {
    return this.snapshot();
  }

  async resumeNow(account: AccountKey, terminalIds?: TerminalId[]): Promise<void> {
    const a = this.accounts.get(account);
    if (!a) throw new AgentDeckError({ code: 'not-found', message: 'No usage limit for this account' });
    const now = this.now();
    // 睡过头、claude 在等回车时 Resume all 也包括 claude 自己会续的
    const asksYou = a.needsYou === 'slept' || a.needsYou === 'stale';
    const all = terminalIds === undefined;
    const chosen = this.ordered(a).filter(
      (t) =>
        WAITING.includes(t.state) &&
        (all ? t.state === 'idle' || t.owner === 'auto-resume' || t.owner === 'crew' || (asksYou && t.owner === 'agent') : terminalIds.includes(t.id)),
    );
    if (all || a.needsYou === 'slept' || a.needsYou === 'reset-unknown') a.needsYou = null;
    if (a.needsYou === 'stale' && chosen.some((t) => t.stale)) a.needsYou = null;
    if (all) {
      // 整组现在续：不再等恢复时间
      a.runStarted = true;
      a.sawReset = true;
      a.watchedFrom ??= now;
    }
    for (const t of chosen) {
      if (t.state === 'idle' && !hasQueuedPrompts(this.board, t.id)) {
        t.state = 'resumed';
        t.resumedAt = now;
        continue;
      }
      if (t.state === 'interrupted' && t.owner === 'agent') {
        // claude 卡在等回车：替你按回车，它接着续自己的；没卡着时发续跑提示（它在等的时候收到消息会改发这一条）
        t.sendEnter = t.stale;
        if (!t.stale) t.owner = 'auto-resume';
        t.ownerFixed = true;
      }
      t.slot = this.nextSlot(a, now);
    }
    this.changed();
    await this.tick();
  }

  async skip(terminalId: TerminalId): Promise<void> {
    const found = this.find(terminalId);
    if (!found) throw new AgentDeckError({ code: 'not-found', message: 'Terminal is not paused by a usage limit' });
    found.t.state = 'skipped';
    found.t.slot = null;
    this.changed();
  }

  async cancel(account: AccountKey): Promise<void> {
    const a = this.accounts.get(account);
    if (!a) throw new AgentDeckError({ code: 'not-found', message: 'No usage limit for this account' });
    for (const t of a.terms) {
      // 已经发出去的那一轮收不回来，照常做完
      if (!SETTLED.includes(t.state) && t.state !== 'resuming') {
        t.state = 'skipped';
        t.slot = null;
      }
    }
    this.changed();
  }

  async setOwner(terminalId: TerminalId, owner: LimitOwner, prompt?: string): Promise<void> {
    const pref = { owner, prompt: prompt ?? this.prefs.get(terminalId)?.prompt ?? null };
    this.prefs.set(terminalId, pref);
    const found = this.find(terminalId);
    if (found) {
      const { a, t } = found;
      t.owner = owner;
      t.ownerFixed = true;
      t.prompt = pref.prompt;
      if (owner !== 'auto-resume') t.slot = null;
      else if (a.runStarted && t.state === 'interrupted' && t.slot === null) t.slot = this.nextSlot(a, this.now());
    }
    this.changed();
  }

  // ---- 组装用 ----

  /** 开始定时检查。 */
  start(): void {
    if (this.interval || this.closed) return;
    this.lastTick = this.now();
    this.interval = setInterval(() => void this.tick(), this.tickMs);
    this.interval.unref?.();
    void this.tick();
  }

  close(): void {
    this.closed = true;
    if (this.interval) clearInterval(this.interval);
    if (this.wake) clearTimeout(this.wake);
    this.interval = null;
    this.wake = null;
    for (const id of this.watching) void this.opts.usage.unwatch(id, 'limits').catch(() => undefined);
    this.watching.clear();
    if (this.awake) this.opts.setKeepAwake?.(false);
    this.awake = false;
  }

  /** HookServer 收到的每一条（runtime 的 tapHook）。从不吃掉钩子。 */
  noteHook(hook: { terminalId: TerminalId; agent: AgentKind; hookName: string; payload: unknown; event: AgentHookEvent | null }): void {
    if (this.closed) return;
    const id = hook.terminalId;
    const ev = hook.event;
    if (ev?.type === 'turn-end' && ev.error === 'rate_limit') {
      this.hookHit(id);
    } else if (ev?.type === 'quota-resume') {
      this.quotaResume(id, ev.what);
    } else if (hook.hookName === 'UserPromptSubmit') {
      const p = hook.payload as { prompt?: unknown } | null;
      const prompt = typeof p?.prompt === 'string' ? p.prompt : '';
      if (!(hook.agent === 'claude' && isClaudeSyntheticPrompt(prompt))) this.promptSubmitted(id);
    } else if (hook.hookName === 'SubagentStart') {
      const t = this.find(id)?.t;
      if (t?.state === 'resuming') t.subagentStarts += 1;
    }
    this.changed();
  }

  /** usage.changed（watch 着的终端）。 */
  noteUsage(usage: TerminalUsage): void {
    if (this.closed) return;
    if (usage.model) this.models.set(usage.terminalId, usage.model);
    const hit = usage.limit ? this.hitFromLimit(usage.terminalId, usage.limit) : null;
    if (hit) this.hit(usage.terminalId, hit);
    this.changed();
  }

  /** status.changed。 */
  noteStatus(snap: StatusSnapshot): void {
    if (this.closed) return;
    const id = snap.terminalId;
    this.status.set(id, snap.status);
    if (!this.seen.has(id)) {
      this.seen.add(id);
      const target = this.opts.lookup(id);
      if (target && isLimitAgent(target.agent) && target.configDir) {
        // codex 撞额度没有钩子，只能一直看会话记录；claude 有 StopFailure，先读一次（重开应用时上次停在额度上的），撞上后再看
        if (target.agent === 'codex') this.watch(id);
        else void this.checkUsage(id);
      }
    }
    if (snap.status === 'exited' || snap.status === 'error') {
      this.noteTerminalGone(id);
      return;
    }
    const found = this.find(id);
    if (found) {
      const { a, t } = found;
      const busy = snap.status !== 'idle';
      if (t.state === 'resuming') {
        if (busy) t.sawWork = true;
        else if (t.sawWork) void this.roundEnded(t);
      } else if (t.state === 'interrupted' && t.owner === 'agent' && busy && a.resetsAt !== null && this.now() >= a.resetsAt) {
        // claude 自己开始续了（fired 没来也算）
        this.selfStarted(a, t);
      }
    }
    this.changed();
  }

  /** terminal.input（write / sendKeys，聚焦、鼠标不算）。 */
  noteInput(terminalId: TerminalId): void {
    if (this.closed || this.isSelfInput(terminalId)) return;
    const t = this.find(terminalId)?.t;
    if (t && (WAITING.includes(t.state) || t.state === 'gave-up')) this.tookOver(t);
    this.changed();
  }

  /** 终端没了。 */
  noteTerminalGone(terminalId: TerminalId): void {
    const found = this.find(terminalId);
    if (found) found.a.terms = found.a.terms.filter((t) => t !== found.t);
    this.unwatch(terminalId);
    this.status.delete(terminalId);
    this.models.delete(terminalId);
    this.seen.delete(terminalId);
    this.nullAt.delete(terminalId);
    this.selfInputUntil.delete(terminalId);
    this.changed();
  }

  /** 检查一次（定时器调；测试里直接调）。正在检查时等它做完再来一次。 */
  tick(): Promise<void> {
    if (this.ticking) {
      this.again = true;
      return this.ticking;
    }
    this.ticking = (async () => {
      do {
        this.again = false;
        await this.runTick();
      } while (this.again && !this.closed);
    })().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  // ---- 认出撞上 ----

  private hookHit(id: TerminalId): void {
    const found = this.find(id);
    const keep = found && WAITING.includes(found.t.state);
    this.hit(id, { at: this.now(), resetsAt: null, kind: null, detail: null, scope: keep ? found.a.scope : 'all' });
    // 恢复时间、范围在会话记录里
    void this.checkUsage(id);
  }

  private async checkUsage(id: TerminalId): Promise<void> {
    const u = await this.opts.usage.get(id).catch(() => null);
    if (this.closed || !u) return;
    if (u.model) this.models.set(id, u.model);
    const hit = u.limit ? this.hitFromLimit(id, u.limit) : null;
    if (hit) this.hit(id, hit);
    this.changed();
  }

  private hitFromLimit(id: TerminalId, limit: UsageLimit): Hit | null {
    let at = limit.at ? Date.parse(limit.at) : NaN;
    if (Number.isNaN(at)) {
      // 没写时间：同一条记成第一次见到的时间，不当成新撞上
      const sig = JSON.stringify(limit);
      const prev = this.nullAt.get(id);
      at = prev?.sig === sig ? prev.at : this.now();
      this.nullAt.set(id, { sig, at });
    }
    const resets = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN;
    return { at, resetsAt: Number.isNaN(resets) ? null : resets, kind: limit.kind, detail: limit.detail, scope: limitScopeOf(limit) };
  }

  private hit(id: TerminalId, h: Hit): void {
    const target = this.opts.lookup(id);
    if (!target?.configDir || !isLimitAgent(target.agent)) return;
    const now = this.now();
    // 很久以前的记录（重开应用时读到的）不管
    if (h.resetsAt !== null && h.resetsAt < now - IGNORE_RESET_OLDER_THAN_MS) return;
    const key = accountKey(target.agent, target.configDir, h.scope);
    let found = this.find(id);
    if (found && h.at <= found.t.lastHitAt) {
      // 已经知道的这一次（钩子先到，会话记录后读到）：补上恢复时间；范围不一样就挪到对的账号
      const moved = found.a.key !== key && WAITING.includes(found.t.state);
      if (moved) found = { a: this.moveTo(found.a, found.t, key, target, h), t: found.t };
      this.mergeLimit(found.a, h);
      if (moved) this.markIdle(found.a);
      return;
    }
    let a: Account;
    let t: Term;
    if (found) {
      ({ a, t } = found);
      const rehit = t.state === 'resuming' || (t.state === 'resumed' && t.resumedAt !== null && now - t.resumedAt <= REHIT_WINDOW_MS);
      if (a.key !== key) a = this.moveTo(a, t, key, target, h);
      if (rehit) {
        t.rehits += 1;
        this.resetCycle(t);
        t.order = h.at;
        t.hitAt = h.at;
        t.state = t.rehits >= MAX_REHITS ? 'gave-up' : 'interrupted';
      } else if (WAITING.includes(t.state)) {
        if (t.state === 'idle') t.order = h.at;
        t.hitAt ??= h.at;
        t.state = 'interrupted';
      } else {
        // 了结以后又是新的一次（你又让它干活了）
        this.resetCycle(t);
        t.rehits = 0;
        t.order = h.at;
        t.hitAt = h.at;
        t.state = 'interrupted';
      }
    } else {
      a = this.account(key, target, h);
      t = this.newTerm(id, target.agent, 'interrupted', h.at);
      t.hitAt = h.at;
      a.terms.push(t);
    }
    t.lastHitAt = Math.max(t.lastHitAt, h.at);
    this.mergeLimit(a, h);
    this.markIdle(a);
    if (target.agent === 'claude') this.watch(id);
    void this.tick();
  }

  /** 把恢复时间、哪种额度并进账号。新的恢复时间（续了又撞、每周额度）是新的一次等待。 */
  private mergeLimit(a: Account, h: Hit): void {
    const now = this.now();
    if (h.at >= a.latestAt) {
      a.latestAt = h.at;
      if (h.kind) a.kind = h.kind;
      if (h.detail) a.detail = h.detail;
    } else if (h.at >= a.resetFrom) {
      // 钩子先到（只知道撞上了），会话记录里的那一条稍早一点：哪种额度、原话以它为准
      if (h.kind) a.kind = h.kind;
      if (h.detail) a.detail = h.detail;
    }
    if (h.resetsAt !== null) {
      if (h.at >= a.resetFrom && h.resetsAt !== a.resetsAt) {
        this.newWindow(a, h.resetsAt);
        a.resetFrom = h.at;
      }
    } else if (a.resetsAt !== null && a.resetsAt <= now && h.at > a.resetFrom) {
      // 恢复以后又撞（钩子先到，还不知道下一次几点恢复）
      this.newWindow(a, null);
    }
  }

  private newWindow(a: Account, resetsAt: number | null): void {
    a.resetsAt = resetsAt;
    a.sawReset = false;
    a.watchedFrom = null;
    a.runStarted = false;
    a.lastSlot = null;
    if (a.needsYou === 'slept' || a.needsYou === 'reset-unknown') a.needsYou = null;
    for (const t of a.terms) if (WAITING.includes(t.state)) t.slot = null;
  }

  private resetCycle(t: Term): void {
    t.slot = null;
    t.sentAt = null;
    t.sawWork = false;
    t.resumedAt = null;
    t.sendEnter = false;
    t.fired = false;
    t.stale = false;
    t.subagentStarts = 0;
    t.followUpSent = false;
    t.failures = 0;
  }

  /** 同一账号的别的终端：当时空闲、自己没撞（Opus / Sonnet 额度只算用同一家族模型的）。 */
  private markIdle(a: Account): void {
    for (const target of this.opts.targets()) {
      if (target.agent !== a.agent || target.configDir !== a.configDir) continue;
      const st = this.status.get(target.terminalId);
      if (st === undefined || st === 'exited' || st === 'error') continue;
      if (!scopeMatches(a.scope, this.models.get(target.terminalId))) continue;
      const found = this.find(target.terminalId);
      if (found && (found.a === a || !SETTLED.includes(found.t.state))) continue;
      if (found) found.a.terms = found.a.terms.filter((t) => t !== found.t);
      a.terms.push(this.newTerm(target.terminalId, target.agent, 'idle', IDLE_ORDER + this.now() + a.terms.length));
    }
  }

  private moveTo(from: Account, t: Term, key: AccountKey, target: LimitTarget, h: Hit): Account {
    from.terms = from.terms.filter((x) => x !== t);
    // 原来那一组是因为它才建的（钩子先到时按 all 算的）：没有别的被打断的就整组不要
    if (!from.terms.some((x) => x.state === 'interrupted' || x.state === 'resuming' || x.state === 'gave-up')) this.accounts.delete(from.key);
    const a = this.account(key, target, h);
    a.terms.push(t);
    return a;
  }

  private account(key: AccountKey, target: LimitTarget, h: Hit): Account {
    let a = this.accounts.get(key);
    if (!a) {
      a = {
        key,
        agent: target.agent,
        configDir: target.configDir!,
        scope: h.scope,
        kind: h.kind ?? 'five_hour',
        resetsAt: null,
        resetFrom: -Infinity,
        at: h.at,
        latestAt: h.at,
        detail: h.detail,
        needsYou: null,
        sawReset: false,
        watchedFrom: null,
        runStarted: false,
        lastSlot: null,
        terms: [],
      };
      this.accounts.set(key, a);
    }
    return a;
  }

  private newTerm(id: TerminalId, agent: AgentKind, state: LimitedTerminalState, order: number): Term {
    const pref = this.prefs.get(id);
    return {
      id,
      agent,
      state,
      owner: pref?.owner ?? 'auto-resume',
      ownerFixed: pref !== undefined,
      prompt: pref?.prompt ?? null,
      order,
      hitAt: null,
      lastHitAt: -Infinity,
      rehits: 0,
      slot: null,
      sentAt: null,
      sawWork: false,
      resumedAt: null,
      sendEnter: false,
      fired: false,
      stale: false,
      subagentStarts: 0,
      followUpSent: false,
      lost: [],
      failures: 0,
      checking: false,
    };
  }

  // ---- claude 自己续跑、你接手 ----

  private quotaResume(id: TerminalId, what: 'fired' | 'stale' | 'disabled'): void {
    const found = this.find(id);
    if (!found) return;
    const { a, t } = found;
    if (what === 'fired') {
      t.fired = true;
      t.stale = false;
      if (t.state === 'interrupted') this.selfStarted(a, t);
      if (a.needsYou === 'stale' && !a.terms.some((x) => x.stale)) a.needsYou = null;
    } else if (what === 'stale') {
      t.stale = true;
      if (t.state === 'interrupted') a.needsYou = 'stale';
    } else if (t.owner === 'agent') {
      // 用户关了 claude 自己的续跑：AgentDeck 来发（开关开着时）
      t.owner = 'auto-resume';
      t.ownerFixed = true;
      if (a.runStarted && t.state === 'interrupted' && this.autoOn(t.id)) t.slot = this.nextSlot(a, this.now());
    }
  }

  private selfStarted(a: Account, t: Term): void {
    if (t.owner !== 'crew' && t.owner !== 'run') t.owner = 'agent';
    t.ownerFixed = true;
    t.state = 'resuming';
    t.sentAt = this.now();
    t.sawWork = this.status.get(t.id) !== 'idle';
    t.slot = null;
    t.subagentStarts = 0;
    if (a.needsYou === 'stale') a.needsYou = null;
  }

  private promptSubmitted(id: TerminalId): void {
    if (this.isSelfInput(id)) return;
    const found = this.find(id);
    if (!found) return;
    const { a, t } = found;
    if (t.state === 'interrupted' && t.owner === 'agent' && a.resetsAt !== null && this.now() >= a.resetsAt) this.selfStarted(a, t);
    else if (WAITING.includes(t.state)) this.tookOver(t);
  }

  private tookOver(t: Term): void {
    t.state = 'took-over';
    t.slot = null;
  }

  private isSelfInput(id: TerminalId): boolean {
    return this.now() <= (this.selfInputUntil.get(id) ?? -Infinity);
  }

  // ---- 续跑这一轮做完 ----

  private async roundEnded(t: Term): Promise<void> {
    if (t.checking) return;
    t.checking = true;
    try {
      // codex 的 Stop 可能比会话记录先到：看一眼是不是又撞了
      const u = await this.opts.usage.get(t.id).catch(() => null);
      if (t.state !== 'resuming' || this.closed) return;
      const h = u?.limit ? this.hitFromLimit(t.id, u.limit) : null;
      if (h && t.sentAt !== null && h.at > t.sentAt) {
        this.hit(t.id, h);
        return;
      }
      if (t.agent === 'claude' && t.owner === 'agent' && !t.followUpSent && this.autoOn(t.id)) {
        // claude 自己续完了：因额度 failed 的子 agent 还没接回、这一轮也没重派，就补发子 agent 那一段（只发一次）
        await this.refreshSubagents();
        if (t.state !== 'resuming') return;
        if (t.lost.length > 0 && t.subagentStarts === 0) {
          t.followUpSent = true;
          t.sawWork = false;
          this.changed();
          const ok = await this.type(t.id, resumePromptText({ agent: t.agent, lost: t.lost, subagentsOnly: true }));
          if (ok) return;
        }
      }
      t.state = 'resumed';
      t.resumedAt = this.now();
      t.lost = [];
    } finally {
      t.checking = false;
      this.changed();
    }
  }

  // ---- 定时检查 ----

  private async runTick(): Promise<void> {
    if (this.closed) return;
    const now = this.now();
    const prevTick = this.lastTick;
    const gap = now - prevTick;
    this.lastTick = now;
    if (this.accounts.size > 0) {
      await this.refreshBoard();
      await this.refreshSubagents();
    }
    const sends: Promise<unknown>[] = [];
    for (const a of this.accounts.values()) {
      this.refreshOwners(a, now);
      if (a.resetsAt === null) {
        if (!a.needsYou && a.terms.some((t) => t.state === 'interrupted') && now - a.latestAt >= RESET_UNKNOWN_AFTER_MS) a.needsYou = 'reset-unknown';
      } else {
        if (now >= a.resetsAt && !a.sawReset) {
          a.sawReset = true;
          // 恢复前最近一次检查离现在不远：恢复时一直看着。否则（Mac 睡着、应用刚开）从现在算，过了 30 分钟先问你
          const watched = gap <= WATCH_GAP_MS && prevTick < a.resetsAt;
          a.watchedFrom = watched ? a.resetsAt : now;
          if (!watched && now - a.resetsAt >= SLEPT_AFTER_MS) a.needsYou = 'slept';
        }
        const due = a.resetsAt + this.graceMs;
        if (now >= due && !a.runStarted && a.needsYou !== 'slept') this.startRun(a, now);
        if (a.sawReset && a.needsYou !== 'slept') {
          // claude 自己会续：恢复 3 分钟后还没动静才自己发
          for (const t of this.ordered(a)) {
            if (t.owner !== 'agent' || t.state !== 'interrupted' || t.fired || t.stale || !this.autoOn(t.id)) continue;
            if (now >= due && now >= (a.watchedFrom ?? a.resetsAt) + SELF_RESUME_FALLBACK_MS) {
              t.owner = 'auto-resume';
              t.ownerFixed = true;
              t.slot = this.nextSlot(a, now);
            }
          }
        }
      }
      for (const t of this.ordered(a)) if (t.slot !== null && t.slot <= now) sends.push(this.fire(t));
    }
    await Promise.all(sends);
    this.updateKeepAwake();
    this.changed();
    this.scheduleWake();
  }

  /** 恢复时间 + 1 分钟到了：按被打断的先后定好每个终端几点发。 */
  private startRun(a: Account, now: number): void {
    a.runStarted = true;
    for (const t of this.ordered(a)) {
      if (t.slot !== null) continue; // Resume now 已经定好了
      if (t.state === 'interrupted' && t.owner === 'auto-resume') {
        if (this.autoOn(t.id)) t.slot = this.nextSlot(a, now);
        else t.state = 'skipped'; // Auto-resume 关着：这次不续
      } else if (t.state === 'idle') {
        // 当时空闲的不发续跑；排着提示词的留一个位置给 PL3 发第一条
        if (hasQueuedPrompts(this.board, t.id)) t.slot = this.nextSlot(a, now);
        else {
          t.state = 'resumed';
          t.resumedAt = now;
        }
      }
      // agent：claude 自己续（上面的兜底）；crew：等集群调 resumeNow；run：Day run 自己管
    }
  }

  private nextSlot(a: Account, now: number): number {
    const slot = a.lastSlot === null ? now : Math.max(now, a.lastSlot + this.staggerMs);
    a.lastSlot = slot;
    return slot;
  }

  private async fire(t: Term): Promise<void> {
    const now = this.now();
    if (t.state === 'idle') {
      t.state = 'resumed';
      t.resumedAt = now;
      t.slot = null;
      return;
    }
    if (t.state !== 'interrupted') {
      t.slot = null;
      return;
    }
    const st = this.status.get(t.id);
    if (st !== undefined && st !== 'idle') return; // 等它空闲，下次再看
    t.slot = null;
    t.state = 'resuming';
    t.sentAt = now;
    t.sawWork = false;
    t.subagentStarts = 0;
    const enter = t.sendEnter;
    t.sendEnter = false;
    const text = enter
      ? null
      : resumePromptText({ agent: t.agent, template: this.opts.resumePrompt?.() ?? null, override: t.prompt, lost: t.agent === 'claude' ? t.lost : [] });
    this.changed();
    const ok = await this.type(t.id, text);
    if (!ok && t.state === 'resuming') {
      t.failures += 1;
      t.state = t.failures >= MAX_SEND_FAILURES ? 'gave-up' : 'interrupted';
      t.sentAt = null;
      t.sendEnter = enter;
      t.slot = t.state === 'interrupted' ? this.now() + Math.max(this.staggerMs, 1_000) : null;
      this.changed();
    }
  }

  /** 送进终端：bracketed paste 一段再回车（text 为 null 只按回车）。自己发的按键不算你接手。 */
  private async type(id: TerminalId, text: string | null): Promise<boolean> {
    this.selfInputUntil.set(id, Infinity);
    try {
      if (text !== null) {
        await this.opts.sendKeys(id, [pasteKeys(text)]);
        const wait = this.opts.pasteDelayMs ?? 250;
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
      await this.opts.sendKeys(id, ['Enter']);
      return true;
    } catch (e) {
      this.opts.log?.(`resume keys not sent to ${id}: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    } finally {
      this.selfInputUntil.set(id, this.now() + SELF_INPUT_MS);
    }
  }

  /** 没定死的 owner 按默认算：claude 会自己续（2.1.234 起、恢复在 24 小时内）时是 agent，别的是 auto-resume。 */
  private refreshOwners(a: Account, now: number): void {
    for (const t of a.terms) {
      if (t.ownerFixed || !WAITING.includes(t.state)) continue;
      const self = this.opts.lookup(t.id)?.selfResumes === true && (a.resetsAt === null || a.resetsAt - now <= SELF_RESUME_MAX_WAIT_MS);
      const owner: LimitOwner = a.agent === 'claude' && self ? 'agent' : 'auto-resume';
      if (owner !== t.owner) {
        t.owner = owner;
        if (owner !== 'auto-resume') t.slot = null;
      }
    }
  }

  private async refreshBoard(): Promise<void> {
    if (!this.opts.board) return;
    try {
      this.board = await this.opts.board();
    } catch {
      // 读不到白板：用上一次的
    }
  }

  private async refreshSubagents(): Promise<void> {
    const claude = [...this.accounts.values()].flatMap((a) => a.terms).filter((t) => t.agent === 'claude' && t.hitAt !== null);
    if (!this.opts.subagents || claude.length === 0) return;
    const all = await this.opts.subagents.list().catch(() => null);
    if (!all) return;
    for (const t of claude) {
      const agents = all.find((x) => x.terminalId === t.id)?.agents ?? [];
      t.lost = WAITING.includes(t.state) || t.state === 'resuming' ? lostSubagents(agents, t.hitAt!) : [];
    }
  }

  private updateKeepAwake(): void {
    const now = this.now();
    const want = [...this.accounts.values()].some(
      (a) =>
        a.resetsAt !== null &&
        a.needsYou !== 'slept' &&
        a.resetsAt - now <= KEEP_AWAKE_WITHIN_MS &&
        a.terms.some(
          (t) =>
            t.slot !== null ||
            (t.state === 'interrupted' && (t.owner === 'crew' || ((t.owner === 'auto-resume' || t.owner === 'agent') && this.autoOn(t.id)))),
        ),
    );
    if (want !== this.awake) {
      this.awake = want;
      this.opts.setKeepAwake?.(want);
    }
  }

  /** 下一件事（恢复、该发的、兜底）比下一次定时检查早时，到点叫醒。 */
  private scheduleWake(): void {
    if (this.closed || !this.interval) return;
    const now = this.now();
    let next = Infinity;
    for (const a of this.accounts.values()) {
      if (a.resetsAt === null) continue;
      if (!a.sawReset) next = Math.min(next, a.resetsAt);
      if (!a.runStarted) next = Math.min(next, a.resetsAt + this.graceMs);
      for (const t of a.terms) if (t.slot !== null) next = Math.min(next, t.slot);
    }
    if (this.wake) clearTimeout(this.wake);
    this.wake = null;
    if (next === Infinity || next - now >= this.tickMs) return;
    this.wake = setTimeout(() => void this.tick(), Math.max(0, next - now));
    this.wake.unref?.();
  }

  // ---- 小工具 ----

  private autoOn(id: TerminalId): boolean {
    return effectiveAutoResume(this.board, id);
  }

  private find(id: TerminalId): { a: Account; t: Term } | null {
    for (const a of this.accounts.values()) {
      const t = a.terms.find((x) => x.id === id);
      if (t) return { a, t };
    }
    return null;
  }

  private ordered(a: Account): Term[] {
    return [...a.terms].sort((x, y) => x.order - y.order);
  }

  private watch(id: TerminalId): void {
    if (this.watching.has(id)) return;
    this.watching.add(id);
    void this.opts.usage.watch(id, 'limits').catch(() => this.watching.delete(id));
  }

  private unwatch(id: TerminalId): void {
    if (!this.watching.delete(id)) return;
    void this.opts.usage.unwatch(id, 'limits').catch(() => undefined);
  }

  private snapshot(): AccountLimit[] {
    const out: AccountLimit[] = [];
    for (const a of this.accounts.values()) {
      const base = a.resetsAt === null ? null : a.resetsAt + this.graceMs;
      let k = 0;
      const terminals: LimitedTerminal[] = this.ordered(a).map((t) => {
        let resumeAt: number | null = t.slot;
        if (resumeAt === null && !a.runStarted && base !== null && a.needsYou !== 'slept') {
          const eligible =
            (t.state === 'interrupted' && t.owner === 'auto-resume' && this.autoOn(t.id)) || (t.state === 'idle' && hasQueuedPrompts(this.board, t.id));
          if (eligible) resumeAt = base + k++ * this.staggerMs;
        }
        return {
          terminalId: t.id,
          state: t.state,
          owner: t.owner,
          resumeAt: resumeAt === null ? null : new Date(resumeAt).toISOString(),
          lostSubagents: t.lost.length,
        };
      });
      out.push({
        key: a.key,
        agent: a.agent,
        configDir: a.configDir,
        scope: a.scope,
        kind: a.kind,
        resetsAt: a.resetsAt === null ? null : new Date(a.resetsAt).toISOString(),
        at: new Date(a.at).toISOString(),
        detail: a.detail,
        terminals,
        needsYou: a.needsYou,
      });
    }
    return out;
  }

  /**
   * 列表变了就发 limits.changed。了结了的账号先带着最后的状态发一次（书签要写 “you took over”、“Resuming” 收起），
   * 再去掉、再发一次：之后 list() 不再列出它（同 contracts 的约定）。
   */
  private changed(): void {
    if (this.closed) return;
    const now = this.now();
    for (const a of this.accounts.values()) this.refreshOwners(a, now);
    const done = [...this.accounts.values()].filter((a) => a.terms.length === 0 || a.terms.every((t) => SETTLED.includes(t.state)));
    if (done.some((a) => a.terms.length > 0)) this.emitIfChanged();
    for (const a of done) {
      this.accounts.delete(a.key);
      for (const t of a.terms) if (t.agent !== 'codex') this.unwatch(t.id);
    }
    this.emitIfChanged();
  }

  private emitIfChanged(): void {
    const limits = this.snapshot();
    const json = JSON.stringify(limits);
    if (json === this.lastJson) return;
    this.lastJson = json;
    this.opts.emit({ type: 'limits.changed', limits });
  }
}
