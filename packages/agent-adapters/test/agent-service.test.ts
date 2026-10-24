import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentDeckError } from '@agentdeck/contracts';
import type { AgentSessionId, StartAgentRequest } from '@agentdeck/contracts';
import { FakeTerminalHost } from '@agentdeck/fakes';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDefaultAdapters } from '../src/adapters/index.ts';
import { AgentServiceImpl } from '../src/agent-service.ts';
import type { StartedAgent } from '../src/agent-service.ts';

let bin: string;
let terminals: FakeTerminalHost;
let started: StartedAgent[];

beforeAll(() => {
  bin = mkdtempSync(join(tmpdir(), 'ads-'));
  for (const [name, out] of [
    ['claude', '2.1.291 (Claude Code)'],
    ['pnpm', '10.0.0'],
  ]) {
    writeFileSync(join(bin, name!), `#!/bin/sh\necho "${out}"\n`);
    chmodSync(join(bin, name!), 0o755);
  }
});
afterAll(() => rmSync(bin, { recursive: true, force: true }));
afterEach(() => terminals?.dispose());

function service(env: Record<string, string> = { PATH: bin, SHELL: '/bin/sh' }) {
  terminals = new FakeTerminalHost({ silenceMs: 0 });
  started = [];
  return new AgentServiceImpl({
    adapters: createDefaultAdapters({ env: () => env }),
    terminals,
    env: () => env,
    notifyCommand: '/opt/agentdeck/agentdeck-notify',
    extraArgs: (agent) => (agent === 'claude' ? ['--model', 'opus'] : []),
    onStarted: (s) => started.push(s),
  });
}

const req = (over: Partial<StartAgentRequest>): StartAgentRequest => ({
  agent: 'claude',
  cwd: '/repo',
  workspaceId: null,
  mode: { kind: 'new' },
  ...over,
});

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof AgentDeckError ? e.code : String(e);
  }
}

describe('AgentServiceImpl', () => {
  it('lists registered agents with install state and capabilities', async () => {
    const list = await service().list();
    expect(list.map((a) => [a.id, a.installed, a.version])).toEqual([
      ['claude', true, '2.1.291'],
      ['codex', false, null],
      ['pi', false, null],
      ['omp', false, null],
      ['kimi', false, null],
      ['shell', true, null],
      ['custom', true, null],
    ]);
    expect(list[0]!.capabilities).toEqual({ hooks: true, resume: true, fork: true, askTool: true });
  });

  it('refresh() re-detects with the current environment', async () => {
    let env: Record<string, string> = { PATH: '/nowhere' };
    terminals = new FakeTerminalHost();
    const s = new AgentServiceImpl({
      adapters: createDefaultAdapters({ env: () => env }),
      terminals,
      env: () => env,
      notifyCommand: '/n',
    });
    expect((await s.list())[0]!.installed).toBe(false);
    env = { PATH: bin };
    expect((await s.list())[0]!.installed).toBe(false); // 缓存
    expect((await s.refresh())[0]!.installed).toBe(true);
  });

  it('start: builds the launch spec and creates the terminal with it, passing size through', async () => {
    const s = service();
    const res = await s.start(req({ size: { cols: 120, rows: 40 }, workspaceId: 'ws' as never }));
    const t = terminals.get(res.terminalId);
    expect(t.request.cmd).toBe('claude');
    expect(t.request.args).toEqual(res.args);
    expect(t.request.cwd).toBe('/repo');
    expect(t.size).toEqual({ cols: 120, rows: 40 });
    expect(t.env).toMatchObject({ CLAUDE_CODE_TMUX_TRUECOLOR: '1', AGENTDECK_TERM: res.terminalId });
    expect(res.args).toContain('--settings');
    expect(res.args.slice(-2)).toEqual(['--model', 'opus']);
    expect(res.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(started).toEqual([{ terminalId: res.terminalId, agent: 'claude', workspaceId: 'ws', hooks: true, sessionId: res.sessionId }]);
  });

  it('start: resume keeps the session id', async () => {
    const res = await service().start(req({ mode: { kind: 'resume', sessionId: 'abc' as AgentSessionId } }));
    expect(res.sessionId).toBe('abc');
    expect(res.args.slice(0, 2)).toEqual(['--resume', 'abc']);
  });

  it('start: shell and custom commands', async () => {
    const s = service();
    const sh = await s.start(req({ agent: 'shell', command: 'pnpm dev' }));
    expect([sh.cmd, sh.args]).toEqual(['/bin/sh', ['-l', '-c', 'pnpm dev']]);
    expect(started.at(-1)!.hooks).toBe(false);
    const custom = await s.start(req({ agent: 'custom', command: 'pnpm run "dev server"' }));
    expect([custom.cmd, custom.args]).toEqual(['pnpm', ['run', 'dev server']]);
  });

  it('start: errors use contract codes and English messages', async () => {
    const s = service();
    expect(await code(s.start(req({ agent: 'codex' })))).toBe('command-not-found');
    await expect(s.start(req({ agent: 'codex' }))).rejects.toThrow('Command not found: codex');
    expect(await code(s.start(req({ agent: 'gemini' })))).toBe('not-found');
    expect(await code(s.start(req({ agent: 'custom', command: 'nope-not-here' })))).toBe('command-not-found');
    expect(await code(s.start(req({ agent: 'custom', command: '' })))).toBe('invalid-argument');
    expect(await code(s.start(req({ agent: 'shell', mode: { kind: 'fork', sessionId: 'x' as AgentSessionId } })))).toBe(
      'unsupported',
    );
    await expect(s.start(req({ agent: 'shell', mode: { kind: 'resume', sessionId: 'x' as AgentSessionId } }))).rejects.toThrow(
      "Shell can't resume a conversation",
    );
    expect(terminals.views()).toEqual([]);
    expect((await terminals.list()).length).toBe(0);
  });

  it('start: uses prepare() and records whether hooks really got injected', async () => {
    const env = { PATH: bin };
    terminals = new FakeTerminalHost();
    started = [];
    const claude = createDefaultAdapters({ env: () => env })[0]!;
    const s = new AgentServiceImpl({
      adapters: [Object.assign(Object.create(claude), { prepare: async () => ({ hooks: false }) })],
      terminals,
      env: () => env,
      notifyCommand: '/n',
      onStarted: (x) => started.push(x),
    });
    await s.start(req({}));
    expect(started[0]!.hooks).toBe(false);
  });
});
