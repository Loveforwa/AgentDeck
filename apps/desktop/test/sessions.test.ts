// SE2：主进程的 SessionService 对着假 claude（e2e/fake-agent/fake-claude.mjs）跑：真的 AgentService、claude 适配器、
// 钩子 socket 和 agentdeck-notify，终端换成直接起子进程（不用 tmux），往 stdin 打字就是在终端里输入。
// 新建、恢复（X6）、/clear、Reopen、fork、交接都要落在对的 Session 上（TC-52 的后台部分）。

import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AgentSessionId,
  CreateTerminalRequest,
  Session,
  SessionEvent,
  SessionId,
  StartAgentRequest,
  StartAgentResult,
  TerminalId,
} from '@agentdeck/contracts';
import { createAgentRuntime, type AgentRuntime } from '@agentdeck/agent-adapters';
import { openStore, type Store } from '@agentdeck/store';
import { SessionServiceImpl } from '../src/main/sessions.ts';

const FAKE_CLAUDE = fileURLToPath(new URL('../../../e2e/fake-agent/fake-claude.mjs', import.meta.url));
const NOTIFY = fileURLToPath(new URL('../../../tools/agentdeck-notify/bin/agentdeck-notify.mjs', import.meta.url));

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
function script(path: string, target: string): string {
  writeFileSync(path, `#!/bin/sh\nexec ${q(process.execPath)} ${q(target)} "$@"\n`);
  chmodSync(path, 0o755);
  return path;
}

/** TerminalHost 的 create：直接起子进程，stdin 当键盘。 */
class ProcessHost {
  private readonly children = new Map<TerminalId, ChildProcess>();
  private n = 0;
  onExit: (id: TerminalId, code: number) => void = () => {};
  constructor(private readonly env: Record<string, string>) {}

  async create(req: CreateTerminalRequest): Promise<{ id: TerminalId }> {
    const id = `term-${++this.n}` as TerminalId;
    const child = spawn(req.cmd, req.args, {
      cwd: req.cwd,
      env: { ...this.env, ...req.env, AGENTDECK_TERM: id },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.on('exit', (code) => this.onExit(id, code ?? 129));
    this.children.set(id, child);
    return { id };
  }

  type(id: TerminalId, line: string): void {
    this.children.get(id)?.stdin?.write(`${line}\n`);
  }

  async kill(id: TerminalId): Promise<void> {
    this.children.get(id)?.kill('SIGHUP');
  }

  killAll(): void {
    for (const c of this.children.values()) c.kill('SIGKILL');
  }
}

async function until<T>(read: () => T | null | undefined | false, what: string, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = read();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

let dir: string;
let store: Store;
let host: ProcessHost;
let rt: AgentRuntime;
let sessions: SessionServiceImpl;
let events: SessionEvent[];
let hooks: { terminalId: TerminalId; hookName: string }[];
let agents: { start(req: StartAgentRequest): Promise<StartAgentResult> };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ads-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  mkdirSync(join(dir, 'repo'));
  script(join(bin, 'claude'), FAKE_CLAUDE);
  const notifyCommand = script(join(dir, 'agentdeck-notify'), NOTIFY);
  const socketPath = join(dir, 'run', 'hooks.sock');
  // codex、pi 等不在 PATH 上：当作没装
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, AGENTDECK_HOOK_SOCKET: socketPath };

  store = openStore(':memory:');
  host = new ProcessHost(env);
  events = [];
  hooks = [];
  sessions = new SessionServiceImpl({ repo: store.sessions, emit: (e) => events.push(e), startAgent: (req) => agents.start(req) });
  rt = createAgentRuntime({
    env: () => env,
    terminals: host,
    notifyCommand,
    socketPath,
    sessionRoots: null,
    emit: () => {},
    destructivePatterns: () => [],
    tapHook: (h) => {
      hooks.push({ terminalId: h.terminalId, hookName: h.hookName });
      sessions.noteHook(h);
      return false;
    },
  });
  await rt.start();
  host.onExit = (id, code) => sessions.noteTerminalEvent({ type: 'terminal.exit', id, code });
  // 和 index.ts 的 agents.start 一样：经过 SessionService 再交给 AgentService
  agents = { start: (req) => sessions.start(req, (r) => rt.agents.start(r)) };
});

afterEach(async () => {
  host.onExit = () => {};
  host.killAll();
  await rt.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const cwd = () => join(dir, 'repo');
const startClaude = (over: Partial<StartAgentRequest> = {}) =>
  agents.start({ agent: 'claude', cwd: cwd(), workspaceId: null, mode: { kind: 'new' }, ...over });
const sessionStarts = (id: TerminalId) => hooks.filter((h) => h.terminalId === id && h.hookName === 'SessionStart').length;
const get = (id: SessionId) => store.sessions.get(id)!;
const segments = (s: Session) => s.agentSessions.map((x) => [x.id, x.reason]);

// 每个钩子要起两次 node（假 claude 的钩子命令、agentdeck-notify），一条用例里有好几个
describe('SessionService against the fake claude', { timeout: 30_000 }, () => {
  it('a new terminal gets a new running Session with its first conversation', async () => {
    const res = await startClaude({ origin: { kind: 'spawn', tool: 'open_terminal' } });
    expect(res.session).toEqual(expect.any(String));
    await until(() => sessionStarts(res.terminalId) === 1, 'SessionStart');
    const s = get(res.session!);
    expect(s).toMatchObject({
      agent: 'claude',
      cwd: cwd(),
      parentId: null,
      origin: { kind: 'spawn', tool: 'open_terminal' },
      terminalId: res.terminalId,
      state: 'running',
    });
    // 启动时知道的 id 和 SessionStart（source: startup）报的是同一个：只有一段
    expect(segments(s)).toEqual([[res.sessionId, 'start']]);
    expect(sessions.sessionOf(res.terminalId)).toBe(s.id);
    expect(events.at(-1)).toEqual({ type: 'session.changed', session: s });
  });

  it('/clear and compact stay in the same Session; /clear adds a segment', async () => {
    const res = await startClaude();
    await until(() => sessionStarts(res.terminalId) === 1, 'SessionStart');
    host.type(res.terminalId, 'clear');
    const cleared = await until(() => {
      const s = get(res.session!);
      return s.agentSessions.length === 2 && s;
    }, 'the clear segment');
    expect(cleared.agentSessions[1]).toMatchObject({ reason: 'clear' });
    expect(cleared.agentSessions[1]!.id).not.toBe(res.sessionId);

    host.type(res.terminalId, 'compact');
    await until(() => sessionStarts(res.terminalId) === 3, 'the compact SessionStart');
    // compact 不换 id：还是两段
    expect(segments(get(res.session!))).toEqual([
      [res.sessionId, 'start'],
      [cleared.agentSessions[1]!.id, 'clear'],
    ]);
    expect(store.sessions.list()).toHaveLength(1);
  });

  it('closing the window stops the process and keeps the Session; Reopen comes back to the same one', async () => {
    const first = await startClaude();
    await until(() => sessionStarts(first.terminalId) === 1, 'SessionStart');
    await sessions.rename(first.session!, 'lead');
    host.kill(first.terminalId);
    const stopped = await until(() => get(first.session!).state === 'stopped' && get(first.session!), 'stopped');
    expect(stopped.terminalId).toBeNull();
    expect(sessions.sessionOf(first.terminalId)).toBeNull();

    // Reopen：界面带上 data.session，按 resume 接回 agent 的对话
    const again = await startClaude({ session: first.session!, mode: { kind: 'resume', sessionId: first.sessionId! } });
    expect(again.session).toBe(first.session);
    expect(again.terminalId).not.toBe(first.terminalId);
    await until(() => sessionStarts(again.terminalId) === 1, 'SessionStart after reopen');
    expect(get(first.session!)).toMatchObject({ state: 'running', terminalId: again.terminalId, label: 'lead' });
    // 接回的是同一段对话：不多一段
    expect(segments(get(first.session!))).toEqual([[first.sessionId, 'start']]);
    expect(store.sessions.list()).toHaveLength(1);
  });

  it('restoring (X6) without data.session lands on the Session that owns the conversation', async () => {
    const first = await startClaude();
    await until(() => sessionStarts(first.terminalId) === 1, 'SessionStart');
    host.type(first.terminalId, 'quit');
    await until(() => get(first.session!).state === 'stopped', 'stopped');

    // 重启电脑后恢复：窗口只记得 agent 的会话 id
    const restored = await startClaude({ mode: { kind: 'resume', sessionId: first.sessionId! } });
    expect(restored.session).toBe(first.session);
    expect(get(first.session!)).toMatchObject({ state: 'running', terminalId: restored.terminalId });

    // AgentDeck 没记过的对话（历史栏 Resume）：收进一条新的，origin adopted
    const adopted = await startClaude({ mode: { kind: 'resume', sessionId: 'outside-conv' as AgentSessionId } });
    expect(adopted.session).not.toBe(first.session);
    expect(get(adopted.session!)).toMatchObject({ origin: { kind: 'adopted' }, parentId: null });
    expect(segments(get(adopted.session!))).toEqual([['outside-conv', 'resume']]);
  });

  it('records the parent of a spawned session and of a fork', async () => {
    const lead = await startClaude();
    const child = await startClaude({ parent: lead.session!, origin: { kind: 'spawn', tool: 'open_terminals' } });
    const ghost = await startClaude({ parent: 'not-a-session' as SessionId });
    expect(get(child.session!).parentId).toBe(lead.session);
    expect(get(ghost.session!).parentId).toBeNull();
    expect((await sessions.children(lead.session!)).map((s) => s.id)).toEqual([child.session]);

    // Fork into…：没带 parent、origin 时按被 fork 的对话找到父
    const fork = await startClaude({ mode: { kind: 'fork', sessionId: lead.sessionId! } });
    expect(get(fork.session!)).toMatchObject({ parentId: lead.session, origin: { kind: 'fork', agentSessionId: lead.sessionId } });
    expect(segments(get(fork.session!))).toEqual([[fork.sessionId, 'fork']]);
  });

  it('a window that brings its own session id keeps it even when the database does not know it', async () => {
    const res = await startClaude({ session: 'from-the-board' as SessionId });
    expect(res.session).toBe('from-the-board');
    expect(get('from-the-board' as SessionId).state).toBe('running');
  });

  it('hands off to a child session and keeps the old window running', async () => {
    const from = await startClaude();
    await expect(sessions.handoff({ from: from.session!, agent: 'codex', note: 'Finish the login form.' })).rejects.toMatchObject({
      code: 'command-not-found',
    });
    expect(get(from.session!).state).toBe('running');

    const note = await sessions.handoffSummary(from.session!);
    expect(note).toContain(`Previous conversation: claude session ${from.sessionId}`);
    const res = await sessions.handoff({ from: from.session!, agent: 'claude', note });
    expect(res.session).toMatchObject({ parentId: from.session, origin: { kind: 'handoff' }, handoffNote: note, state: 'running' });
    expect(get(from.session!)).toMatchObject({ state: 'handed-off', handedOffTo: res.session.id, terminalId: from.terminalId });

    // 上一家的进程退出后仍是 handed-off
    host.kill(from.terminalId);
    await until(() => get(from.session!).terminalId === null, 'old process gone');
    expect(get(from.session!).state).toBe('handed-off');
  });

  it('reconcile stops sessions whose process is gone after a restart', async () => {
    const a = await startClaude();
    const b = await startClaude();
    sessions.reconcile([
      { id: a.terminalId, alive: true },
      { id: b.terminalId, alive: false },
    ]);
    expect(get(a.session!).state).toBe('running');
    expect(get(b.session!)).toMatchObject({ state: 'stopped', terminalId: null });
    sessions.noteTerminalEvent({ type: 'terminal.host-lost' });
    expect(get(a.session!).state).toBe('stopped');
  });

  it('get, children and rename throw not-found for unknown sessions', async () => {
    const id = 'nope' as SessionId;
    await expect(sessions.get(id)).rejects.toMatchObject({ code: 'not-found' });
    await expect(sessions.children(id)).rejects.toMatchObject({ code: 'not-found' });
    await expect(sessions.rename(id, 'x')).rejects.toMatchObject({ code: 'not-found' });
    await expect(sessions.handoff({ from: id, agent: 'claude', note: '' })).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('SessionService without processes', () => {
  it('keeps a SessionStart that arrives before agents.start returns, and uses the launch mode when it has no reason', async () => {
    const s = openStore(':memory:');
    const svc = new SessionServiceImpl({ repo: s.sessions, emit: () => {}, startAgent: () => Promise.reject(new Error('unused')) });
    const t = 'early' as TerminalId;
    // codex 这类启动时不知道会话 id；omp 的 SessionStart 不带 source
    const res = await svc.start({ agent: 'omp', cwd: '/w', workspaceId: null, mode: { kind: 'new' } }, async () => {
      svc.noteHook({ terminalId: t, event: { type: 'session-start', sessionId: 'omp-1' as AgentSessionId } });
      return { terminalId: t, sessionId: null, cmd: 'omp', args: [] };
    });
    expect(s.sessions.get(res.session!)!.agentSessions.map((x) => [x.id, x.reason])).toEqual([['omp-1', 'start']]);
    // 之后不带原因的就是 unknown
    svc.noteHook({ terminalId: t, event: { type: 'session-start', sessionId: 'omp-2' as AgentSessionId } });
    expect(s.sessions.get(res.session!)!.agentSessions.at(-1)).toMatchObject({ id: 'omp-2', reason: 'unknown' });
    s.close();
  });

  it('records nothing when the launch fails', async () => {
    const s = openStore(':memory:');
    const svc = new SessionServiceImpl({ repo: s.sessions, emit: () => {}, startAgent: () => Promise.reject(new Error('unused')) });
    await expect(
      svc.start({ agent: 'claude', cwd: '/w', workspaceId: null, mode: { kind: 'new' } }, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    expect(s.sessions.list()).toEqual([]);
    s.close();
  });
});
