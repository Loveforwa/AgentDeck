import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_SOCKET, TERMINAL_ID_ENV } from '@agentdeck/contracts';
import type { HookEnvelope, HookReply } from '@agentdeck/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as notify from '../bin/agentdeck-notify.mjs';

const SCRIPT = fileURLToPath(new URL('../bin/agentdeck-notify.mjs', import.meta.url));

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

function run(args: string[], opts: { env?: Record<string, string>; stdin?: string } = {}): Promise<Run> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: { PATH: process.env.PATH ?? '', HOME: dir, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }));
    child.stdin.end(opts.stdin ?? '');
  });
}

let dir: string;
let socketPath: string;
let server: Server | null;
let received: HookEnvelope[];

/** 测试用的服务端：收一行；reply 不为 undefined 时回一行。 */
function listen(reply?: (e: HookEnvelope) => HookReply | null): Promise<void> {
  server = createServer((sock: Socket) => {
    let buf = '';
    sock.on('data', (c) => {
      buf += c.toString();
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const env = JSON.parse(buf.slice(0, nl)) as HookEnvelope;
      received.push(env);
      const r = reply?.(env);
      if (r) sock.write(`${JSON.stringify(r)}\n`);
    });
  });
  return new Promise((resolve) => server!.listen(socketPath, resolve));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'adn-'));
  socketPath = join(dir, 'h.sock');
  server = null;
  received = [];
});

afterEach(async () => {
  if (server) await new Promise((r) => server!.close(r));
  rmSync(dir, { recursive: true, force: true });
});

const baseEnv = () => ({ [TERMINAL_ID_ENV]: 'term-1', AGENTDECK_HOOK_SOCKET: socketPath });

describe('agentdeck-notify', () => {
  it('uses the same constants as contracts', () => {
    expect(notify.HOOK_SOCKET).toBe(HOOK_SOCKET);
    expect(notify.TERMINAL_ID_ENV).toBe(TERMINAL_ID_ENV);
    expect(notify.REPLY_TIMEOUT_MS).toBe(2000);
  });

  it('sends one HookEnvelope line with the stdin payload and the terminal id', async () => {
    await listen();
    const r = await run(['claude', 'Stop'], { env: baseEnv(), stdin: '{"session_id":"s1","hook_event_name":"Stop"}\n' });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(received).toHaveLength(1);
    const e = received[0]!;
    expect(e).toMatchObject({
      v: 1,
      terminalId: 'term-1',
      agent: 'claude',
      hookName: 'Stop',
      payload: { session_id: 's1', hook_event_name: 'Stop' },
      expectsReply: false,
    });
    expect(Number.isNaN(Date.parse(e.at))).toBe(false);
  });

  it('defaults to ~/.agentdeck/run/hooks.sock under HOME', async () => {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, '.agentdeck/run'), { recursive: true });
    socketPath = join(dir, HOOK_SOCKET);
    await listen();
    await run(['codex', 'UserPromptSubmit'], { env: { [TERMINAL_ID_ENV]: 'term-2' }, stdin: '{}' });
    expect(received.map((e) => e.terminalId)).toEqual(['term-2']);
  });

  it('PermissionRequest waits for the reply and prints allow in the agent format', async () => {
    await listen(() => ({ v: 1, decision: 'allow' }));
    const r = await run(['claude', 'PermissionRequest'], { env: baseEnv(), stdin: '{"tool_name":"Bash"}' });
    expect(received[0]?.expectsReply).toBe(true);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
  });

  it('prints nothing when the reply is none', async () => {
    await listen(() => ({ v: 1, decision: 'none' }));
    const r = await run(['codex', 'PermissionRequest'], { env: baseEnv(), stdin: '{}' });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('gives up after 2 seconds without a reply, quietly', async () => {
    await listen(() => null);
    const r = await run(['claude', 'PermissionRequest'], { env: baseEnv(), stdin: '{}' });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.ms).toBeGreaterThanOrEqual(1900);
    expect(r.ms).toBeLessThan(4000);
  });

  it('exits 0 quickly and silently when nothing is listening', async () => {
    const r = await run(['claude', 'PermissionRequest'], { env: baseEnv(), stdin: '{}' });
    expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(r.ms).toBeLessThan(1500);
  });

  it('does nothing outside an AgentDeck terminal (no AGENTDECK_TERM)', async () => {
    await listen();
    const r = await run(['claude', 'Stop'], { env: { AGENTDECK_HOOK_SOCKET: socketPath }, stdin: '{}' });
    expect(r.code).toBe(0);
    expect(received).toHaveLength(0);
  });

  it('takes the payload from the last argument (legacy codex notify)', async () => {
    await listen();
    await run(['codex', 'notify', '{"type":"agent-turn-complete","thread-id":"t1"}'], { env: baseEnv() });
    expect(received[0]).toMatchObject({ hookName: 'notify', payload: { type: 'agent-turn-complete', 'thread-id': 't1' } });
  });

  it('passes non-JSON stdin through as a string', async () => {
    await listen();
    await run(['claude', 'Stop'], { env: baseEnv(), stdin: 'not json' });
    expect(received[0]?.payload).toBe('not json');
  });

  it('only PermissionRequest of claude and codex expects a reply', () => {
    expect(notify.expectsReply('claude', 'PermissionRequest')).toBe(true);
    expect(notify.expectsReply('codex', 'PermissionRequest')).toBe(true);
    expect(notify.expectsReply('claude', 'Stop')).toBe(false);
    expect(notify.expectsReply('gemini', 'PermissionRequest')).toBe(false);
    expect(notify.replyToStdout('claude', 'Stop', { v: 1, decision: 'allow' })).toBeNull();
  });
});
