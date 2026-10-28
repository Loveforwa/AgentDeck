import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentDeckError, TERMINAL_KEY_ENV } from '@agentdeck/contracts';
import type { AgentSessionId, CreateTerminalRequest, StartAgentRequest, TerminalId } from '@agentdeck/contracts';
import { FakeTerminalHost } from '@agentdeck/fakes';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDefaultAdapters } from '../src/adapters/index.ts';
import { AgentServiceImpl } from '../src/agent-service.ts';
import type { StartedAgent } from '../src/agent-service.ts';
import { literalKeys } from '../src/first-message.ts';

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
    expect(started).toEqual([
      { terminalId: res.terminalId, agent: 'claude', workspaceId: 'ws', hooks: true, sessionId: res.sessionId, skills: null, watchHooks: 'startup', degraded: null },
    ]);
  });

  it('start: passes the prompt and the MCP endpoint to the adapter', async () => {
    const env = { PATH: bin, SHELL: '/bin/sh' };
    terminals = new FakeTerminalHost({ silenceMs: 0 });
    let endpoint: { url: string; token: string } | null = { url: 'http://127.0.0.1:1/mcp', token: 'tok' };
    const s = new AgentServiceImpl({
      adapters: createDefaultAdapters({ env: () => env }),
      terminals,
      env: () => env,
      notifyCommand: '/opt/agentdeck/agentdeck-notify',
      mcp: () => endpoint,
    });
    const res = await s.start(req({ prompt: 'write tests' }));
    expect(res.args).toContain('--mcp-config');
    expect(res.args.slice(-2)).toEqual(['--', 'write tests']);
    expect(terminals.get(res.terminalId).env).toMatchObject({ AGENTDECK_MCP_TOKEN: 'tok' });
    endpoint = null;
    expect((await s.start(req({}))).args).not.toContain('--mcp-config');
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

// X6：恢复上次会话时，白板按记下的会话 id 用 resume 重开每个 agent；Shell 不带命令重开，把上次的命令交给 prefill。
describe('AgentServiceImpl: restoring the last session (X6)', () => {
  let agentsBin: string;
  beforeAll(() => {
    agentsBin = mkdtempSync(join(tmpdir(), 'ads-x6-'));
    // 只打印版本（假的，不会真的启动 agent）。codex 用没有钩子的旧版本，免得 prepare() 去起 app-server。
    for (const [name, out] of [
      ['claude', '2.1.291 (Claude Code)'],
      ['codex', 'codex-cli 0.100.0'],
      ['pi', '0.83.0'],
      ['omp', 'omp/18.0.4'],
      ['kimi', '0.29.1'],
    ]) {
      writeFileSync(join(agentsBin, name!), `#!/bin/sh\necho "${out}"\n`);
      chmodSync(join(agentsBin, name!), 0o755);
    }
  });
  afterAll(() => rmSync(agentsBin, { recursive: true, force: true }));

  const resume = (sessionId: string): StartAgentRequest['mode'] => ({ kind: 'resume', sessionId: sessionId as AgentSessionId });

  it.each([
    ['claude', ['--resume', 's-claude']],
    ['codex', ['resume', 's-codex']],
    ['pi', ['--session', 's-pi']],
    ['omp', ['--resume', 's-omp']],
    ['kimi', ['-S', 's-kimi']],
  ] as const)('%s resumes the recorded conversation by id', async (agent, head) => {
    const s = service({ PATH: agentsBin, SHELL: '/bin/sh' });
    const res = await s.start(req({ agent, mode: resume(`s-${agent}`) }));
    expect(res.sessionId).toBe(`s-${agent}`);
    const i = res.args.indexOf(head[0]);
    expect(res.args.slice(i, i + 2)).toEqual([...head]);
    // 进了 tmux 的就是这条命令
    expect(terminals.get(res.terminalId).request.args).toEqual(res.args);
    expect(terminals.get(res.terminalId).request.prefill).toBeUndefined();
  });

  it('a shell reopens interactively with the last command handed to prefill, not run', async () => {
    const s = service();
    const sh = await s.start(req({ agent: 'shell', cwd: '/repo/web', prefill: 'pnpm dev' }));
    expect([sh.cmd, sh.args]).toEqual(['/bin/sh', ['-l']]);
    expect(terminals.get(sh.terminalId).request).toMatchObject({ cwd: '/repo/web', prefill: 'pnpm dev' });
  });

  it('prefill is ignored for agents and for a shell that runs a command', async () => {
    const s = service();
    const claude = await s.start(req({ agent: 'claude', prefill: 'rm -rf /' }));
    expect(terminals.get(claude.terminalId).request.prefill).toBeUndefined();
    const run = await s.start(req({ agent: 'shell', command: 'pnpm dev', prefill: 'pnpm dev' }));
    expect(terminals.get(run.terminalId).request.prefill).toBeUndefined();
  });
});

describe('AgentServiceImpl: per-terminal environment (CR15)', () => {
  let bin2: string;
  beforeAll(() => {
    bin2 = mkdtempSync(join(tmpdir(), 'ads-cr15-'));
    for (const [name, out] of [
      ['claude', '2.1.291 (Claude Code)'],
      ['pi', '0.83.0'],
      ['kimi', 'kimi, version 2.3.2'],
      ['pnpm', '10.0.0'],
    ]) {
      writeFileSync(join(bin2, name!), `#!/bin/sh\necho "${out}"\n`);
      chmodSync(join(bin2, name!), 0o755);
    }
  });
  afterAll(() => rmSync(bin2, { recursive: true, force: true }));

  const BIN = '/data/agentdeck/bin';
  const keyOf = (id: string) => `key-of-${id}`;

  /** 记下 create 的请求；照 contracts 用请求里的 id（FakeTerminalHost 不看 req.id）。 */
  function withStubHost(plain = false) {
    const env = { PATH: `${bin2}:/usr/bin`, SHELL: '/bin/sh' };
    const created: CreateTerminalRequest[] = [];
    const s = new AgentServiceImpl({
      adapters: createDefaultAdapters({ env: () => env }),
      terminals: { create: async (r) => (created.push(r), { id: r.id ?? ('t-host' as TerminalId) }) },
      env: () => env,
      notifyCommand: '/opt/agentdeck/agentdeck-notify',
      mcp: () => ({ url: 'http://127.0.0.1:1/mcp', token: 'shared-token' }),
      ...(plain ? {} : { terminalKey: keyOf, binDir: BIN }),
    });
    return { s, created };
  }

  it('every terminal gets the agentdeck bin dir first on PATH and its own key; the id is chosen before the key', async () => {
    const { s, created } = withStubHost();
    for (const r of [req({}), req({ agent: 'shell' }), req({ agent: 'custom', command: 'pnpm dev' }), req({ agent: 'pi' }), req({ agent: 'kimi' })]) {
      const res = await s.start(r);
      const c = created.at(-1)!;
      expect(c.id).toBe(res.terminalId);
      expect(res.terminalId).toMatch(/^t-[0-9a-f]{12}$/);
      expect(c.env?.[TERMINAL_KEY_ENV]).toBe(keyOf(res.terminalId));
      expect(c.env?.PATH).toBe(`${BIN}:${bin2}:/usr/bin`);
      // tmux 不认 -e PATH=：经 /usr/bin/env 设好 PATH 再 exec 原来的命令；返回给窗口的仍是原来的
      expect(c.cmd).toBe('/usr/bin/env');
      expect(c.args).toEqual([`PATH=${BIN}:${bin2}:/usr/bin`, res.cmd, ...res.args]);
      expect(res.cmd).not.toBe('/usr/bin/env');
    }
    expect(new Set(created.map((c) => c.id)).size).toBe(5);
  });

  it('the MCP config gets the terminal key instead of the shared token', async () => {
    const { s, created } = withStubHost();
    const res = await s.start(req({}));
    expect(res.args).toContain('--mcp-config');
    expect(created[0]!.env).toMatchObject({ AGENTDECK_MCP_TOKEN: keyOf(res.terminalId), AGENTDECK_TERM_KEY: keyOf(res.terminalId) });
    expect(JSON.stringify(created[0])).not.toContain('shared-token');
  });

  it('without terminalKey and binDir nothing changes (the host picks the id)', async () => {
    const { s, created } = withStubHost(true);
    const res = await s.start(req({ agent: 'shell' }));
    expect(res.terminalId).toBe('t-host');
    expect(created[0]!.id).toBeUndefined();
    expect(created[0]!.env).toBeUndefined();
  });
});

describe('AgentServiceImpl: the first message reaches every agent (AH1, IS-76)', () => {
  let agentsBin: string;
  beforeAll(() => {
    agentsBin = mkdtempSync(join(tmpdir(), 'ads-ah1-'));
    for (const [name, out] of [
      ['claude', '2.1.291 (Claude Code)'],
      ['codex', 'codex-cli 0.100.0'],
      ['pi', '0.83.0'],
      ['omp', 'omp/18.0.4'],
      ['kimi', '2.3.2'],
    ]) {
      writeFileSync(join(agentsBin, name!), `#!/bin/sh\necho "${out}"\n`);
      chmodSync(join(agentsBin, name!), 0o755);
    }
  });
  afterAll(() => rmSync(agentsBin, { recursive: true, force: true }));

  function withExtra(extra: string[] = ['--model', 'm1'], over: Partial<ConstructorParameters<typeof AgentServiceImpl>[0]> = {}) {
    const env = { PATH: agentsBin, SHELL: '/bin/sh' };
    terminals = new FakeTerminalHost({ silenceMs: 0 });
    started = [];
    return new AgentServiceImpl({
      adapters: createDefaultAdapters({ env: () => env }),
      terminals,
      env: () => env,
      notifyCommand: '/opt/agentdeck/agentdeck-notify',
      extraArgs: () => extra,
      onStarted: (s) => started.push(s),
      firstMessageTiming: { typeDelayMs: 0, readyMaxMs: 60_000 },
      ...over,
    });
  }
  const PROMPT = 'reply with the word PELICAN';

  it.each([
    ['claude', ['--model', 'm1', '--', PROMPT]],
    ['codex', ['--model', 'm1', '--', PROMPT]],
    // omp 认 `--`：之后都是消息
    ['omp', ['--model', 'm1', '--', PROMPT]],
    // pi 不认 `--`：消息放在用户参数前面，免得被不认识的 --flag 吃掉
    ['pi', [PROMPT, '--model', 'm1']],
  ] as const)('%s takes it as a launch argument', async (agent, tail) => {
    const s = withExtra();
    const res = await s.start(req({ agent, prompt: PROMPT }));
    expect(res.args.slice(-tail.length)).toEqual([...tail]);
    expect(terminals.get(res.terminalId).request.args).toEqual(res.args);
    expect(terminals.get(res.terminalId).keys).toEqual([]);
  });

  it('pi: a message starting with @ or - gets a leading space, so pi does not read it as a file or an option', async () => {
    const s = withExtra([]);
    expect((await s.start(req({ agent: 'pi', prompt: '@README.md fix it' }))).args.at(-1)).toBe(' @README.md fix it');
    expect((await s.start(req({ agent: 'pi', prompt: '--help me' }))).args.at(-1)).toBe(' --help me');
    // omp 有 `--`，照原文
    expect((await s.start(req({ agent: 'omp', prompt: '@README.md fix it' }))).args.slice(-2)).toEqual(['--', '@README.md fix it']);
  });

  it('kimi: not in the arguments; typed in when the terminal first goes quiet, then Enter', async () => {
    const s = withExtra([]);
    const res = await s.start(req({ agent: 'kimi', prompt: '@README.md reply with the word PELICAN' }));
    expect(res.args).toEqual([]);
    const id = res.terminalId;
    expect(terminals.get(id).keys).toEqual([]);
    terminals.feed(id, '╭──╮\n│ > │\n╰──╯\n');
    s.onTerminalEvent({ type: 'terminal.silence', id, at: new Date().toISOString() });
    await vi.waitFor(() => expect(terminals.get(id).keys).toEqual([['@README.md reply with the word PELICAN'], ['Enter']]));
    // 只打一次
    s.onTerminalEvent({ type: 'terminal.silence', id, at: new Date().toISOString() });
    await new Promise((r) => setTimeout(r, 10));
    expect(terminals.get(id).keys).toHaveLength(2);
  });

  it('kimi: waits while "Trust this folder?" is on screen (Enter would pick an option for you)', async () => {
    const s = withExtra([]);
    const { terminalId: id } = await s.start(req({ agent: 'kimi', prompt: PROMPT }));
    terminals.feed(id, '  Trust this folder?\n   ❯ Trust and continue\n     Exit\n');
    s.onTerminalEvent({ type: 'terminal.silence', id, at: new Date().toISOString() });
    await new Promise((r) => setTimeout(r, 20));
    expect(terminals.get(id).keys).toEqual([]);
    // 用户选了之后屏幕刷新（假终端里直接换掉输出），再次安静时打进去
    terminals.feed(id, `${'\n'.repeat(70)}╭──╮\n│ > │\n╰──╯\n`);
    s.onTerminalEvent({ type: 'terminal.silence', id, at: new Date().toISOString() });
    await vi.waitFor(() => expect(terminals.get(id).keys).toEqual([[PROMPT], ['Enter']]));
  });

  it('kimi: nothing is typed once the terminal has exited', async () => {
    const s = withExtra([]);
    const { terminalId: id } = await s.start(req({ agent: 'kimi', prompt: PROMPT }));
    s.onTerminalEvent({ type: 'terminal.exit', id, code: 1 });
    s.onTerminalEvent({ type: 'terminal.silence', id, at: new Date().toISOString() });
    await new Promise((r) => setTimeout(r, 10));
    expect(terminals.get(id).keys).toEqual([]);
  });

  it.each(['shell', 'custom'] as const)('%s cannot take one: unsupported, and no terminal is opened', async (agent) => {
    const s = withExtra([]);
    const p = s.start(req({ agent, prompt: PROMPT, ...(agent === 'custom' ? { command: 'pnpm dev' } : {}) }));
    await expect(p).rejects.toMatchObject({ code: 'unsupported' });
    await expect(p).rejects.toThrow(/^(Shell|Custom command) can't take a first message yet\. Open it without "prompt"/);
    expect(await terminals.list()).toEqual([]);
  });

  it('kimi without a way to type (no sendKeys) is unsupported too', async () => {
    const env = { PATH: agentsBin, SHELL: '/bin/sh' };
    const created: unknown[] = [];
    const s = new AgentServiceImpl({
      adapters: createDefaultAdapters({ env: () => env }),
      terminals: { create: async (r) => (created.push(r), { id: 't1' as never }) },
      env: () => env,
      notifyCommand: '/opt/agentdeck/agentdeck-notify',
    });
    expect(await code(s.start(req({ agent: 'kimi', prompt: PROMPT })))).toBe('unsupported');
    expect(created).toEqual([]);
  });

  it('resume and fork ignore the prompt as before (it only means something for a new conversation)', async () => {
    const s = withExtra([]);
    const res = await s.start(req({ agent: 'pi', prompt: PROMPT, mode: { kind: 'resume', sessionId: 'abc' as AgentSessionId } }));
    expect(res.args).not.toContain(PROMPT);
  });
});

describe('literalKeys', () => {
  it('sends text as characters: control characters become spaces, a trailing ; is escaped, single words that could be key names are split', () => {
    expect(literalKeys('fix the bug')).toEqual(['fix the bug']);
    expect(literalKeys('line one\nline two')).toEqual(['line one line two']);
    expect(literalKeys('do this; then that;')).toEqual(['do this; then that\\;']);
    expect(literalKeys('Enter')).toEqual(['E', 'n', 't', 'e', 'r']);
    expect(literalKeys('a;')).toEqual(['a', '\\;']);
    expect(literalKeys('')).toEqual([]);
  });
});
