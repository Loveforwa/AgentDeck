// Prompt queue 插件（PL3，设计画布“MVP 插件”页 PluginQueue，调研 DR-63，规则见 docs/plugins.md）的纯逻辑：
// 什么时候发下一条（decide），书签和卡片上写什么（queueLabel），队列的增删改。不碰 React、不碰服务。
//
// 2026-10-27 用户定：只在碰到额度上限、到点恢复后才发（额度没用完时不自动发，要发就点 Send next now）；
// Keep Mac awake 默认开。

import type { PromptQueueSettings, QueuedPrompt, TerminalStatus, TerminalWindowData, UsageLimit, WindowNode } from '@agentdeck/contracts';

/** 先支持这两个：恢复时间读得到（DR-63）。别的 agent 菜单里灰掉。 */
export const QUEUE_AGENTS = ['claude', 'codex'] as const;

/** 恢复时间过了再等这么久才发（毫秒）：恢复的那一刻 agent 那边可能还没放开。 */
export const RESUME_GRACE_MS = 60_000;
/** 发出去以后等它开始干活（状态离开 idle）最多这么久，超过就当它已经做完。 */
export const START_TIMEOUT_MS = 60_000;
/** 已发的最多留这么多条。 */
export const SENT_KEEP = 50;

export const DEFAULT_QUEUE: PromptQueueSettings = { on: false, prompts: [], sent: [], paused: false, keepAwake: true, running: false };

export function queueSettings(node: WindowNode | undefined): PromptQueueSettings {
  const q = (node?.data as Partial<TerminalWindowData> | null)?.queue;
  return q ? { ...DEFAULT_QUEUE, ...q } : DEFAULT_QUEUE;
}

export function queueOn(node: WindowNode | undefined): boolean {
  return queueSettings(node).on;
}

/** 碰到上限后什么时候可以发（恢复时间 + 1 分钟）。读不到恢复时间为 null。 */
export function dueAt(limit: UsageLimit | null): number | null {
  if (!limit?.resetsAt) return null;
  const t = Date.parse(limit.resetsAt);
  return Number.isNaN(t) ? null : t + RESUME_GRACE_MS;
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
}

/**
 * 现在要不要发：
 * - 关着、暂停、空队列、终端没状态：不发。
 * - 正在接着发（running）：又碰到上限（上限的时间比上一条发出去的晚）就停；agent 空闲、上一条已经开始过就发下一条。
 * - 没在接着发：碰到上限、到了恢复时间 + 1 分钟、agent 空闲才发第一条，并开始接着发。
 */
export function decide({ q, limit, status, now, inFlight }: QueueInput): QueueDecision {
  if (!q.on || q.paused || q.prompts.length === 0 || status === null) return { kind: 'wait' };
  if (q.running) {
    const lastSent = q.sent.at(-1);
    const limitAt = limit?.at ? Date.parse(limit.at) : NaN;
    if (limit && lastSent && !Number.isNaN(limitAt) && limitAt > Date.parse(lastSent.sentAt)) return { kind: 'stop-running' };
    if (status === 'idle' && !inFlight) return { kind: 'send', running: true };
    return { kind: 'wait' };
  }
  const due = dueAt(limit);
  if (due !== null && now >= due && status === 'idle' && !inFlight) return { kind: 'send', running: true };
  return { kind: 'wait' };
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

export function queueLabel(q: PromptQueueSettings, limit: UsageLimit | null, status: TerminalStatus | null, agent: string, now: number): QueueLabel {
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
  if (!limit) return { tone: 'muted', mark: count, line: `Waiting for ${agent} to hit its usage limit. The first prompt goes out after it resets.` };
  const name = LIMIT_NAME[limit.kind];
  const due = dueAt(limit);
  if (due === null) return { tone: 'waiting', mark: `${count} · reset time unknown`, line: `${name} reached, but ${agent} didn’t say when it resets. Use Send next now when it’s back.` };
  const resets = Date.parse(limit.resetsAt!);
  if (now < due) return { tone: 'waiting', mark: `${count} · sends ${clock(due, now)}`, line: `${name} reached · resets ${clock(resets, now)} · sends the first prompt at ${clock(due, now)}` };
  if (waitingForYou) return { tone: 'waiting', mark: `${count} · needs you`, line: `${name} has reset, but ${agent} is waiting for you.` };
  return { tone: 'waiting', mark: `${count} · waiting for ${agent}`, line: `${name} has reset. The first prompt goes out as soon as ${agent} is idle.` };
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

/** 发出去第一条：从队列里拿走，记进已发。running 是发完以后要不要接着发。 */
export function takeFirst(q: PromptQueueSettings, sentAt: string, running: boolean): { q: PromptQueueSettings; prompt: QueuedPrompt | null } {
  const [first, ...rest] = q.prompts;
  if (!first) return { q: { ...q, running: false }, prompt: null };
  const sent = [...q.sent, { text: first.text, sentAt }].slice(-SENT_KEEP);
  return { q: { ...q, prompts: rest, sent, running: running && rest.length > 0 }, prompt: first };
}

/**
 * 送进终端的按键：用 bracketed paste 把整段文字送进去（多行的不会在中途被回车提交，也不会被 tmux 当成按键名），
 * 回车另外发（见 QueueRunner）。claude、codex 都支持 bracketed paste。
 */
export function pasteKeys(text: string): string {
  return `\u001b[200~${text}\u001b[201~`;
}
