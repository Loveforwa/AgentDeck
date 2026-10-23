// 钩子 socket 端到端：真的 agentdeck-notify 子进程 → HookServer → 状态机。

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StatusEvent, TerminalId } from '@agentdeck/contracts';
import { FakeTerminalHost } from '@agentdeck/fakes';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../src/adapters/claude.ts';
import { HookServer, parseEnvelope } from '../src/hook-server.ts';
import type { ReceivedHook } from '../src/hook-server.ts';
import { createAgentRuntime } from '../src/runtime.ts';
import * as fx from './fixtures.ts';

const NOTIFY = fileURLToPath(new URL('../../../tools/agentdeck-notify/bin/agentdeck-notify.mjs', import.meta.url));

let dir: string;
let socketPath: string;
let server: HookServer | null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'adh-'));
  socketPath = join(dir, 'run', 'hooks.sock');
  server = null;
});
afterEach(async () => {
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
});

function notify(terminalId: string, agent: string, hookName: string, payload: unknown): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [NOTIFY, agent, hookName], {
      env: { PATH: process.env.PATH ?? '', HOME: dir, AGENTDECK_TERM: terminalId, AGENTDECK_HOOK_SOCKET: socketPath },
    });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.on('close', () => resolve(out));
    child.stdin.end(JSON.stringify(payload));
  });
}

describe('HookServer', () => {
  it('creates the socket directory and a socket only the user can open', async () => {
    server = new HookServer({ socketPath, adapterFor: () => undefined, onHook: () => undefined });
    await server.start();
    expect(statSync(join(dir, 'run')).mode & 0o777).toBe(0o700);
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
  });

  it('replaces a stale socket file left by a crash', async () => {
    const first = new HookServer({ socketPath, adapterFor: () => undefined, onHook: () => undefined });
    await first.start();
    // 模拟崩溃：不 close，直接再起一个
    server = new HookServer({ socketPath, adapterFor: () => undefined, onHook: () => undefined });
    await server.start();
    await first.close().catch(() => undefined);
  });

  it('parses each hook with the agent adapter and reports which terminal it came from', async () => {
    const got: ReceivedHook[] = [];
    const claude = new ClaudeAdapter({ env: () => ({}) });
    server = new HookServer({ socketPath, adapterFor: (a) => (a === 'claude' ? claude : undefined), onHook: (h) => got.push(h) });
    await server.start();
    await notify('term-7', 'claude', 'PermissionRequest', fx.claude.PermissionRequestBash);
    await notify('term-8', 'gemini', 'Whatever', {});
    expect(got.map((h) => [h.terminalId, h.agent, h.hookName, h.event])).toEqual([
      ['term-7', 'claude', 'PermissionRequest', { type: 'permission-request', tool: 'Bash', summary: 'mkdir agentdeck-probe', command: 'mkdir agentdeck-probe' }],
      ['term-8', 'gemini', 'Whatever', null],
    ]);
  });

  it('answers PermissionRequest: none by default, allow when decide says so', async () => {
    let decision: 'allow' | 'none' = 'none';
    server = new HookServer({
      socketPath,
      adapterFor: () => undefined,
      onHook: () => undefined,
      decide: () => decision,
    });
    await server.start();
    expect(await notify('t', 'claude', 'PermissionRequest', {})).toBe('');
    decision = 'allow';
    expect(JSON.parse(await notify('t', 'claude', 'PermissionRequest', {}))).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
  });

  it('a hook reaches the state machine well within 100ms of notify connecting', async () => {
    const events: StatusEvent[] = [];
    const rt = createAgentRuntime({
      env: () => ({ PATH: '/nowhere' }),
      terminals: new FakeTerminalHost(),
      notifyCommand: NOTIFY,
      emit: (e) => events.push(e),
      destructivePatterns: () => [],
      socketPath,
    });
    server = rt.hookServer;
    await rt.start();
    rt.status.track('term-1' as TerminalId, { agent: 'claude', workspaceId: null, hooks: true, status: 'idle' });
    // 直接用 socket 量传输延迟（不算 node 启动 notify 的时间）
    const t0 = performance.now();
    await new Promise<void>((resolve) => {
      const s = connect(socketPath, () => {
        s.write(
          `${JSON.stringify({ v: 1, terminalId: 'term-1', agent: 'claude', hookName: 'UserPromptSubmit', payload: {}, at: '', expectsReply: false })}\n`,
        );
      });
      const check = setInterval(() => {
        if (rt.status.get('term-1' as TerminalId)?.status === 'running') {
          clearInterval(check);
          s.destroy();
          resolve();
        }
      }, 1);
    });
    expect(performance.now() - t0).toBeLessThan(100);
    // 整条链：notify 子进程 → 状态机
    await notify('term-1', 'claude', 'PermissionRequest', fx.claude.PermissionRequestAsk);
    expect(rt.status.get('term-1' as TerminalId)).toMatchObject({ status: 'needs-reply', pending: { kind: 'question' } });
    await notify('term-1', 'claude', 'PostToolUse', fx.claude.PostToolUseAsk);
    expect(rt.status.get('term-1' as TerminalId)!.status).toBe('running');
    await notify('term-1', 'claude', 'Stop', fx.claude.Stop);
    expect(rt.status.get('term-1' as TerminalId)!.status).toBe('idle');
    expect(events.filter((e) => e.type === 'agent.turn-end')).toHaveLength(1);
  });

  it('ignores bad lines', async () => {
    const bad: string[] = [];
    const got: ReceivedHook[] = [];
    server = new HookServer({ socketPath, adapterFor: () => undefined, onHook: (h) => got.push(h), onBadMessage: (_l, r) => bad.push(r) });
    await server.start();
    await new Promise<void>((resolve) => {
      const s = connect(socketPath, () => s.end('nope\n{"v":2}\n'));
      s.on('close', () => resolve());
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(bad).toEqual(['not JSON', 'unsupported version 2']);
    expect(got).toEqual([]);
  });
});

describe('parseEnvelope', () => {
  it('validates required fields and defaults the rest', () => {
    expect(parseEnvelope('{"v":1,"terminalId":"t","agent":"claude"}')).toBe('missing hookName');
    expect(parseEnvelope('{"v":1,"terminalId":"t","agent":"claude","hookName":"Stop"}')).toMatchObject({
      payload: null,
      expectsReply: false,
    });
  });
});
