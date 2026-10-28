// Prompt queue 插件（PL3，设计画布“MVP 插件”页 PluginQueue，调研 DR-63，规则见 docs/plugins.md）的纯逻辑：
// 什么时候发下一条（decide），书签和卡片上写什么（queueLabel），队列的增删改。不碰 React、不碰服务。
//
// 2026-10-27 用户定：只在碰到额度上限、到点恢复后才发（额度没用完时不自动发，要发就点 Send next now）；
// Keep Mac awake 默认开。
//
// IS-113（2026-10-28，提交前修）：claude 2.1.234 起默认在额度恢复后自己续跑（autoContinueAtUsageLimit），续跑那次请求一成功，
// TerminalUsage.limit 就被清掉。所以碰到上限时记成 armed（PromptQueueSettings.armed：恢复时间和碰到的时间），limit 清掉也不忘，
// 发完第一条才清；发第一条看 armed，不看当下的 limit。claude 自己会续时（SelfResume）：恢复后先等它续的那一轮（离开空闲再回到空闲）
// 做完再发；恢复 3 分钟后还空闲、没开始过才按原规则发；恢复时 AgentDeck 没看着（电脑睡了、应用关着）、醒来已过恢复时间 30 分钟，
// claude 多半在等你按回车（stale），这时不粘贴（粘进去它会发这一条、不再续原来的事），等它自己那一轮跑完。
//
// PL5 之后（contracts 0.1.22）：主进程的 LimitService 认出撞上、按账号归组、管续跑，limits.changed 带着每个终端走到哪一步。
// 列表里有这个终端时按它发（limitGate），上面那套猜测（armed + trackSelfResume）只在 LimitService 没列出它时兜底
// （假实现、老版本、重开应用后 LimitService 还没认出来）：
// - 终端出现在一个账号里就算“碰到上限”，同一账号当时空闲的终端也一样，这次恢复后照发；
// - owner agent + interrupted（claude 自己会续）：不发，书签写 claude resumes <时间>（Auto-resume 关着、恢复 3 分钟后它还没开始才发）；
//   resuming：等；resumed 或从列表里消失：发第一条；
// - 账号 needsYou 是 stale（claude 在等回车）或 slept（Mac 睡过了恢复时间）：从不粘贴；
// - 这个终端开着 Auto-resume（codex 也是）：先等它续完（resumed）再发，免得续跑提示和第一条撞在一起；
// - 当时空闲的终端：到 LimitService 给的 resumeAt 发（它也会在那时把终端标成 resumed）；
// - skipped：你去掉了勾或点了 Don’t resume，队列暂停（Auto-resume 关着、到点被标 skipped 的不算，照常在恢复 + 1 分钟发）。
// 同一次上限（账号 + 恢复时间）只按它发一次第一条，之后照常一轮一条（running）。

import type {
  AccountLimit,
  LimitedTerminal,
  LimitedTerminalState,
  PromptQueueSettings,
  QueuedPrompt,
  TerminalId,
  TerminalStatus,
  TerminalWindowData,
  UsageLimit,
  WindowNode,
} from '@agentdeck/contracts';

/** 先支持这两个：恢复时间读得到（DR-63）。别的 agent 菜单里灰掉。 */
export const QUEUE_AGENTS = ['claude', 'codex'] as const;

/** 恢复时间过了再等这么久才发（毫秒）：恢复的那一刻 agent 那边可能还没放开。 */
export const RESUME_GRACE_MS = 60_000;
/** 发出去以后等它开始干活（状态离开 idle）最多这么久，超过就当它已经做完。 */
export const START_TIMEOUT_MS = 60_000;
/** 已发的最多留这么多条。 */
export const SENT_KEEP = 50;
/** claude 从这个版本起默认在额度恢复后自己续跑（DR-84）。 */
export const SELF_RESUME_SINCE = '2.1.234';
/** claude 自己会续时：恢复后这么久还空闲、没开始过，就按原规则发。 */
export const SELF_RESUME_FALLBACK_MS = 3 * 60_000;
/** 恢复时没看着、醒来时已经过了恢复时间这么久：claude 改成等你按回车（stale）。 */
export const STALE_AFTER_MS = 30 * 60_000;
/** 两次检查隔了这么久算“中间没看着”（平时 5 秒一次；窗口在后台时浏览器最慢一分钟一次）。 */
export const WATCH_GAP_MS = 150_000;

export const DEFAULT_QUEUE: PromptQueueSettings = { on: false, prompts: [], sent: [], paused: false, keepAwake: true, running: false };

export function queueSettings(node: WindowNode | undefined): PromptQueueSettings {
  const q = (node?.data as Partial<TerminalWindowData> | null)?.queue;
  return q ? { ...DEFAULT_QUEUE, ...q } : DEFAULT_QUEUE;
}

export function queueOn(node: WindowNode | undefined): boolean {
  return queueSettings(node).on;
}

export type Armed = NonNullable<PromptQueueSettings['armed']>;

/**
 * 这次要等的上限（IS-113）：已经记下的 armed；当下的 limit 带恢复时间和碰到的时间、比记下的新、也比最后发出去的那条晚，就换成它。
 * limit 变成 null（agent 续跑成功了）不影响已经记下的。发完第一条由 takeFirst 清掉。
 */
export function armedFrom(q: PromptQueueSettings, limit: UsageLimit | null): Armed | null {
  const cur = q.armed ?? null;
  const at = limit?.at ? Date.parse(limit.at) : NaN;
  const resetsAt = limit?.resetsAt ? Date.parse(limit.resetsAt) : NaN;
  if (Number.isNaN(at) || Number.isNaN(resetsAt)) return cur;
  if (cur && at <= cur.at) return cur;
  const lastSent = q.sent.at(-1);
  if (lastSent && at <= Date.parse(lastSent.sentAt)) return cur;
  return { resetsAt, at };
}

/** 这个 agent 会不会在额度恢复后自己续跑：claude 2.1.234 起默认会。版本读不出时当它会（最多晚 3 分钟发，不会盖掉它的续跑）。 */
export function selfResumes(agent: string | null, version: string | null): boolean {
  if (agent !== 'claude') return false;
  const v = version ? /(\d+)\.(\d+)\.(\d+)/.exec(version) : null;
  if (!v) return true;
  const min = SELF_RESUME_SINCE.split('.').map(Number);
  const have = [Number(v[1]), Number(v[2]), Number(v[3])];
  for (let i = 0; i < 3; i += 1) if (have[i] !== min[i]) return have[i]! > min[i]!;
  return true;
}

/** agent 自己续跑时，这一次恢复前后看到的情况（QueueRunner 每次检查时更新，不保存）。 */
export interface SelfResume {
  /** 这一次的恢复时间（armed.resetsAt）。换了 armed 就重新算。 */
  resetsAt: number;
  /** 恢复后看到过 agent 离开空闲：它续的那一轮开始了（或者你自己打了字）。 */
  started: boolean;
  /** 从什么时候起一直看着：恢复时就在看是恢复时间，否则是恢复后第一次看到的时间。过 3 分钟还没动静才按原规则发。恢复前为 null。 */
  watchedFrom: number | null;
  /** 恢复时没看着、醒来已过恢复时间 30 分钟、它也没开始：claude 多半在等回车，不粘贴。 */
  stale: boolean;
}

/** 更新 SelfResume。prevTick 是上一次检查的时间（应用刚起来为 null）。 */
export function trackSelfResume(prev: SelfResume | null, armed: Armed | null, status: TerminalStatus | null, now: number, prevTick: number | null): SelfResume | null {
  if (!armed) return null;
  const s: SelfResume = prev && prev.resetsAt === armed.resetsAt ? { ...prev } : { resetsAt: armed.resetsAt, started: false, watchedFrom: null, stale: false };
  if (now < armed.resetsAt) return s;
  const watching = prevTick !== null && now - prevTick <= WATCH_GAP_MS;
  if (s.watchedFrom === null || !watching) {
    // 恢复后第一次看，或者中间断过（电脑睡了、应用关着）
    const sawReset = watching && s.watchedFrom === null && prevTick! < armed.resetsAt;
    s.watchedFrom = sawReset ? armed.resetsAt : now;
    if (!sawReset && !s.started && now - armed.resetsAt >= STALE_AFTER_MS) s.stale = true;
  }
  if (status === 'running' || status === 'needs-approval' || status === 'needs-reply') s.started = true;
  return s;
}

/** 碰到上限后什么时候可以发（恢复时间 + 1 分钟）。读不到恢复时间为 null。 */
export function dueAt(limit: UsageLimit | null): number | null {
  if (!limit?.resetsAt) return null;
  const t = Date.parse(limit.resetsAt);
  return Number.isNaN(t) ? null : t + RESUME_GRACE_MS;
}

// ---- LimitService 那边（PL5，contracts 0.1.22） ----

/** LimitService 列出的这个终端和它所在的账号。 */
export interface LimitView {
  account: AccountLimit;
  terminal: LimitedTerminal;
}

/** limits.changed 的列表里找这个终端。 */
export function limitViewOf(limits: readonly AccountLimit[], terminalId: TerminalId): LimitView | null {
  for (const account of limits) {
    const terminal = account.terminals.find((t) => t.terminalId === terminalId);
    if (terminal) return { account, terminal };
  }
  return null;
}

/** 这一次上限的键：账号 + 恢复时间。同一次只按它发一次第一条；续了又撞（恢复时间变了）是新的一次。 */
export function limitCycle(v: LimitView): string {
  return `${v.account.key}|${v.account.resetsAt ?? 'unknown'}`;
}

/** LimitService 记下的这次上限，也存成 armed（重开应用、LimitService 不在时兜底）。规则同 armedFrom：比记下的新、比最后发出去的晚。 */
export function armedFromLimit(q: PromptQueueSettings, v: LimitView): Armed | null {
  const cur = q.armed ?? null;
  const at = Date.parse(v.account.at);
  const resetsAt = v.account.resetsAt ? Date.parse(v.account.resetsAt) : NaN;
  if (Number.isNaN(at) || Number.isNaN(resetsAt)) return cur;
  if (cur && at <= cur.at && resetsAt === cur.resetsAt) return cur;
  const lastSent = q.sent.at(-1);
  if (lastSent && at <= Date.parse(lastSent.sentAt)) return cur;
  return { resetsAt, at };
}

/** 为什么还不发（书签的写法跟着它）。 */
export type LimitWait =
  /** claude 自己会续，还没到 / 还没动静。 */
  | 'self-resume'
  /** claude 卡在等你按回车（stale）。 */
  | 'self-stale'
  /** Mac 睡过了恢复时间（slept），等你在收件箱里点。 */
  | 'slept'
  /** 续跑这一轮在跑（不管是 claude 自己还是 Auto-resume）。 */
  | 'resuming'
  /** 开着 Auto-resume：等它先续完。 */
  | 'auto-resume'
  /** 集群或 Day run 管续跑。 */
  | 'other-owner'
  /** 到 at 再发（空闲的终端是 LimitService 给的 resumeAt，Auto-resume 关着的是恢复 + 1 分钟）。 */
  | 'scheduled'
  /** 续了又撞两次、发不出按键（gave-up）。 */
  | 'gave-up'
  /** 读不到恢复时间。 */
  | 'reset-unknown';

export type LimitGate =
  /** 轮到它了：空闲就发第一条。 */
  | { kind: 'send' }
  | { kind: 'wait'; why: LimitWait; at: number | null }
  /** 你去掉了勾或点了 Don’t resume：队列暂停。 */
  | { kind: 'pause' };

/**
 * 按 LimitService 的说法现在能不能发第一条。prev 是上一次看到的这个终端的状态（判断 skipped 是你点的还是开关关着到点标的）。
 * 只管“这次上限放没放开”；空闲、没在发这些由 decide 管。
 */
export function limitGate(v: LimitView, now: number, prev: LimitedTerminalState | null = null): LimitGate {
  const { account: a, terminal: t } = v;
  const resets = a.resetsAt ? Date.parse(a.resetsAt) : NaN;
  const due = Number.isNaN(resets) ? null : resets + RESUME_GRACE_MS;
  const afterDue = (): LimitGate => (due === null || now >= due ? { kind: 'send' } : { kind: 'wait', why: 'scheduled', at: due });
  if (a.needsYou === 'stale') return { kind: 'wait', why: 'self-stale', at: null };
  if (a.needsYou === 'slept') return { kind: 'wait', why: 'slept', at: null };
  switch (t.state) {
    case 'resumed':
      return { kind: 'send' };
    case 'resuming':
      return { kind: 'wait', why: 'resuming', at: null };
    case 'gave-up':
      return { kind: 'wait', why: 'gave-up', at: null };
    case 'skipped':
      // 你点的：开关开着、原来是空闲的（只有你能去掉它）、还没到恢复 + 1 分钟（开关关着的要到那时才被标 skipped）
      if (t.autoResume === true || prev === 'idle' || (prev !== null && prev !== 'skipped' && due !== null && now < due)) return { kind: 'pause' };
      return afterDue();
    case 'took-over':
    case 'handed-off':
      return afterDue();
    case 'idle': {
      if (due === null) return { kind: 'wait', why: 'reset-unknown', at: null };
      const at = t.resumeAt ? Date.parse(t.resumeAt) : due;
      return now >= at ? { kind: 'send' } : { kind: 'wait', why: 'scheduled', at };
    }
    case 'interrupted': {
      if (due === null) return { kind: 'wait', why: 'reset-unknown', at: null };
      if (t.owner === 'agent') {
        if (t.selfResume === 'stale') return { kind: 'wait', why: 'self-stale', at: null };
        // Auto-resume 关着时没人替它兜底：claude 恢复 3 分钟后还没开始（LimitService 没把它标 resuming），按原规则发
        if (t.autoResume !== true && now >= Math.max(resets + SELF_RESUME_FALLBACK_MS, due)) return { kind: 'send' };
        return { kind: 'wait', why: 'self-resume', at: resets };
      }
      if (t.owner === 'crew' || t.owner === 'run') return { kind: 'wait', why: 'other-owner', at: null };
      // Auto-resume 开着（老实现不报 autoResume 时看它有没有排 resumeAt）：先等续完
      if (t.autoResume === true || (t.autoResume === undefined && t.resumeAt !== null)) {
        return { kind: 'wait', why: 'auto-resume', at: t.resumeAt ? Date.parse(t.resumeAt) : due };
      }
      // 开关关着：LimitService 到点把它标 skipped、不发续跑；第一条在恢复 + 1 分钟发
      return afterDue();
    }
  }
}

export type QueueDecision =
  /** 发下一条；running 为 true 时把队列标成“正在接着发”。 */
  | { kind: 'send'; running: boolean }
  /** 正在接着发时又碰到上限：停下来等下一次恢复。 */
  | { kind: 'stop-running' }
  | { kind: 'wait' };

export interface QueueInput {
  q: PromptQueueSettings;
  limit: UsageLimit | null;
  status: TerminalStatus | null;
  now: number;
  /** 刚发出去、agent 还没开始干活（等它离开 idle）。 */
  inFlight: boolean;
  /** agent 自己会续跑（claude ≥ 2.1.234）且记下了上限时有值，见 trackSelfResume。 */
  selfResume?: SelfResume | null;
  /**
   * PL5：LimitService 列着这个终端（或刚从列表里消失）、这一次上限还没按它发过第一条时有值（limitGate；消失了是 send）。
   * 有它时不看 armed、selfResume。
   */
  gate?: LimitGate | null;
}

/**
 * 现在要不要发（看 armed，不看当下的 limit，IS-113）：
 * - 关着、暂停、空队列、终端没状态：不发。
 * - 正在接着发（running）：又碰到上限（记下的上限比上一条发出去的晚）就停；agent 空闲、上一条已经开始过就发下一条。
 * - 没在接着发、记下了上限：
 *   - agent 自己会续（selfResume）：恢复后它续的那一轮做完（看到它开始过、或者 limit 已被成功的请求清掉）、回到空闲就发；
 *     恢复 3 分钟后还空闲、没开始过，按原规则发；stale（它在等回车）时不发。
 *   - 别的：到了恢复时间 + 1 分钟、agent 空闲就发第一条，并开始接着发。
 */
export function decide({ q, limit, status, now, inFlight, selfResume, gate }: QueueInput): QueueDecision {
  if (!q.on || q.paused || q.prompts.length === 0 || status === null) return { kind: 'wait' };
  if (gate) {
    // LimitService 说这次上限还没放开：正在接着发的先停下
    if (gate.kind !== 'send') return q.running ? { kind: 'stop-running' } : { kind: 'wait' };
    return status === 'idle' && !inFlight ? { kind: 'send', running: true } : { kind: 'wait' };
  }
  const armed = armedFrom(q, limit);
  if (q.running) {
    const lastSent = q.sent.at(-1);
    if (armed && lastSent && armed.at > Date.parse(lastSent.sentAt)) return { kind: 'stop-running' };
    if (status === 'idle' && !inFlight) return { kind: 'send', running: true };
    return { kind: 'wait' };
  }
  if (!armed || status !== 'idle' || inFlight) return { kind: 'wait' };
  const due = armed.resetsAt + RESUME_GRACE_MS;
  if (selfResume) {
    if (now < armed.resetsAt) return { kind: 'wait' };
    // 它续的那一轮跑过了（limit 被那次成功的请求清掉也算），现在回到空闲
    if (selfResume.started || limit === null) return { kind: 'send', running: true };
    if (selfResume.stale) return { kind: 'wait' };
    const fallback = (selfResume.watchedFrom ?? armed.resetsAt) + SELF_RESUME_FALLBACK_MS;
    return now >= fallback && now >= due ? { kind: 'send', running: true } : { kind: 'wait' };
  }
  return now >= due ? { kind: 'send', running: true } : { kind: 'wait' };
}

/** 书签和卡片状态行的样子。tone 只表达状态：running 绿、waiting 黄，别的灰。 */
export type QueueTone = 'running' | 'waiting' | 'muted';

export interface QueueLabel {
  tone: QueueTone;
  /** 书签上的短字。 */
  mark: string;
  /** 卡片里的一句话。 */
  line: string;
}

/** “3:31pm”；不是今天的加日期 “Oct 28, 3:31pm”。 */
export function clock(t: number, now: number): string {
  const d = new Date(t);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(' ', '').toLowerCase();
  const same = new Date(now).toDateString() === d.toDateString();
  return same ? time : `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${time}`;
}

const LIMIT_NAME: Record<UsageLimit['kind'], string> = { five_hour: '5-hour limit', weekly: 'Weekly limit', other: 'Usage limit' };

export interface QueueLabelOptions {
  /** agent 自己会续跑（selfResumes）。 */
  selfResumes?: boolean;
  /** QueueRunner 看到的续跑情况（还没看过为 null）。 */
  selfResume?: SelfResume | null;
  /** PL5：LimitService 列着这个终端、这次上限还没按它发过时（QueueRunner.limitOf）。有它时按它写。 */
  limits?: { view: LimitView | null; gate: LimitGate } | null;
}

export function queueLabel(q: PromptQueueSettings, limit: UsageLimit | null, status: TerminalStatus | null, agent: string, now: number, opts: QueueLabelOptions = {}): QueueLabel {
  const n = q.prompts.length;
  const count = `Queue · ${n}`;
  if (n === 0) {
    return q.sent.length > 0
      ? { tone: 'muted', mark: '✓ Queue done', line: `All ${q.sent.length} sent.` }
      : { tone: 'muted', mark: 'Queue', line: 'No prompts yet. Add one below.' };
  }
  if (q.paused) return { tone: 'muted', mark: `${count} · paused`, line: 'Paused. Nothing is sent until you resume.' };
  const waitingForYou = status === 'needs-approval' || status === 'needs-reply';
  if (q.running) {
    if (waitingForYou) return { tone: 'waiting', mark: `${count} · needs you`, line: `${agent} is waiting for you. The next prompt goes out once it’s done.` };
    return { tone: 'running', mark: `Sending · ${n} left`, line: `Sending one by one: the next goes out when ${agent} finishes this round.` };
  }
  if (opts.limits) return limitLabel(count, opts.limits.view, opts.limits.gate, status, agent, now);
  const armed = armedFrom(q, limit);
  if (!armed) {
    if (limit && dueAt(limit) === null)
      return { tone: 'waiting', mark: `${count} · reset time unknown`, line: `${LIMIT_NAME[limit.kind]} reached, but ${agent} didn’t say when it resets. Use Send next now when it’s back.` };
    return { tone: 'muted', mark: count, line: `Waiting for ${agent} to hit its usage limit. The first prompt goes out after it resets.` };
  }
  // limit 被成功的请求清掉以后不知道是哪种上限了
  const name = limit ? LIMIT_NAME[limit.kind] : 'Usage limit';
  const resets = armed.resetsAt;
  const due = resets + RESUME_GRACE_MS;
  if (opts.selfResumes) {
    // claude 自己会续：等它续完那一轮再发（IS-113）
    const s = opts.selfResume ?? null;
    if (waitingForYou && now >= resets) return { tone: 'waiting', mark: `${count} · needs you`, line: `${name} has reset, but ${agent} is waiting for you.` };
    if (now >= resets && status === 'running')
      return { tone: 'running', mark: `${count} · ${agent} resuming`, line: `${agent} is continuing the task the limit stopped. The first prompt goes out when it finishes this round.` };
    if (s?.stale && !s.started && limit !== null)
      return {
        tone: 'waiting',
        mark: `${count} · ${agent} waits for Enter`,
        line: `${name} reset while AgentDeck wasn’t watching, so ${agent} is waiting for you to press Enter. The first prompt goes out after that round, or use Send next now.`,
      };
    const fallback = Math.max((s?.watchedFrom ?? resets) + SELF_RESUME_FALLBACK_MS, due);
    if (now < fallback && !s?.started && limit !== null)
      return {
        tone: 'muted',
        mark: `${count} · ${agent} resumes ${clock(resets, now)}`,
        line: `${name} reached · resets ${clock(resets, now)} · ${agent} continues on its own then; the first prompt goes out after that round (or at ${clock(fallback, now)} if it doesn’t start).`,
      };
    return { tone: 'waiting', mark: `${count} · waiting for ${agent}`, line: `${name} has reset. The first prompt goes out as soon as ${agent} is idle.` };
  }
  if (now < due) return { tone: 'waiting', mark: `${count} · sends ${clock(due, now)}`, line: `${name} reached · resets ${clock(resets, now)} · sends the first prompt at ${clock(due, now)}` };
  if (waitingForYou) return { tone: 'waiting', mark: `${count} · needs you`, line: `${name} has reset, but ${agent} is waiting for you.` };
  return { tone: 'waiting', mark: `${count} · waiting for ${agent}`, line: `${name} has reset. The first prompt goes out as soon as ${agent} is idle.` };
}

/** 按 LimitService 写书签（queueLabel 里，队列有东西、没暂停、没在接着发时）。 */
function limitLabel(count: string, view: LimitView | null, gate: LimitGate, status: TerminalStatus | null, agent: string, now: number): QueueLabel {
  const waitingForYou = status === 'needs-approval' || status === 'needs-reply';
  const name = view ? LIMIT_NAME[view.account.kind] : 'Usage limit';
  const resets = view?.account.resetsAt ? Date.parse(view.account.resetsAt) : null;
  if (gate.kind !== 'wait') {
    if (waitingForYou) return { tone: 'waiting', mark: `${count} · needs you`, line: `${name} has reset, but ${agent} is waiting for you.` };
    return { tone: 'waiting', mark: `${count} · waiting for ${agent}`, line: `${name} has reset. The first prompt goes out as soon as ${agent} is idle.` };
  }
  const at = gate.at;
  const resetsText = resets !== null ? ` · resets ${clock(resets, now)}` : '';
  switch (gate.why) {
    case 'self-resume':
      return {
        tone: 'muted',
        mark: `${count} · ${agent} resumes ${clock(at ?? resets ?? now, now)}`,
        line: `${name} reached${resetsText} · ${agent} continues on its own then; the first prompt goes out after that round.`,
      };
    case 'self-stale':
      return {
        tone: 'waiting',
        mark: `${count} · ${agent} waits for Enter`,
        line: `${name} reset while AgentDeck wasn’t watching, so ${agent} is waiting for you to press Enter. The first prompt goes out after that round, or use Send next now.`,
      };
    case 'slept':
      return {
        tone: 'waiting',
        mark: `${count} · waiting for you`,
        line: `${name} reset while the Mac was asleep. Resume ${agent} from the inbox, or use Send next now.`,
      };
    case 'resuming':
      return {
        tone: 'running',
        mark: `${count} · ${agent} resuming`,
        line: `${agent} is continuing the task the limit stopped. The first prompt goes out when it finishes this round.`,
      };
    case 'auto-resume':
      return {
        tone: 'waiting',
        mark: at !== null ? `${count} · resumes ${clock(at, now)}` : `${count} · waiting to resume`,
        line: `${name} reached${resetsText} · Auto-resume continues ${agent}${at !== null ? ` at ${clock(at, now)}` : ''}; the first prompt goes out after that round.`,
      };
    case 'other-owner':
      return { tone: 'waiting', mark: `${count} · waiting to resume`, line: `${name} reached${resetsText} · the first prompt goes out after ${agent} is resumed.` };
    case 'scheduled':
      return {
        tone: 'waiting',
        mark: `${count} · sends ${clock(at ?? now, now)}`,
        line: `${name} reached${resetsText} · sends the first prompt at ${clock(at ?? now, now)}`,
      };
    case 'gave-up':
      return { tone: 'waiting', mark: `${count} · needs you`, line: `${agent} hit the limit again after resuming. Check the inbox, or use Send next now.` };
    case 'reset-unknown':
      return {
        tone: 'waiting',
        mark: `${count} · reset time unknown`,
        line: `${name} reached, but ${agent} didn’t say when it resets. Use Send next now when it’s back.`,
      };
  }
}

// ---- 队列的增删改（返回新的设置，界面写进窗口数据） ----

let seq = 0;
export function newPromptId(): string {
  seq += 1;
  return `q-${Date.now().toString(36)}-${seq}`;
}

export function addPrompt(q: PromptQueueSettings, text: string): PromptQueueSettings {
  const t = text.trim();
  return t ? { ...q, prompts: [...q.prompts, { id: newPromptId(), text: t }] } : q;
}

export function removePrompt(q: PromptQueueSettings, id: string): PromptQueueSettings {
  return { ...q, prompts: q.prompts.filter((p) => p.id !== id) };
}

/** 把 id 那条往前（-1）或往后（+1）挪一位。 */
export function movePrompt(q: PromptQueueSettings, id: string, by: -1 | 1): PromptQueueSettings {
  const i = q.prompts.findIndex((p) => p.id === id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= q.prompts.length) return q;
  const prompts = [...q.prompts];
  [prompts[i], prompts[j]] = [prompts[j]!, prompts[i]!];
  return { ...q, prompts };
}

/** 发出去第一条：从队列里拿走，记进已发，清掉 armed（IS-113：发完第一条才清）。running 是发完以后要不要接着发。 */
export function takeFirst(q: PromptQueueSettings, sentAt: string, running: boolean): { q: PromptQueueSettings; prompt: QueuedPrompt | null } {
  const [first, ...rest] = q.prompts;
  if (!first) return { q: { ...q, running: false }, prompt: null };
  const sent = [...q.sent, { text: first.text, sentAt }].slice(-SENT_KEEP);
  return { q: { ...q, prompts: rest, sent, running: running && rest.length > 0, armed: null }, prompt: first };
}

/**
 * 送进终端的按键：用 bracketed paste 把整段文字送进去（多行的不会在中途被回车提交，也不会被 tmux 当成按键名），
 * 回车另外发（见 QueueRunner）。claude、codex 都支持 bracketed paste。
 */
export function pasteKeys(text: string): string {
  return `\u001b[200~${text}\u001b[201~`;
}
