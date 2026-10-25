// X6：恢复上次会话的纯逻辑：要不要恢复、每种终端怎么恢复、Shell 填什么。

import { describe, expect, it } from 'vitest';
import type { AgentDeckApi, AgentSessionId, StartAgentRequest, StartAgentResult, TerminalId, TerminalWindowData } from '@agentdeck/contracts';
import { AgentDeckError } from '@agentdeck/contracts';
import { needsRestore, planRestore, refillCommand, restoreDiffersFromRestart, restoreTerminal } from '../src/restore.ts';
import { terminalWindowType } from '../src/definition.ts';

const data = (over: Partial<TerminalWindowData>): TerminalWindowData => ({
  terminalId: 't-old' as TerminalId,
  agent: 'claude',
  cmd: 'claude',
  args: [],
  cwd: '/repo',
  sessionId: null,
  startCommand: null,
  ...over,
});
const sid = (s: string) => s as AgentSessionId;

describe('needsRestore', () => {
  const live = new Set(['t-live' as TerminalId]);
  it('only when the saved terminal is missing from tmux (or there is none)', () => {
    expect(needsRestore({ terminalId: 't-live' as TerminalId }, live)).toBe(false);
    expect(needsRestore({ terminalId: 't-old' as TerminalId }, live)).toBe(true);
    expect(needsRestore({ terminalId: null }, live)).toBe(true);
  });
  it('the window definition describes only windows that need it', () => {
    const r = terminalWindowType.restore!;
    expect(r.describe(data({ terminalId: 't-live' as TerminalId }), live)).toBeNull();
    expect(r.describe(data({ sessionId: sid('s1') }), live)).toEqual({ kind: 'agent', label: 'claude', detail: 'Resumes the conversation', fresh: false });
  });
});

describe('planRestore per kind', () => {
  it.each(['claude', 'codex', 'pi', 'omp', 'kimi'] as const)('%s with a recorded session id resumes it', (agent) => {
    const p = planRestore(data({ agent, cmd: agent, sessionId: sid(`s-${agent}`) }));
    expect(p).toMatchObject({ kind: 'agent', label: agent, fresh: false, request: { agent, mode: { kind: 'resume', sessionId: `s-${agent}` } } });
    expect(p.request.prefill).toBeUndefined();
  });

  it('an agent without a session id starts fresh and says so', () => {
    const p = planRestore(data({ agent: 'codex', cmd: 'codex' }));
    expect(p).toMatchObject({ kind: 'agent', fresh: true, detail: 'No saved conversation; starts a new one', request: { mode: { kind: 'new' } } });
  });

  it('a shell reopens with the last command typed in (lastCommand before startCommand), never run', () => {
    expect(planRestore(data({ agent: 'shell', cmd: '/bin/zsh', startCommand: 'pnpm build', lastCommand: 'pnpm dev' }))).toMatchObject({
      kind: 'shell',
      label: 'zsh',
      detail: 'Opens zsh here with “pnpm dev” typed in, not run',
      request: { agent: 'shell', mode: { kind: 'new' }, prefill: 'pnpm dev' },
      data: {},
    });
    expect(planRestore(data({ agent: 'shell', cmd: '/bin/zsh', startCommand: 'pnpm build' })).request.prefill).toBe('pnpm build');
    const plain = planRestore(data({ agent: 'shell', cmd: '-zsh' }));
    expect(plain).toMatchObject({ detail: 'Opens zsh in the same folder', request: { agent: 'shell', mode: { kind: 'new' } } });
    expect(plain.request.prefill).toBeUndefined();
    expect('command' in plain.request).toBe(false);
  });

  it('a custom command becomes a shell with the command typed in', () => {
    expect(planRestore(data({ agent: 'custom', cmd: 'pnpm', args: ['dev'], startCommand: 'pnpm dev' }))).toMatchObject({
      kind: 'shell',
      request: { agent: 'shell', prefill: 'pnpm dev' },
      data: { agent: 'shell', startCommand: 'pnpm dev' },
    });
    expect(refillCommand(data({ agent: 'custom', cmd: 'make', args: ['watch'] }))).toBe('make watch');
  });

  it('the refill never carries a newline (that would run it)', () => {
    expect(refillCommand(data({ agent: 'shell', lastCommand: 'pnpm dev\n' }))).toBe('pnpm dev');
    expect(refillCommand(data({ agent: 'shell', lastCommand: '\n', startCommand: 'make\trun' }))).toBe('make run');
  });

  it('Restore gets its own button only when it differs from Restart', () => {
    expect(restoreDiffersFromRestart(data({ sessionId: sid('s') }))).toBe(true);
    expect(restoreDiffersFromRestart(data({}))).toBe(false);
    expect(restoreDiffersFromRestart(data({ agent: 'shell', cmd: 'zsh' }))).toBe(false);
    expect(restoreDiffersFromRestart(data({ agent: 'shell', cmd: 'zsh', lastCommand: 'pnpm dev' }))).toBe(true);
    expect(restoreDiffersFromRestart(data({ agent: 'custom', cmd: 'pnpm', args: ['dev'] }))).toBe(true);
  });
});

describe('restoreTerminal', () => {
  function fakeAgents(fail?: (req: StartAgentRequest) => Error | null) {
    const calls: StartAgentRequest[] = [];
    const api = {
      agents: {
        start: async (req: StartAgentRequest): Promise<StartAgentResult> => {
          calls.push(req);
          const err = fail?.(req);
          if (err) throw err;
          const sessionId = req.mode.kind === 'resume' ? req.mode.sessionId : req.agent === 'claude' ? sid('s-new') : null;
          return { terminalId: `t-${calls.length}` as TerminalId, sessionId, cmd: req.agent === 'shell' ? '/bin/zsh' : req.agent, args: [] };
        },
      },
    } as unknown as Pick<AgentDeckApi, 'agents'>;
    return { api, calls };
  }
  const ctx = { workspaceId: null, contentSize: { w: 560, h: 332 } };

  it('passes cwd, workspace and size; the window gets the new terminal id and keeps its session', async () => {
    const { api, calls } = fakeAgents();
    const r = await restoreTerminal(api, data({ sessionId: sid('s1'), cwd: '/repo/a' }), { ...ctx, workspaceId: 'ws-1' as never });
    expect(calls[0]).toMatchObject({ agent: 'claude', cwd: '/repo/a', workspaceId: 'ws-1', mode: { kind: 'resume', sessionId: 's1' } });
    expect(calls[0]!.size!.cols).toBeGreaterThan(0);
    expect(r).toEqual({ patch: { terminalId: 't-1', cmd: 'claude', args: [], sessionId: 's1' }, fresh: false });
  });

  it('falls back to a new conversation when the agent can’t resume', async () => {
    const { api, calls } = fakeAgents((req) => (req.mode.kind === 'resume' ? new AgentDeckError({ code: 'unsupported', message: 'no' }) : null));
    const r = await restoreTerminal(api, data({ agent: 'kimi', cmd: 'kimi', sessionId: sid('s1') }), ctx);
    expect(calls.map((c) => c.mode.kind)).toEqual(['resume', 'new']);
    expect(r.fresh).toBe(true);
    expect(r.patch.sessionId).toBeNull();
  });

  it('other errors propagate', async () => {
    const { api } = fakeAgents(() => new AgentDeckError({ code: 'invalid-argument', message: 'Folder not found: /gone' }));
    await expect(restoreTerminal(api, data({ sessionId: sid('s1') }), ctx)).rejects.toThrow('Folder not found');
  });

  it('a shell restores with prefill and no command', async () => {
    const { api, calls } = fakeAgents();
    const r = await restoreTerminal(api, data({ agent: 'shell', cmd: '/bin/zsh', lastCommand: 'pnpm dev' }), ctx);
    expect(calls[0]).toMatchObject({ agent: 'shell', mode: { kind: 'new' }, prefill: 'pnpm dev' });
    expect(calls[0]!.command).toBeUndefined();
    expect(r.patch).toMatchObject({ terminalId: 't-1', cmd: '/bin/zsh', sessionId: null });
  });
});
