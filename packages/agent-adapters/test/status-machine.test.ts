// 每个用例对应 src/status/machine.ts 顶部转换表的一行（编号相同）。

import type {
  AgentHookEvent,
  AgentSessionId,
  StatusEvent,
  TerminalId,
  TerminalStatus,
  WorkspaceId,
} from '@agentdeck/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DESTRUCTIVE_PATTERNS } from '../src/status/destructive.ts';
import { StatusMachine } from '../src/status/machine.ts';
import type { HookHint } from '../src/status/machine.ts';

const T = 'term-1' as TerminalId;
const WS = 'ws-1' as WorkspaceId;

let events: StatusEvent[];
let clock: number;
let m: StatusMachine;

beforeEach(() => {
  events = [];
  clock = Date.parse('2026-10-23T12:00:00Z');
  m = new StatusMachine({
    emit: (e) => events.push(e),
    destructivePatterns: () => DEFAULT_DESTRUCTIVE_PATTERNS,
    now: () => new Date(clock),
  });
});

function track(hooks: boolean, status?: TerminalStatus) {
  m.track(T, { agent: hooks ? 'claude' : 'shell', workspaceId: WS, hooks, ...(status ? { status } : {}) });
  events = [];
}

function status() {
  return m.get(T)!.status;
}

function hook(event: AgentHookEvent | null, hint?: HookHint) {
  m.onHook(T, event, hint);
}

const activity = () => m.onTerminalEvent({ type: 'terminal.activity', id: T, at: '' });
const silence = () => m.onTerminalEvent({ type: 'terminal.silence', id: T, at: '' });
const exit = (code: number) => m.onTerminalEvent({ type: 'terminal.exit', id: T, code });
const turnEnds = () => events.filter((e) => e.type === 'agent.turn-end');
const changes = () => events.filter((e) => e.type === 'status.changed');

const approval: AgentHookEvent = { type: 'permission-request', tool: 'Bash', summary: 'pnpm test', command: 'pnpm test' };

describe('tracking', () => {
  it('starts as starting and emits status.changed', () => {
    m.track(T, { agent: 'claude', workspaceId: WS, hooks: true });
    expect(events).toEqual([
      { type: 'status.changed', snapshot: { terminalId: T, status: 'starting', since: '2026-10-23T12:00:00.000Z', exitCode: null, pending: null } },
    ]);
  });

  it('snapshot() lists every tracked terminal', async () => {
    track(true);
    m.track('term-2' as TerminalId, { agent: 'shell', workspaceId: null, hooks: false, status: 'idle' });
    expect((await m.snapshot()).map((s) => [s.terminalId, s.status])).toEqual([
      [T, 'starting'],
      ['term-2', 'idle'],
    ]);
  });

  it('replays hooks that arrived before track()', () => {
    hook({ type: 'session-start', sessionId: 'abc' as AgentSessionId });
    m.track(T, { agent: 'codex', workspaceId: WS, hooks: true });
    expect(status()).toBe('idle');
    expect(m.get(T)!.sessionId).toBe('abc');
  });

  it('drops early hooks older than 10 seconds', () => {
    hook({ type: 'prompt-submitted' });
    clock += 11_000;
    m.onHook('other' as TerminalId, null); // 触发清理
    m.track(T, { agent: 'codex', workspaceId: WS, hooks: true });
    expect(status()).toBe('starting');
  });
});

describe('exit (rows 1-4)', () => {
  it('1: exit 0 -> exited', () => {
    track(true, 'running');
    exit(0);
    expect(m.get(T)).toMatchObject({ status: 'exited', exitCode: 0, pending: null });
  });

  it('2: non-zero exit -> error with the code', () => {
    track(false, 'running');
    exit(2);
    expect(m.get(T)).toMatchObject({ status: 'error', exitCode: 2 });
  });

  it('2: exit while waiting clears the pending request', () => {
    track(true, 'idle');
    hook(approval);
    exit(129);
    expect(m.get(T)).toMatchObject({ status: 'error', exitCode: 129, pending: null });
  });

  it('3: host-lost -> error for every live terminal', () => {
    track(true, 'running');
    m.track('t2' as TerminalId, { agent: 'shell', workspaceId: null, hooks: false, status: 'exited' });
    m.onTerminalEvent({ type: 'terminal.host-lost' });
    expect(status()).toBe('error');
    expect(m.get('t2' as TerminalId)!.status).toBe('exited');
  });

  it('4: nothing changes an ended terminal', () => {
    track(true, 'running');
    exit(0);
    events = [];
    hook({ type: 'prompt-submitted' });
    activity();
    silence();
    exit(1);
    expect(events).toEqual([]);
    expect(status()).toBe('exited');
  });
});

describe('agents with hooks (rows 5-16)', () => {
  it('5: starting + session-start -> idle, remembers the session id', () => {
    track(true);
    hook({ type: 'session-start', sessionId: 's-1' as AgentSessionId });
    expect(status()).toBe('idle');
    expect(m.get(T)!.sessionId).toBe('s-1');
  });

  it('6: running before any turn + session-start -> idle', () => {
    track(true);
    activity();
    expect(status()).toBe('running');
    hook({ type: 'session-start', sessionId: 's-1' as AgentSessionId });
    expect(status()).toBe('idle');
  });

  it('7: session-start during a turn (compact, /clear) keeps the status', () => {
    track(true, 'idle');
    hook({ type: 'prompt-submitted' });
    hook({ type: 'session-start', sessionId: 's-2' as AgentSessionId });
    expect(status()).toBe('running');
    expect(m.get(T)!.sessionId).toBe('s-2');
  });

  it('8: prompt-submitted -> running', () => {
    track(true, 'idle');
    hook({ type: 'prompt-submitted' });
    expect(status()).toBe('running');
  });

  it('8: after an approval, the tool finishing (PostToolUse) -> running and clears pending', () => {
    track(true, 'idle');
    hook(approval);
    hook({ type: 'prompt-submitted' }, { afterTool: 'pnpm test' });
    expect(m.get(T)).toMatchObject({ status: 'running', pending: null });
  });

  it('8b: another tool finishing in parallel does not clear the approval', () => {
    track(true, 'idle');
    hook(approval);
    hook({ type: 'prompt-submitted' }, { afterTool: 'Read /repo/a.ts' });
    expect(status()).toBe('needs-approval');
    expect(m.get(T)!.pending?.summary).toBe('pnpm test');
  });

  it('9: permission-request -> needs-approval with a PendingRequest', () => {
    track(true, 'idle');
    hook({ type: 'prompt-submitted' });
    clock += 5000;
    hook(approval);
    const s = m.get(T)!;
    expect(s.status).toBe('needs-approval');
    expect(s.since).toBe('2026-10-23T12:00:05.000Z');
    expect(s.pending).toEqual({
      id: 'req-1',
      terminalId: T,
      workspaceId: WS,
      agent: 'claude',
      kind: 'approval',
      summary: 'pnpm test',
      command: 'pnpm test',
      destructive: false,
      at: '2026-10-23T12:00:05.000Z',
    });
    expect(m.pendingRequests()).toHaveLength(1);
  });

  it('9: destructive commands are flagged from the Settings list', () => {
    track(true, 'idle');
    hook({ type: 'permission-request', tool: 'Bash', summary: 'git push --force', command: 'git push --force origin main' });
    expect(m.get(T)!.pending?.destructive).toBe(true);
  });

  it('9: tools without a command are judged by their summary (Edit .env)', () => {
    track(true, 'idle');
    hook({ type: 'permission-request', tool: 'Edit', summary: 'Edit /repo/.env', command: null });
    expect(m.get(T)!.pending?.destructive).toBe(true);
  });

  it('9: the destructive list is read on every request, so Settings changes apply at once', () => {
    let patterns: readonly string[] = [];
    m = new StatusMachine({ emit: (e) => events.push(e), destructivePatterns: () => patterns });
    track(true, 'idle');
    hook(approval);
    expect(m.get(T)!.pending?.destructive).toBe(false);
    patterns = ['pnpm'];
    hook({ ...approval, summary: 'pnpm test 2' });
    expect(m.get(T)!.pending?.destructive).toBe(true);
  });

  it('9: a second request replaces the first and gets a new id', () => {
    track(true, 'idle');
    hook(approval);
    hook({ ...approval, summary: 'pnpm lint', command: 'pnpm lint' });
    expect(m.get(T)!.pending).toMatchObject({ id: 'req-2', summary: 'pnpm lint' });
    expect(changes()).toHaveLength(2);
  });

  it('10: question -> needs-reply', () => {
    track(true, 'idle');
    hook({ type: 'question', summary: 'Tea or coffee?' });
    expect(m.get(T)).toMatchObject({ status: 'needs-reply', pending: { kind: 'question', summary: 'Tea or coffee?', destructive: false } });
  });

  it('11: turn-end -> idle and agent.turn-end (a finished turn is idle, not needs-reply)', () => {
    track(true, 'idle');
    hook({ type: 'prompt-submitted' });
    hook({ type: 'turn-end' });
    expect(status()).toBe('idle');
    expect(turnEnds()).toEqual([{ type: 'agent.turn-end', terminalId: T, workspaceId: WS }]);
  });

  it('11: turn-end clears a pending request (codex Interrupt after a denied approval)', () => {
    track(true, 'idle');
    hook(approval);
    hook({ type: 'turn-end' });
    expect(m.get(T)).toMatchObject({ status: 'idle', pending: null });
    expect(turnEnds()).toHaveLength(1);
  });

  it('11: a second turn-end while already idle is not repeated', () => {
    track(true, 'idle');
    hook({ type: 'prompt-submitted' });
    hook({ type: 'turn-end' });
    hook({ type: 'turn-end' });
    expect(turnEnds()).toHaveLength(1);
  });

  it('12: session-end changes nothing', () => {
    track(true, 'idle');
    hook({ type: 'session-end' });
    expect(events).toEqual([]);
  });

  it('13: starting + output -> running', () => {
    track(true);
    activity();
    expect(status()).toBe('running');
  });

  it('14: running before any turn + silence -> idle, without agent.turn-end', () => {
    track(true);
    activity();
    silence();
    expect(status()).toBe('idle');
    expect(turnEnds()).toEqual([]);
  });

  it('15: denied approval (no hook) -> user input then silence -> idle', () => {
    track(true, 'idle');
    hook(approval);
    m.noteInput(T);
    silence();
    expect(m.get(T)).toMatchObject({ status: 'idle', pending: null });
    expect(turnEnds()).toHaveLength(1);
  });

  it('15: Esc during a running turn -> input then silence -> idle', () => {
    track(true, 'idle');
    hook({ type: 'prompt-submitted' });
    m.noteInput(T);
    silence();
    expect(status()).toBe('idle');
  });

  it('15: a hook after the input cancels the fallback (approved, tool still running)', () => {
    track(true, 'idle');
    hook(approval);
    m.noteInput(T);
    hook({ type: 'prompt-submitted' }, { afterTool: 'pnpm test' });
    silence();
    expect(status()).toBe('running');
  });

  it('15: silence without user input keeps waiting', () => {
    track(true, 'idle');
    hook(approval);
    activity();
    silence();
    expect(status()).toBe('needs-approval');
  });

  it('15: input is ignored for terminals without hooks', () => {
    track(false, 'running');
    m.noteInput(T);
    silence();
    expect(turnEnds()).toEqual([]);
  });

  it('16: output and silence do not change idle, waiting, or an active turn', () => {
    track(true, 'idle');
    activity();
    silence();
    expect(status()).toBe('idle');
    hook({ type: 'question', summary: 'Q' });
    activity();
    silence();
    expect(status()).toBe('needs-reply');
    hook({ type: 'prompt-submitted' });
    silence();
    expect(status()).toBe('running');
  });
});

describe('programs without hooks (rows 17-19)', () => {
  it('17: starting + output -> running', () => {
    track(false);
    activity();
    expect(status()).toBe('running');
  });

  it('17: idle + output -> running', () => {
    track(false, 'idle');
    activity();
    expect(status()).toBe('running');
  });

  it('18: running + silence -> idle, without agent.turn-end', () => {
    track(false);
    activity();
    silence();
    expect(status()).toBe('idle');
    expect(turnEnds()).toEqual([]);
  });

  it('19: hook events still apply (legacy codex notify turn-end)', () => {
    track(false);
    activity();
    hook({ type: 'turn-end' });
    expect(status()).toBe('idle');
    expect(turnEnds()).toHaveLength(1);
  });
});

describe('since and duplicate events', () => {
  it('keeps since when nothing changes and does not emit', () => {
    track(true, 'idle');
    hook({ type: 'prompt-submitted' });
    const since = m.get(T)!.since;
    clock += 60_000;
    hook({ type: 'prompt-submitted' });
    expect(m.get(T)!.since).toBe(since);
    expect(changes()).toHaveLength(1);
  });

  it('ignores unknown terminals for terminal events', () => {
    m.onTerminalEvent({ type: 'terminal.activity', id: 'nope' as TerminalId, at: '' });
    expect(events).toEqual([]);
  });

  it('forget() drops the terminal', async () => {
    track(true);
    m.forget(T);
    expect(await m.snapshot()).toEqual([]);
  });
});
