import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TERMINAL_ID_ENV } from '@agentdeck/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import agentdeckExtension, * as ext from '../bin/agentdeck-pi-extension.mjs';

type State = { turnEnd: string; toolInputs: Map<string, unknown> };
const state = (turnEnd = 'agent_settled'): State => ({ turnEnd, toolInputs: new Map() });

describe('translate', () => {
  it('session events report the current session id', () => {
    for (const name of ['session_start', 'session_switch', 'session_branch']) {
      expect(ext.translate(name, {}, state(), 's1')).toEqual({ hookName: 'SessionStart', payload: { session_id: 's1' } });
    }
    expect(ext.translate('session_start', {}, state(), null)).toBeNull();
  });

  it('agent_start is a submitted prompt, session_shutdown ends the session', () => {
    expect(ext.translate('agent_start', {}, state(), 's1')).toEqual({ hookName: 'UserPromptSubmit', payload: {} });
    expect(ext.translate('session_shutdown', {}, state(), 's1')).toEqual({ hookName: 'SessionEnd', payload: {} });
  });

  it('pi: only agent_settled ends a turn', () => {
    const s = state('agent_settled');
    expect(ext.translate('agent_end', { willContinue: false }, s, null)).toBeNull();
    expect(ext.translate('agent_settled', {}, s, null)).toEqual({ hookName: 'Stop', payload: {} });
  });

  it('omp: agent_end ends a turn unless it will continue on its own', () => {
    const s = state('agent_end');
    expect(ext.translate('agent_end', { willContinue: true }, s, null)).toBeNull();
    expect(ext.translate('agent_end', {}, s, null)).toEqual({ hookName: 'Stop', payload: {} });
    expect(ext.translate('agent_settled', {}, s, null)).toBeNull();
  });

  it('omp approvals carry the input remembered from tool_call', () => {
    const s = state('agent_end');
    expect(ext.translate('tool_call', { toolName: 'bash', toolCallId: 'c1', input: { command: 'rm -rf build' } }, s, null)).toBeNull();
    expect(ext.translate('tool_approval_requested', { toolName: 'bash', toolCallId: 'c1' }, s, null)).toEqual({
      hookName: 'PermissionRequest',
      payload: { tool_name: 'bash', tool_input: { command: 'rm -rf build' } },
    });
    expect(ext.translate('tool_approval_resolved', { toolName: 'bash', toolCallId: 'c1', approved: true }, s, null)).toEqual({
      hookName: 'UserPromptSubmit',
      payload: {},
    });
    expect(s.toolInputs.has('c1')).toBe(true);
    expect(ext.translate('tool_result', { toolName: 'bash', toolCallId: 'c1' }, s, null)).toBeNull();
    expect(s.toolInputs.size).toBe(0);
    // 拒绝后没有 tool_result，也要忘掉
    ext.translate('tool_call', { toolName: 'edit', toolCallId: 'c2', input: { path: '.env' } }, s, null);
    ext.translate('tool_approval_resolved', { toolName: 'edit', toolCallId: 'c2', approved: false }, s, null);
    expect(s.toolInputs.size).toBe(0);
    // 不知道参数时照样报，只是没有 tool_input
    expect(ext.translate('tool_approval_requested', { toolName: 'write', toolCallId: 'zz' }, s, null)).toEqual({
      hookName: 'PermissionRequest',
      payload: { tool_name: 'write', tool_input: {} },
    });
  });

  it('the ask tool is a question; its result means the agent is working again', () => {
    const s = state('agent_end');
    const input = { questions: [{ id: 'q1', question: 'Which color?', options: [{ label: 'Red' }] }] };
    expect(ext.translate('tool_call', { toolName: 'ask', toolCallId: 'c3', input }, s, null)).toEqual({
      hookName: 'Question',
      payload: { question: 'Which color?' },
    });
    expect(ext.translate('tool_result', { toolName: 'ask', toolCallId: 'c3' }, s, null)).toEqual({ hookName: 'UserPromptSubmit', payload: {} });
  });

  it('remembers a bounded number of tool inputs', () => {
    const s = state();
    for (let i = 0; i < 200; i++) ext.translate('tool_call', { toolName: 'read', toolCallId: `c${i}`, input: {} }, s, null);
    expect(s.toolInputs.size).toBeLessThanOrEqual(64);
  });

  it('ignores other events and odd payloads', () => {
    expect(ext.translate('turn_start', {}, state(), 's')).toBeNull();
    expect(ext.translate('tool_call', null, state(), 's')).toBeNull();
    expect(ext.translate('agent_end', 'x', state('agent_end'), 's')).toEqual({ hookName: 'Stop', payload: {} });
  });

  it('sessionIdOf never throws', () => {
    expect(ext.sessionIdOf({ sessionManager: { getSessionId: () => 'id' } })).toBe('id');
    expect(ext.sessionIdOf({ sessionManager: { getSessionId: () => { throw new Error('x'); } } })).toBeNull();
    expect(ext.sessionIdOf(undefined)).toBeNull();
  });
});

describe('extension entry', () => {
  type Handler = (event: unknown, ctx: unknown) => unknown;
  const load = (env: Record<string, string>) => {
    const handlers = new Map<string, Handler>();
    const sent: unknown[] = [];
    agentdeckExtension({ on: (name: string, h: Handler) => void handlers.set(name, h) }, env, (hook: unknown) => sent.push(hook));
    return { handlers, sent };
  };

  it('uses the same terminal id variable as contracts', () => {
    expect(ext.TERMINAL_ID_ENV).toBe(TERMINAL_ID_ENV);
  });

  it('does nothing outside an AgentDeck terminal', () => {
    expect(load({}).handlers.size).toBe(0);
    expect(load({ [ext.TERMINAL_ID_ENV]: 't1' }).handlers.size).toBe(0);
    expect(load({ [ext.NOTIFY_ENV]: '/x/notify' }).handlers.size).toBe(0);
  });

  it('subscribes to every event and never returns a value (tool_call results would block the tool)', () => {
    const { handlers, sent } = load({ [ext.TERMINAL_ID_ENV]: 't1', [ext.NOTIFY_ENV]: '/x/notify', [ext.TURN_END_ENV]: 'agent_end' });
    expect([...handlers.keys()]).toEqual([...new Set([...ext.EVENTS, ...ext.USAGE_EVENTS])]);
    for (const h of handlers.values()) expect(h({ toolName: 'bash', toolCallId: 'c', input: {} }, {})).toBeUndefined();
    expect(sent).toContainEqual({ hookName: 'Stop', payload: {} });
  });

  it('reports context usage after a turn, once per change', () => {
    const { handlers, sent } = load({ [ext.TERMINAL_ID_ENV]: 't1', [ext.NOTIFY_ENV]: '/x/notify' });
    let tokens = 1200;
    const ctx = {
      sessionManager: { getSessionId: () => 's1' },
      model: { id: 'model-a', contextWindow: 128000 },
      getContextUsage: () => ({ tokens, contextWindow: 128000, percent: (tokens / 128000) * 100 }),
    };
    handlers.get('turn_end')!({}, ctx);
    handlers.get('agent_end')!({}, ctx); // 没变，不再发
    tokens = 2400;
    handlers.get('turn_end')!({}, ctx);
    const usage = sent.filter((h) => (h as { hookName: string }).hookName === ext.USAGE_HOOK);
    expect(usage).toEqual([
      { hookName: 'AgentDeckUsage', payload: { session_id: 's1', tokens: 1200, contextWindow: 128000, percent: 0.9375, model: 'model-a' } },
      { hookName: 'AgentDeckUsage', payload: { session_id: 's1', tokens: 2400, contextWindow: 128000, percent: 1.875, model: 'model-a' } },
    ]);
  });

  it('usageReport: unknown tokens after compaction, nothing without getContextUsage', () => {
    expect(ext.usageReport({ getContextUsage: () => ({ tokens: null, contextWindow: 200000, percent: null }) }, 's')).toEqual({
      hookName: 'AgentDeckUsage',
      payload: { session_id: 's', tokens: null, contextWindow: 200000, percent: null, model: null },
    });
    expect(ext.usageReport({}, 's')).toBeNull();
    expect(ext.usageReport({ getContextUsage: () => undefined }, 's')).toBeNull();
    expect(ext.usageReport({ getContextUsage: () => { throw new Error('x'); } }, 's')).toBeNull();
  });

  it('swallows errors from odd contexts', () => {
    const { handlers } = load({ [ext.TERMINAL_ID_ENV]: 't1', [ext.NOTIFY_ENV]: '/x/notify' });
    const ctx = {
      get sessionManager(): never {
        throw new Error('boom');
      },
    };
    expect(() => handlers.get('session_start')!({}, ctx)).not.toThrow();
  });
});

describe('createSender', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adpe-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('runs notify once per hook, in order, with the payload on stdin', async () => {
    const log = join(dir, 'log');
    const notify = join(dir, 'notify');
    // 第一次故意慢一点：后面的必须等它跑完才发
    writeFileSync(notify, `#!/bin/sh\n[ "$2" = SessionStart ] && sleep 0.3\nprintf '%s %s %s\\n' "$1" "$2" "$(cat)" >> '${log}'\n`);
    chmodSync(notify, 0o755);
    const send = ext.createSender(notify, 'omp', { PATH: process.env.PATH ?? '' });
    void send({ hookName: 'SessionStart', payload: { session_id: 's1' } });
    await send({ hookName: 'UserPromptSubmit', payload: {} });
    expect(readFileSync(log, 'utf8')).toBe('omp SessionStart {"session_id":"s1"}\nomp UserPromptSubmit {}\n');
  });

  it('keeps going when notify is missing', async () => {
    const send = ext.createSender(join(dir, 'missing'), 'pi', {});
    await expect(send({ hookName: 'Stop', payload: {} })).resolves.toBeUndefined();
  });
});
