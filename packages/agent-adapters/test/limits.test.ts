// 额度上限模块（PL5）：认出被打断 / 空闲 / 你接手、账号键、错开续跑、两次又撞后停、睡过头先问、claude 自己续跑。
// 时钟、按键、用量、子 agent、白板都是注入的假东西；不起定时器（直接调 tick）。

import type {
  AccountLimit,
  BackgroundAgent,
  BoardState,
  PromptQueueSettings,
  StatusSnapshot,
  TerminalId,
  TerminalStatus,
  TerminalUsage,
  TerminalWindowData,
  UsageLimit,
  WindowNode,
  WorkspaceId,
} from '@agentdeck/contracts';
import { describe, expect, it } from 'vitest';
import {
  accountKey,
  ClaudeAdapter,
  claudeLimitOf,
  CODEX_SUBAGENT_LINE,
  DEFAULT_RESUME_PROMPT,
  effectiveAutoResume,
  limitConfigDir,
  LimitServiceImpl,
  resumePromptText,
} from '../src/index.ts';
import type { LimitTarget } from '../src/index.ts';

const T0 = Date.parse('2026-10-28T20:00:00.000Z');
const MIN = 60_000;
const id = (s: string) => s as TerminalId;
const iso = (t: number) => new Date(t).toISOString();
const flush = () => new Promise((r) => setTimeout(r, 0));

// ---- 白板 ----

function win(terminalId: string, data: Partial<TerminalWindowData> = {}, workspaceId: string | null = null): WindowNode {
  return {
    id: `w-${terminalId}` as WindowNode['id'],
    type: 'terminal',
    workspaceId: workspaceId as WorkspaceId | null,
    rect: { x: 0, y: 0, w: 100, h: 100 },
    z: 0,
    title: null,
    restoreRect: null,
    data: { terminalId: id(terminalId), agent: 'codex', cmd: 'codex', args: [], cwd: '/r', sessionId: null, startCommand: null, ...data },
  };
}

function board(windows: WindowNode[], extra: Partial<BoardState> = {}): BoardState {
  return {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    frames: [],
    windows,
    panel: { open: true, width: 300 },
    savedAt: iso(T0),
    ...extra,
  };
}

const queue = (n: number): PromptQueueSettings => ({
  on: true,
  prompts: Array.from({ length: n }, (_, i) => ({ id: `q${i}`, text: `p${i}` })),
  sent: [],
  paused: false,
  keepAwake: true,
  running: false,
});

// ---- 假的组装 ----

interface Rig {
  svc: LimitServiceImpl;
  now: { t: number };
  sent: { id: TerminalId; keys: string[]; at: number }[];
  awake: boolean[];
  events: AccountLimit[][];
  usage: Map<TerminalId, TerminalUsage>;
  subs: Map<TerminalId, BackgroundAgent[]>;
  board: { b: BoardState };
  status(terminal: string, s: TerminalStatus): void;
  limit(terminal: string, l: Partial<UsageLimit> & { scope?: string }, model?: string): void;
  clearLimit(terminal: string): void;
  tickAt(t: number): Promise<void>;
  only(): AccountLimit;
  term(terminal: string): AccountLimit['terminals'][number] | undefined;
  /** 发出去的文字（bracketed paste 那一段），按先后。 */
  texts(terminal?: string): string[];
}

function rig(targets: LimitTarget[], b: BoardState, opts: { staggerMs?: number } = {}): Rig {
  const now = { t: T0 };
  const sent: Rig['sent'] = [];
  const awake: boolean[] = [];
  const events: AccountLimit[][] = [];
  const usage = new Map<TerminalId, TerminalUsage>();
  const subs = new Map<TerminalId, BackgroundAgent[]>();
  const boardRef = { b };
  const emptyUsage = (terminalId: TerminalId): TerminalUsage => ({
    terminalId,
    agent: null,
    state: 'no-data',
    reason: null,
    sessionId: null,
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
  });
  const svc = new LimitServiceImpl({
    emit: (e) => events.push(e.limits),
    lookup: (tid) => targets.find((x) => x.terminalId === tid) ?? null,
    targets: () => targets,
    sendKeys: async (tid, keys) => {
      sent.push({ id: tid, keys, at: now.t });
    },
    setKeepAwake: (on) => awake.push(on),
    usage: {
      get: async (tid) => usage.get(tid) ?? emptyUsage(tid),
      watch: async (tid) => usage.get(tid) ?? emptyUsage(tid),
      unwatch: async () => undefined,
    },
    subagents: { list: async () => [...subs].map(([terminalId, agents]) => ({ terminalId, agents })) },
    board: async () => boardRef.b,
    staggerMs: opts.staggerMs ?? 30_000,
    pasteDelayMs: 0,
    now: () => now.t,
  });
  const r: Rig = {
    svc,
    now,
    sent,
    awake,
    events,
    usage,
    subs,
    board: boardRef,
    status(terminal, s) {
      const snap: StatusSnapshot = { terminalId: id(terminal), status: s, since: iso(now.t), exitCode: null, pending: null };
      svc.noteStatus(snap);
    },
    limit(terminal, l, model) {
      const u: TerminalUsage = {
        ...emptyUsage(id(terminal)),
        state: 'ok',
        model: model ?? null,
        limit: { kind: 'five_hour', resetsAt: null, at: iso(now.t), detail: null, ...l } as UsageLimit,
      };
      usage.set(id(terminal), u);
      svc.noteUsage(u);
    },
    clearLimit(terminal) {
      const u = usage.get(id(terminal));
      if (u) usage.set(id(terminal), { ...u, limit: null });
    },
    async tickAt(t) {
      now.t = t;
      await svc.tick();
      await flush();
    },
    only() {
      const all = events.at(-1) ?? [];
      expect(all).toHaveLength(1);
      return all[0]!;
    },
    term(terminal) {
      return (events.at(-1) ?? []).flatMap((a) => a.terminals).find((t) => t.terminalId === terminal);
    },
    texts(terminal) {
      return sent.filter((s) => !terminal || s.id === terminal).flatMap((s) => s.keys.filter((k) => k.startsWith('\u001b[200~')).map((k) => k.slice(6, -6)));
    },
  };
  return r;
}

const codex = (terminal: string, configDir = '/h/.codex'): LimitTarget => ({ terminalId: id(terminal), agent: 'codex', configDir, selfResumes: false });
const claude = (terminal: string, selfResumes = false): LimitTarget => ({ terminalId: id(terminal), agent: 'claude', configDir: '/h/.claude', selfResumes });
const on = (terminal: string, data: Partial<TerminalWindowData> = {}) => win(terminal, { autoResume: true, ...data });

// ---- 钩子解析 ----

describe('claude hooks for usage limits', () => {
  const adapter = new ClaudeAdapter({ env: () => ({}) });

  it('StopFailure carries the error, so a rate limit is told apart from other failures', () => {
    expect(adapter.parseHook('StopFailure', { error: 'rate_limit', error_details: '429' })).toEqual({ type: 'turn-end', error: 'rate_limit' });
    expect(adapter.parseHook('StopFailure', { error: 'server_error' })).toEqual({ type: 'turn-end', error: 'server_error' });
    expect(adapter.parseHook('StopFailure', {})).toEqual({ type: 'turn-end' });
  });

  it('Notification quota_auto_resume_* becomes quota-resume', () => {
    for (const what of ['fired', 'stale', 'disabled'] as const) {
      expect(adapter.parseHook('Notification', { notification_type: `quota_auto_resume_${what}`, message: '…' })).toEqual({ type: 'quota-resume', what });
    }
    expect(adapter.parseHook('Notification', { notification_type: 'idle_prompt' })).toBeNull();
  });

  it('the rate_limit line keeps the Opus / Sonnet scope', () => {
    const line = (rateLimitType: string) => ({
      type: 'assistant',
      timestamp: iso(T0),
      error: 'rate_limit',
      quotaLimits: { status: 'rejected', rateLimitType, resetsAt: T0 / 1000 + 3600 },
      message: { model: '<synthetic>', content: [] },
    });
    expect(claudeLimitOf(line('seven_day_opus'))).toMatchObject({ kind: 'weekly', scope: 'opus' });
    expect(claudeLimitOf(line('seven_day_sonnet'))).toMatchObject({ kind: 'weekly', scope: 'sonnet' });
    expect(claudeLimitOf(line('five_hour'))).not.toHaveProperty('scope');
  });
});

// ---- 规则 ----

describe('limit rules', () => {
  it('account key = agent + config dir + scope', () => {
    expect(accountKey('codex', '/Users/you/.codex', 'all')).toBe('codex:/Users/you/.codex:all');
    expect(limitConfigDir('codex', { CODEX_HOME: '/work/codex-b/' }, '/Users/you')).toBe('/work/codex-b');
    expect(limitConfigDir('codex', {}, '/Users/you')).toBe('/Users/you/.codex');
    expect(limitConfigDir('claude', { CLAUDE_CONFIG_DIR: '/c2' }, '/Users/you')).toBe('/c2');
    expect(limitConfigDir('kimi', {}, '/Users/you')).toBeNull();
  });

  it('Auto-resume: terminal over frame over board, off by default', () => {
    const ws = 'ws1';
    const b = (frameOn: boolean | null | undefined, termOn: boolean | null | undefined, boardOn?: boolean) =>
      board([win('t1', termOn === undefined ? {} : { autoResume: termOn }, ws)], {
        frames: [{ workspaceId: ws as WorkspaceId, rect: { x: 0, y: 0, w: 1, h: 1 }, z: 0, autoApprove: false, ...(frameOn === undefined ? {} : { autoResume: frameOn }) }],
        ...(boardOn === undefined ? {} : { autoResume: boardOn }),
      });
    expect(effectiveAutoResume(b(undefined, undefined), id('t1'))).toBe(false);
    expect(effectiveAutoResume(b(undefined, undefined, true), id('t1'))).toBe(true);
    expect(effectiveAutoResume(b(false, null, true), id('t1'))).toBe(false);
    expect(effectiveAutoResume(b(false, true, true), id('t1'))).toBe(true);
    expect(effectiveAutoResume(b(true, undefined, false), id('t1'))).toBe(true);
    expect(effectiveAutoResume(b(undefined, undefined, true), id('nope'))).toBe(false);
    expect(effectiveAutoResume(null, id('t1'))).toBe(false);
  });

  it('resume prompt: template, then the lost claude background agents by name, or the codex line', () => {
    const lost = [{ id: 'a1b2c3', description: 'Index claude sessions', agentType: 'general-purpose' }];
    const c = resumePromptText({ agent: 'claude', lost });
    expect(c.startsWith(DEFAULT_RESUME_PROMPT)).toBe(true);
    expect(c).toContain('• Index claude sessions (agent id a1b2c3)');
    expect(c).toContain('resume it with SendMessage to its id');
    expect(resumePromptText({ agent: 'claude' })).toBe(DEFAULT_RESUME_PROMPT);
    expect(resumePromptText({ agent: 'codex', template: 'Carry on.' })).toBe(`Carry on.\n\n${CODEX_SUBAGENT_LINE}`);
    expect(resumePromptText({ agent: 'claude', template: 'x', override: 'Continue T4.' })).toBe('Continue T4.');
    expect(resumePromptText({ agent: 'claude', lost, subagentsOnly: true })).not.toContain(DEFAULT_RESUME_PROMPT);
  });
});

// ---- LimitService ----

describe('LimitService: who was interrupted', () => {
  it('the terminal whose round ended on the limit is interrupted; the idle one on the same CODEX_HOME is limited too', async () => {
    const r = rig([codex('t5'), codex('t6'), codex('other', '/h/codex-b'), claude('c1')], board([on('t5'), on('t6')]));
    for (const t of ['t5', 't6', 'other', 'c1']) r.status(t, 'idle');
    r.limit('t5', { resetsAt: iso(T0 + 60 * MIN) });
    await r.svc.tick();
    const a = r.only();
    expect(a.key).toBe('codex:/h/.codex:all');
    expect(a.resetsAt).toBe(iso(T0 + 60 * MIN));
    expect(a.terminals.map((t) => [t.terminalId, t.state])).toEqual([
      ['t5', 'interrupted'],
      ['t6', 'idle'],
    ]);
    // 被打断的写几点续（恢复 + 1 分钟）；当时空闲、没有排着提示词的不续
    expect(r.term('t5')?.resumeAt).toBe(iso(T0 + 61 * MIN));
    expect(r.term('t6')?.resumeAt).toBeNull();
  });

  it('typing into it after the hit is taking over: it is never resumed (TC-81)', async () => {
    const r = rig([codex('t5')], board([on('t5')]));
    r.status('t5', 'idle');
    r.limit('t5', { resetsAt: iso(T0 + 60 * MIN) });
    r.svc.noteInput(id('t5'));
    // 最后的状态发一次（书签写 you took over），然后整组不再列出
    expect(r.events.at(-2)?.[0]?.terminals[0]?.state).toBe('took-over');
    expect(r.events.at(-1)).toEqual([]);
    await r.tickAt(T0 + 62 * MIN);
    expect(r.sent).toEqual([]);
    expect(r.events.at(-1)).toEqual([]);
  });

  it('a new prompt you sent (UserPromptSubmit) is taking over too; claude’s own task-notification is not', async () => {
    const r = rig([claude('c1')], board([on('c1')]));
    r.status('c1', 'idle');
    r.svc.noteHook({ terminalId: id('c1'), agent: 'claude', hookName: 'StopFailure', payload: {}, event: { type: 'turn-end', error: 'rate_limit' } });
    r.svc.noteHook({ terminalId: id('c1'), agent: 'claude', hookName: 'UserPromptSubmit', payload: { prompt: '<task-notification><task-id>x</task-id></task-notification>' }, event: { type: 'prompt-submitted' } });
    expect(r.term('c1')?.state).toBe('interrupted');
    r.svc.noteHook({ terminalId: id('c1'), agent: 'claude', hookName: 'UserPromptSubmit', payload: { prompt: 'do something else' }, event: { type: 'prompt-submitted' } });
    expect(r.events.at(-1)).toEqual([]);
  });

  it('claude Opus limit only counts terminals on an Opus model', async () => {
    const r = rig([claude('c1'), claude('c2'), claude('c3')], board([]));
    for (const t of ['c1', 'c2', 'c3']) r.status(t, 'idle');
    r.svc.noteUsage({ terminalId: id('c2'), model: 'claude-opus-5-5' } as TerminalUsage);
    r.svc.noteUsage({ terminalId: id('c3'), model: 'claude-sonnet-4-6' } as TerminalUsage);
    r.limit('c1', { kind: 'weekly', resetsAt: iso(T0 + 3 * 60 * MIN), scope: 'opus' }, 'claude-opus-5-5');
    const a = r.only();
    expect(a.key).toBe('claude:/h/.claude:opus');
    expect(a.scope).toBe('opus');
    expect(a.terminals.map((t) => [t.terminalId, t.state])).toEqual([
      ['c1', 'interrupted'],
      ['c2', 'idle'],
    ]);
  });

  it('a StopFailure first (scope unknown), then the transcript says Opus: moves to the Opus account', async () => {
    const r = rig([claude('c1'), claude('c3')], board([]));
    r.status('c1', 'idle');
    r.status('c3', 'idle');
    r.svc.noteUsage({ terminalId: id('c3'), model: 'claude-sonnet-4-6' } as TerminalUsage);
    r.svc.noteHook({ terminalId: id('c1'), agent: 'claude', hookName: 'StopFailure', payload: {}, event: { type: 'turn-end', error: 'rate_limit' } });
    expect(r.only().key).toBe('claude:/h/.claude:all');
    r.limit('c1', { kind: 'weekly', at: iso(T0 - 1000), resetsAt: iso(T0 + 60 * MIN), scope: 'opus' }, 'claude-opus-5-5');
    const a = r.only();
    expect(a.key).toBe('claude:/h/.claude:opus');
    expect(a.terminals.map((t) => t.terminalId)).toEqual(['c1']);
    expect(a.resetsAt).toBe(iso(T0 + 60 * MIN));
  });
});

describe('LimitService: resuming', () => {
  it('resumes in the order they were interrupted, 30 seconds apart; idle with a queue gets the next slot (TC-78, TC-80)', async () => {
    const r = rig([codex('t5'), codex('t6'), codex('docs')], board([on('t5'), on('t6'), win('docs', { queue: queue(1) })]));
    for (const t of ['t5', 't6', 'docs']) r.status(t, 'idle');
    r.now.t = T0;
    r.limit('t6', { resetsAt: iso(T0 + 60 * MIN) });
    r.now.t = T0 + 2 * MIN;
    r.limit('t5', { resetsAt: iso(T0 + 60 * MIN) });
    await r.tickAt(T0 + 3 * MIN);
    expect(r.only().terminals.map((t) => [t.terminalId, t.state, t.resumeAt])).toEqual([
      ['t6', 'interrupted', iso(T0 + 61 * MIN)],
      ['t5', 'interrupted', iso(T0 + 61 * MIN + 30_000)],
      ['docs', 'idle', iso(T0 + 62 * MIN)],
    ]);
    expect(r.awake.at(-1)).toBe(true);

    await r.tickAt(T0 + 60 * MIN);
    expect(r.sent).toEqual([]);
    await r.tickAt(T0 + 61 * MIN);
    expect(r.sent.map((s) => s.id)).toEqual(['t6', 't6']);
    expect(r.sent[0]!.keys[0]).toBe(`\u001b[200~${DEFAULT_RESUME_PROMPT}\n\n${CODEX_SUBAGENT_LINE}\u001b[201~`);
    expect(r.sent[1]!.keys).toEqual(['Enter']);
    expect(r.term('t6')?.state).toBe('resuming');
    // 自己发的按键回来的 terminal.input 不算你接手
    r.svc.noteInput(id('t6'));
    expect(r.term('t6')?.state).toBe('resuming');

    await r.tickAt(T0 + 61 * MIN + 29_000);
    expect(r.sent).toHaveLength(2);
    await r.tickAt(T0 + 61 * MIN + 30_000);
    expect(r.sent.map((s) => s.id)).toEqual(['t6', 't6', 't5', 't5']);
    await r.tickAt(T0 + 62 * MIN);
    // 当时空闲的不发续跑提示，只放开排着的（PL3 发）
    expect(r.sent).toHaveLength(4);
    expect(r.term('docs')?.state).toBe('resumed');

    // 续跑这一轮做完
    for (const t of ['t6', 't5']) {
      r.clearLimit(t);
      r.status(t, 'running');
      r.status(t, 'idle');
    }
    await flush();
    expect(r.events.at(-1)).toEqual([]);
    // 等的时候不让 Mac 睡，续上后放开
    expect(r.awake).toEqual([true, false]);
    // interrupted → resuming → resumed，然后不再列出
    const states = r.events.map((l) => l.flatMap((a) => a.terminals).find((t) => t.terminalId === 't6')?.state ?? null);
    expect(states.filter((s, i) => s !== states[i - 1])).toEqual(['interrupted', 'resuming', 'resumed', null]);
  });

  it('gives up after hitting the limit again twice in a row', async () => {
    const r = rig([codex('t5')], board([on('t5')]));
    r.status('t5', 'idle');
    r.limit('t5', { resetsAt: iso(T0 + 60 * MIN) });
    await r.tickAt(T0 + 61 * MIN);
    expect(r.texts('t5')).toHaveLength(1);
    // 续了又撞（第 1 次）：等下一次恢复
    r.status('t5', 'running');
    r.now.t = T0 + 70 * MIN;
    r.limit('t5', { resetsAt: iso(T0 + 120 * MIN) });
    r.status('t5', 'idle');
    await flush();
    expect(r.term('t5')).toMatchObject({ state: 'interrupted', resumeAt: iso(T0 + 121 * MIN) });
    await r.tickAt(T0 + 121 * MIN);
    expect(r.texts('t5')).toHaveLength(2);
    // 第 2 次：停下，进收件箱
    r.status('t5', 'running');
    r.now.t = T0 + 125 * MIN;
    r.status('t5', 'idle');
    r.limit('t5', { resetsAt: iso(T0 + 180 * MIN) });
    await flush();
    expect(r.term('t5')).toMatchObject({ state: 'gave-up', resumeAt: null });
    await r.tickAt(T0 + 181 * MIN);
    expect(r.texts('t5')).toHaveLength(2);
  });

  it('codex: the Stop comes before the transcript is read: still counted as hitting again', async () => {
    const r = rig([codex('t5')], board([on('t5')]));
    r.status('t5', 'idle');
    r.limit('t5', { resetsAt: iso(T0 + 60 * MIN) });
    await r.tickAt(T0 + 61 * MIN);
    r.status('t5', 'running');
    r.now.t = T0 + 70 * MIN;
    // 会话记录里已经是新的上限，但 usage.changed 还没来
    r.usage.set(id('t5'), { ...r.usage.get(id('t5'))!, limit: { kind: 'five_hour', resetsAt: iso(T0 + 120 * MIN), at: iso(T0 + 69 * MIN), detail: null } });
    r.status('t5', 'idle');
    await flush();
    expect(r.term('t5')).toMatchObject({ state: 'interrupted', resumeAt: iso(T0 + 121 * MIN) });
  });

  it('does not resume after the Mac slept past the reset by 30+ minutes; Resume all does', async () => {
    const r = rig([codex('t5')], board([on('t5')]));
    r.status('t5', 'idle');
    r.limit('t5', { resetsAt: iso(T0 + 60 * MIN) });
    await r.tickAt(T0 + 30 * MIN);
    // Mac 睡着：中间没有检查，醒来已是恢复后 40 分钟
    await r.tickAt(T0 + 100 * MIN);
    expect(r.sent).toEqual([]);
    expect(r.only().needsYou).toBe('slept');
    expect(r.awake.at(-1)).toBe(false);
    await r.svc.resumeNow(r.only().key);
    expect(r.texts('t5')).toHaveLength(1);
    expect(r.only().needsYou).toBeNull();
  });

  it('woke up within 30 minutes of the reset: resumes as usual', async () => {
    const r = rig([codex('t5')], board([on('t5')]));
    r.status('t5', 'idle');
    r.limit('t5', { resetsAt: iso(T0 + 60 * MIN) });
    await r.tickAt(T0 + 30 * MIN);
    await r.tickAt(T0 + 80 * MIN);
    expect(r.texts('t5')).toHaveLength(1);
  });

  it('Auto-resume off (the default): lists the limit but sends nothing and keeps nothing awake', async () => {
    const r = rig([codex('t5')], board([win('t5')]));
    r.status('t5', 'idle');
    r.limit('t5', { resetsAt: iso(T0 + 60 * MIN) });
    await r.svc.tick();
    // contracts 0.1.22：开关关着看 autoResume，不用再读白板；codex 不会自己续，没有 selfResume
    expect(r.term('t5')).toMatchObject({ state: 'interrupted', resumeAt: null, autoResume: false });
    expect(r.term('t5')).not.toHaveProperty('selfResume');
    await r.tickAt(T0 + 59 * MIN);
    await r.tickAt(T0 + 62 * MIN);
    expect(r.sent).toEqual([]);
    expect(r.awake.filter(Boolean)).toEqual([]);
    expect(r.events.at(-1)).toEqual([]);
  });

  it('turning Auto-resume on before the reset is picked up', async () => {
    const r = rig([codex('t5')], board([win('t5')]));
    r.status('t5', 'idle');
    r.limit('t5', { resetsAt: iso(T0 + 60 * MIN) });
    r.board.b = board([on('t5')]);
    await r.tickAt(T0 + 30 * MIN);
    expect(r.term('t5')).toMatchObject({ resumeAt: iso(T0 + 61 * MIN), autoResume: true });
    await r.tickAt(T0 + 61 * MIN);
    expect(r.texts('t5')).toHaveLength(1);
  });

  it('no reset time: waits for you (reset-unknown), Resume now sends', async () => {
    const r = rig([claude('c1')], board([on('c1')]));
    r.status('c1', 'idle');
    r.svc.noteHook({ terminalId: id('c1'), agent: 'claude', hookName: 'StopFailure', payload: {}, event: { type: 'turn-end', error: 'rate_limit' } });
    await flush();
    await r.tickAt(T0 + 2 * MIN);
    expect(r.only()).toMatchObject({ resetsAt: null, needsYou: 'reset-unknown' });
    await r.svc.resumeNow(r.only().key);
    expect(r.texts('c1')).toEqual([DEFAULT_RESUME_PROMPT]);
  });

  it('skip and cancel', async () => {
    const r = rig([codex('t5'), codex('t6')], board([on('t5'), on('t6')]));
    r.status('t5', 'idle');
    r.status('t6', 'idle');
    r.limit('t5', { resetsAt: iso(T0 + 60 * MIN) });
    r.limit('t6', { resetsAt: iso(T0 + 60 * MIN) });
    await r.svc.skip(id('t6'));
    expect(r.term('t6')?.state).toBe('skipped');
    await r.tickAt(T0 + 62 * MIN);
    expect(r.sent.map((s) => s.id)).toEqual(['t5', 't5']);
    await expect(r.svc.skip(id('nope'))).rejects.toMatchObject({ code: 'not-found' });
    await expect(r.svc.resumeNow('codex:/x:all')).rejects.toMatchObject({ code: 'not-found' });

    const r2 = rig([codex('t5'), codex('t6')], board([on('t5'), on('t6')]));
    r2.status('t5', 'idle');
    r2.status('t6', 'idle');
    r2.limit('t5', { resetsAt: iso(T0 + 60 * MIN) });
    await r2.svc.cancel(r2.only().key);
    expect(r2.events.at(-1)).toEqual([]);
    await r2.tickAt(T0 + 62 * MIN);
    expect(r2.sent).toEqual([]);
  });

  it('crew terminals wait for the crew scheduler (resumeNow) and use its prompt', async () => {
    const r = rig([codex('t5')], board([win('t5')]));
    await r.svc.setOwner(id('t5'), 'crew', 'Your usage limit has reset. Continue T4.');
    r.status('t5', 'idle');
    r.limit('t5', { resetsAt: iso(T0 + 60 * MIN) });
    await r.tickAt(T0 + 62 * MIN);
    expect(r.sent).toEqual([]);
    expect(r.term('t5')).toMatchObject({ owner: 'crew', state: 'interrupted' });
    await r.svc.resumeNow(r.only().key, [id('t5')]);
    expect(r.texts('t5')).toEqual([`Your usage limit has reset. Continue T4.\n\n${CODEX_SUBAGENT_LINE}`]);
  });

  it('the crew resuming its own terminal does not hold up the rest of the account', async () => {
    const r = rig([codex('t5'), codex('t6')], board([on('t5'), on('t6')]));
    await r.svc.setOwner(id('t5'), 'crew');
    r.status('t5', 'idle');
    r.status('t6', 'idle');
    r.limit('t5', { resetsAt: iso(T0 + 60 * MIN) });
    r.now.t = T0 + MIN;
    r.limit('t6', { resetsAt: iso(T0 + 60 * MIN) });
    r.now.t = T0 + 61 * MIN;
    await r.svc.resumeNow(r.only().key, [id('t5')]);
    expect(r.sent.map((s) => s.id)).toEqual(['t5', 't5']);
    expect(r.term('t6')).toMatchObject({ state: 'interrupted', resumeAt: iso(T0 + 61 * MIN + 30_000) });
    await r.tickAt(T0 + 61 * MIN + 30_000);
    expect(r.sent.map((s) => s.id)).toEqual(['t5', 't5', 't6', 't6']);
  });

  it('keeps the Mac awake only within 12 hours of the reset', async () => {
    const r = rig([codex('t5')], board([on('t5')]));
    r.status('t5', 'idle');
    r.limit('t5', { kind: 'weekly', resetsAt: iso(T0 + 3 * 24 * 60 * MIN) });
    await r.svc.tick();
    expect(r.awake.filter(Boolean)).toEqual([]);
    await r.tickAt(T0 + 3 * 24 * 60 * MIN - 11 * 60 * MIN);
    expect(r.awake.at(-1)).toBe(true);
  });
});

describe('LimitService: claude resumes by itself (2.1.234+)', () => {
  const failed = (agentId: string, description: string, endedAt: number): BackgroundAgent => ({
    id: agentId,
    terminalId: id('c1'),
    agentType: 'general-purpose',
    description,
    background: true,
    state: 'failed',
    reason: 'Failed',
    startedAt: iso(T0 - 10 * MIN),
    endedAt: iso(endedAt),
    durationMs: null,
    tokens: null,
    lastStep: null,
    current: true,
  });
  const stopFailure = (r: Rig) =>
    r.svc.noteHook({ terminalId: id('c1'), agent: 'claude', hookName: 'StopFailure', payload: { error: 'rate_limit' }, event: { type: 'turn-end', error: 'rate_limit' } });
  const quota = (r: Rig, what: 'fired' | 'stale' | 'disabled') =>
    r.svc.noteHook({ terminalId: id('c1'), agent: 'claude', hookName: 'Notification', payload: {}, event: { type: 'quota-resume', what } });

  function hitClaude(): Rig {
    const r = rig([claude('c1', true)], board([on('c1')]));
    r.status('c1', 'idle');
    r.usage.set(id('c1'), {
      terminalId: id('c1'),
      model: 'claude-opus-5-5',
      limit: { kind: 'five_hour', resetsAt: iso(T0 + 60 * MIN), at: iso(T0 - 500), detail: "You've hit your limit" },
    } as TerminalUsage);
    stopFailure(r);
    return r;
  }

  it('does not send anything while claude continues on its own; marks it resuming on fired', async () => {
    const r = hitClaude();
    await flush();
    await r.svc.tick();
    expect(r.term('c1')).toMatchObject({ state: 'interrupted', owner: 'agent', resumeAt: null, selfResume: 'waiting', autoResume: true });
    expect(r.only().resetsAt).toBe(iso(T0 + 60 * MIN));
    await r.tickAt(T0 + 60 * MIN);
    quota(r, 'fired');
    expect(r.term('c1')).toMatchObject({ state: 'resuming', selfResume: 'fired' });
    r.svc.noteHook({ terminalId: id('c1'), agent: 'claude', hookName: 'UserPromptSubmit', payload: { prompt: 'Continue from where you left off.' }, event: { type: 'prompt-submitted' } });
    expect(r.term('c1')?.state).toBe('resuming');
    r.clearLimit('c1');
    r.status('c1', 'running');
    r.status('c1', 'idle');
    await flush();
    await flush();
    expect(r.sent).toEqual([]);
    expect(r.events.at(-1)).toEqual([]);
  });

  it('after its own round, names the background agents that are still failed (once) — not when it restarted one (TC-82)', async () => {
    const r = hitClaude();
    r.subs.set(id('c1'), [failed('a1', 'Index claude sessions', T0 - MIN), failed('a2', 'Weather 10 years ago', T0)]);
    await flush();
    await r.tickAt(T0 + 60 * MIN);
    expect(r.term('c1')?.lostSubagents).toBe(2);
    quota(r, 'fired');
    r.status('c1', 'running');
    r.status('c1', 'idle');
    await flush();
    await flush();
    expect(r.texts('c1')).toHaveLength(1);
    expect(r.texts('c1')[0]).not.toContain(DEFAULT_RESUME_PROMPT);
    expect(r.texts('c1')[0]).toContain('• Index claude sessions (agent id a1)');
    expect(r.texts('c1')[0]).toContain('• Weather 10 years ago (agent id a2)');
    r.status('c1', 'running');
    r.status('c1', 'idle');
    await flush();
    await flush();
    expect(r.texts('c1')).toHaveLength(1);
    expect(r.events.at(-1)).toEqual([]);

    // 续跑那一轮里重派过（SubagentStart）：不补发
    const r2 = hitClaude();
    r2.subs.set(id('c1'), [failed('a1', 'Index claude sessions', T0)]);
    await flush();
    await r2.tickAt(T0 + 60 * MIN);
    quota(r2, 'fired');
    r2.status('c1', 'running');
    r2.svc.noteHook({ terminalId: id('c1'), agent: 'claude', hookName: 'SubagentStart', payload: { agent_id: 'a3' }, event: null });
    r2.status('c1', 'idle');
    await flush();
    await flush();
    expect(r2.sent).toEqual([]);
  });

  it('disabled: AgentDeck sends the resume prompt with the lost background agents', async () => {
    const r = hitClaude();
    r.subs.set(id('c1'), [failed('a1', 'Index claude sessions', T0)]);
    await flush();
    await r.tickAt(T0 + 60 * MIN);
    quota(r, 'disabled');
    expect(r.term('c1')).toMatchObject({ owner: 'auto-resume', selfResume: 'disabled' });
    await r.tickAt(T0 + 61 * MIN);
    expect(r.texts('c1')).toHaveLength(1);
    expect(r.texts('c1')[0]!.startsWith(DEFAULT_RESUME_PROMPT)).toBe(true);
    expect(r.texts('c1')[0]).toContain('(agent id a1)');
  });

  it('no sign of life 3 minutes after the reset: AgentDeck sends', async () => {
    const r = hitClaude();
    await flush();
    await r.tickAt(T0 + 60 * MIN);
    await r.tickAt(T0 + 62 * MIN);
    expect(r.sent).toEqual([]);
    await r.tickAt(T0 + 63 * MIN);
    expect(r.texts('c1')).toEqual([DEFAULT_RESUME_PROMPT]);
    // AgentDeck 自己发的：不再报 claude 的续跑
    expect(r.term('c1')).toMatchObject({ owner: 'auto-resume', state: 'resuming' });
    expect(r.term('c1')).not.toHaveProperty('selfResume');
  });

  it('stale: waits for you; Continue (resumeNow on it) presses Enter only', async () => {
    const r = hitClaude();
    await flush();
    await r.tickAt(T0 + 60 * MIN);
    quota(r, 'stale');
    expect(r.only().needsYou).toBe('stale');
    expect(r.term('c1')?.selfResume).toBe('stale');
    await r.tickAt(T0 + 70 * MIN);
    expect(r.sent).toEqual([]);
    await r.svc.resumeNow(r.only().key, [id('c1')]);
    expect(r.sent).toEqual([{ id: 'c1', keys: ['Enter'], at: T0 + 70 * MIN }]);
    expect(r.term('c1')?.state).toBe('resuming');
  });

  it('claude does not wait for resets more than 24 hours away: AgentDeck owns those', async () => {
    const r = rig([claude('c1', true)], board([on('c1')]));
    r.status('c1', 'idle');
    r.limit('c1', { kind: 'weekly', resetsAt: iso(T0 + 3 * 24 * 60 * MIN) });
    await r.svc.tick();
    expect(r.term('c1')?.owner).toBe('auto-resume');
  });
});
