// 已知 agent 表和通用适配器（X13）：检测（假 PATH 里放假的可执行文件）、能力、每种模式的启动参数、钩子解析，
// 以及 pi / omp 扩展的端到端：扩展事件 → 真的 agentdeck-notify 子进程 → HookServer → 状态机。

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentDeckError } from '@agentdeck/contracts';
import type { AgentSessionId, CreateTerminalRequest, LaunchContext, StatusEvent, TerminalId } from '@agentdeck/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { KnownAgentAdapter } from '../src/adapters/generic.ts';
import { createDefaultAdapters } from '../src/adapters/index.ts';
import type { KnownAgent } from '../src/adapters/known.ts';
import { EXTENSION_ENV, KNOWN_AGENTS } from '../src/adapters/known.ts';
import { MCP_URL_ENV, mcpPluginFiles } from '../src/adapters/mcp-plugin.ts';
import { createAgentRuntime } from '../src/runtime.ts';

const NOTIFY_SCRIPT = fileURLToPath(new URL('../../../tools/agentdeck-notify/bin/agentdeck-notify.mjs', import.meta.url));
const EXTENSION = fileURLToPath(new URL('../../../tools/agentdeck-notify/bin/agentdeck-pi-extension.mjs', import.meta.url));
const NOTIFY = '/Applications/Agent Deck.app/notify/agentdeck-notify';

/** 只记下 create 请求的终端宿主：这里只关心启动了什么命令、带了什么环境。 */
function recordingHost() {
  const created: CreateTerminalRequest[] = [];
  return {
    created,
    create: async (req: CreateTerminalRequest) => {
      created.push(req);
      return { id: `term-${created.length}` as TerminalId };
    },
  };
}

function def(id: string): KnownAgent {
  const d = KNOWN_AGENTS.find((a) => a.id === id);
  if (!d) throw new Error(`no ${id}`);
  return d;
}

function ctx(mode: LaunchContext['mode'] = { kind: 'new' }, extraArgs: string[] = []): LaunchContext {
  return { cwd: '/repo', terminalId: 'pending' as TerminalId, mode, notifyCommand: NOTIFY, extraArgs };
}

/** 假 PATH：pi、omp、kimi 打印各自真实的 --version 输出（2026-10-24 本机抓的）。 */
let bin: string;
beforeAll(() => {
  bin = mkdtempSync(join(tmpdir(), 'adk-'));
  for (const [name, out] of [
    ['pi', '0.83.0'],
    ['omp', 'omp/18.0.4'],
    ['kimi', '0.29.1'],
  ]) {
    const p = join(bin, name!);
    writeFileSync(p, `#!/bin/sh\necho "${out}"\n`);
    chmodSync(p, 0o755);
  }
});
afterAll(() => rmSync(bin, { recursive: true, force: true }));

describe('known agents table', () => {
  it('registers pi, omp and kimi with English labels', () => {
    expect(KNOWN_AGENTS.map((a) => [a.id, a.label])).toEqual([
      ['pi', 'Pi'],
      ['omp', 'Oh My Pi'],
      ['kimi', 'Kimi'],
    ]);
  });

  it('default adapters: claude, codex, the known agents, then shell and custom', () => {
    expect(createDefaultAdapters({ env: () => ({}) }).map((a) => a.id)).toEqual(['claude', 'codex', 'pi', 'omp', 'kimi', 'shell', 'custom']);
  });

  it('detects each command on the given PATH and reads its version', async () => {
    const env = () => ({ PATH: bin });
    expect(await new KnownAgentAdapter(def('pi'), { env }).detect()).toEqual({ installed: true, version: '0.83.0', path: join(bin, 'pi') });
    expect(await new KnownAgentAdapter(def('omp'), { env }).detect()).toEqual({ installed: true, version: '18.0.4', path: join(bin, 'omp') });
    expect(await new KnownAgentAdapter(def('kimi'), { env }).detect()).toEqual({ installed: true, version: '0.29.1', path: join(bin, 'kimi') });
    expect(await new KnownAgentAdapter(def('pi'), { env: () => ({ PATH: '/nonexistent' }) }).detect()).toEqual({
      installed: false,
      version: null,
      path: null,
    });
  });

  it('tries the command names in order and launches the one it found', async () => {
    const adapter = new KnownAgentAdapter({ ...def('kimi'), commands: ['kimi-code', 'kimi'] }, { env: () => ({ PATH: bin }) });
    expect(adapter.command).toBe('kimi-code');
    expect((await adapter.detect()).installed).toBe(true);
    expect(adapter.launch(ctx()).cmd).toBe('kimi');
  });

  it('lists through AgentService with labels and capabilities', async () => {
    const rt = createAgentRuntime({
      env: () => ({ PATH: bin }),
      terminals: recordingHost(),
      notifyCommand: NOTIFY,
      agentExtension: EXTENSION,
      emit: () => {},
      destructivePatterns: () => [],
      socketPath: join(bin, 'unused.sock'),
    });
    const list = await rt.agents.list();
    const pick = (id: string) => list.find((a) => a.id === id);
    expect(pick('pi')).toMatchObject({
      id: 'pi',
      label: 'Pi',
      installed: true,
      version: '0.83.0',
      capabilities: { hooks: true, resume: true, fork: true, askTool: false },
    });
    // AH0 / AH3：能力报告跟着来，核对过的版本照声明
    expect(pick('pi')!.report).toMatchObject({ agent: 'pi', version: '0.83.0' });
    expect(pick('pi')!.report!.entries.find((e) => e.key === 'status')).toMatchObject({ level: 'yes', via: 'extension', verifiedUpTo: '0.83.0' });
    expect(pick('omp')?.capabilities).toEqual({ hooks: true, resume: true, fork: true, askTool: true });
    expect(pick('kimi')?.capabilities).toEqual({ hooks: false, resume: true, fork: false, askTool: false });
  });
});

describe('KnownAgentAdapter capabilities', () => {
  it('hooks only with the extension and a new enough version', () => {
    const env = () => ({});
    const pi = new KnownAgentAdapter(def('pi'), { env, agentExtension: EXTENSION });
    expect(pi.capabilities('0.83.0')).toEqual({ hooks: true, resume: true, fork: true, askTool: false });
    // AH3：读不出版本时不再当作够新（也没有 --help 可看）
    expect(pi.capabilities(null).hooks).toBe(false);
    // agent_settled 0.80.4 才有
    expect(pi.capabilities('0.79.0')).toEqual({ hooks: false, resume: true, fork: true, askTool: false });
    expect(new KnownAgentAdapter(def('pi'), { env }).capabilities('0.83.0').hooks).toBe(false);
    const omp = new KnownAgentAdapter(def('omp'), { env, agentExtension: EXTENSION });
    expect(omp.capabilities('18.0.4')).toEqual({ hooks: true, resume: true, fork: true, askTool: true });
    expect(new KnownAgentAdapter(def('omp'), { env }).capabilities('18.0.4').askTool).toBe(false);
  });
});

describe('KnownAgentAdapter launch', () => {
  const env = () => ({ PATH: bin });
  const ids = () => {
    let n = 0;
    return () => `new-${++n}`;
  };
  const extEnv = (agent: string, turnEnd: string) => ({
    [EXTENSION_ENV.notify]: NOTIFY,
    [EXTENSION_ENV.agent]: agent,
    [EXTENSION_ENV.turnEnd]: turnEnd,
  });

  it('pi: --session-id on new, --session on resume, --fork + --session-id on fork, extension via -e', async () => {
    const pi = new KnownAgentAdapter(def('pi'), { env, agentExtension: EXTENSION, newSessionId: ids() });
    await pi.detect();
    expect(pi.launch(ctx({ kind: 'new' }, ['--model', 'sonnet']))).toEqual({
      cmd: 'pi',
      args: ['--session-id', 'new-1', '-e', EXTENSION, '--model', 'sonnet'],
      env: extEnv('pi', 'agent_settled'),
      sessionId: 'new-1',
      consumed: { prompt: false },
    });
    expect(pi.launch(ctx({ kind: 'resume', sessionId: 'abc' as AgentSessionId }))).toMatchObject({
      args: ['--session', 'abc', '-e', EXTENSION],
      sessionId: 'abc',
    });
    expect(pi.launch(ctx({ kind: 'fork', sessionId: 'abc' as AgentSessionId }))).toMatchObject({
      args: ['--fork', 'abc', '--session-id', 'new-2', '-e', EXTENSION],
      sessionId: 'new-2',
    });
  });

  it('omp: session id comes later from the extension; --resume and --fork take the old id', async () => {
    const omp = new KnownAgentAdapter(def('omp'), { env, agentExtension: EXTENSION });
    await omp.detect();
    expect(omp.launch(ctx())).toEqual({ cmd: 'omp', args: ['-e', EXTENSION], env: extEnv('omp', 'agent_end'), sessionId: null, consumed: { prompt: false } });
    expect(omp.launch(ctx({ kind: 'resume', sessionId: 'abc' as AgentSessionId }))).toMatchObject({
      args: ['--resume', 'abc', '-e', EXTENSION],
      sessionId: 'abc',
    });
    expect(omp.launch(ctx({ kind: 'fork', sessionId: 'abc' as AgentSessionId }))).toMatchObject({
      args: ['--fork', 'abc', '-e', EXTENSION],
      sessionId: null,
    });
  });

  it('without the extension (or too old for it) there is no -e and no env', async () => {
    const pi = new KnownAgentAdapter(def('pi'), { env, newSessionId: ids() });
    await pi.detect();
    expect(pi.launch(ctx())).toEqual({ cmd: 'pi', args: ['--session-id', 'new-1'], sessionId: 'new-1', consumed: { prompt: false } });
    // 假 pi 是 0.83.0；换成一个只认更高版本的表行，模拟“版本太旧”
    const tooOld = new KnownAgentAdapter({ ...def('pi'), extension: { ...def('pi').extension!, minVersion: '9.0.0' } }, {
      env,
      agentExtension: EXTENSION,
      newSessionId: ids(),
    });
    await tooOld.detect();
    expect(tooOld.launch(ctx()).args).toEqual(['--session-id', 'new-1']);
  });

  it('kimi: no hooks, resume with -S, fork is unsupported', async () => {
    const kimi = new KnownAgentAdapter(def('kimi'), { env, agentExtension: EXTENSION });
    await kimi.detect();
    expect(kimi.launch(ctx({ kind: 'new' }, ['--yolo']))).toEqual({ cmd: 'kimi', args: ['--yolo'], sessionId: null, consumed: { prompt: false } });
    expect(kimi.launch(ctx({ kind: 'resume', sessionId: 's1' as AgentSessionId }))).toEqual({ cmd: 'kimi', args: ['-S', 's1'], sessionId: 's1', consumed: { prompt: false } });
    let err: unknown;
    try {
      kimi.launch(ctx({ kind: 'fork', sessionId: 's1' as AgentSessionId }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AgentDeckError);
    expect((err as AgentDeckError).code).toBe('unsupported');
    expect((err as AgentDeckError).message).toBe("Kimi can't fork a conversation");
  });
});

describe('KnownAgentAdapter parseHook', () => {
  const omp = new KnownAgentAdapter(def('omp'), { env: () => ({}) });
  it('reads the claude-style hooks the extension sends, plus Question', () => {
    expect(omp.parseHook('SessionStart', { session_id: 's1' })).toEqual({ type: 'session-start', sessionId: 's1' });
    expect(omp.parseHook('UserPromptSubmit', {})).toEqual({ type: 'prompt-submitted' });
    expect(omp.parseHook('PermissionRequest', { tool_name: 'bash', tool_input: { command: 'rm -rf build' } })).toEqual({
      type: 'permission-request',
      tool: 'bash',
      summary: 'rm -rf build',
      command: 'rm -rf build',
    });
    expect(omp.parseHook('Question', { question: 'Which color?\nmore' })).toEqual({ type: 'question', summary: 'Which color?' });
    expect(omp.parseHook('Question', {})).toEqual({ type: 'question', summary: 'Question' });
    expect(omp.parseHook('Stop', {})).toEqual({ type: 'turn-end' });
    expect(omp.parseHook('SessionEnd', {})).toEqual({ type: 'session-end' });
    expect(omp.parseHook('agent_end', {})).toBeNull();
  });
});

describe('pi / omp extension end to end', () => {
  type Handler = (event: unknown, ctx: unknown) => void;

  it('extension events reach the status machine through agentdeck-notify', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adx-'));
    const socketPath = join(dir, 'hooks.sock');
    // 和 apps/desktop 生成的入口一样：sh 包装脚本，带上 socket 路径
    const wrapper = join(dir, 'agentdeck-notify');
    writeFileSync(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${NOTIFY_SCRIPT}' "$@"\n`);
    chmodSync(wrapper, 0o755);

    const events: StatusEvent[] = [];
    const host = recordingHost();
    const rt = createAgentRuntime({
      env: () => ({ PATH: bin }),
      terminals: host,
      notifyCommand: wrapper,
      agentExtension: EXTENSION,
      emit: (e) => events.push(e),
      destructivePatterns: () => ['rm -rf'],
      socketPath,
    });
    await rt.start();
    try {
      const res = await rt.agents.start({ agent: 'omp', cwd: '/repo', workspaceId: null, mode: { kind: 'new' } });
      const spec = host.created[0]!;
      expect(spec.args).toEqual(['-e', EXTENSION]);

      // 像 omp 一样加载扩展：环境是 tmux 窗格的环境（LaunchSpec.env + AGENTDECK_TERM）
      const handlers = new Map<string, Handler>();
      const mod = (await import(EXTENSION)) as { default: (api: unknown, env: Record<string, string>) => void };
      mod.default(
        { on: (name: string, h: Handler) => handlers.set(name, h) },
        { ...spec.env, PATH: process.env.PATH ?? '', HOME: dir, AGENTDECK_HOOK_SOCKET: socketPath, AGENTDECK_TERM: res.terminalId },
      );
      const fire = (name: string, event: unknown = {}) =>
        handlers.get(name)!(event, { sessionManager: { getSessionId: () => 'omp-session-1' } });
      const status = () => rt.status.get(res.terminalId);

      fire('session_start');
      await vi.waitFor(() => expect(status()).toMatchObject({ status: 'idle', sessionId: 'omp-session-1' }), { timeout: 5000 });
      fire('agent_start');
      await vi.waitFor(() => expect(status()?.status).toBe('running'), { timeout: 5000 });
      fire('tool_call', { toolName: 'bash', toolCallId: 'c1', input: { command: 'rm -rf build' } });
      fire('tool_approval_requested', { toolName: 'bash', toolCallId: 'c1', sessionId: 'omp-session-1', approvalMode: 'always-ask' });
      await vi.waitFor(() => expect(status()?.status).toBe('needs-approval'), { timeout: 5000 });
      expect(status()?.pending).toMatchObject({ kind: 'approval', summary: 'rm -rf build', destructive: true });
      fire('tool_approval_resolved', { toolName: 'bash', toolCallId: 'c1', approved: true });
      await vi.waitFor(() => expect(status()?.status).toBe('running'), { timeout: 5000 });
      fire('tool_call', { toolName: 'ask', toolCallId: 'c2', input: { questions: [{ id: 'q', question: 'Which color?', options: [] }] } });
      await vi.waitFor(() => expect(status()).toMatchObject({ status: 'needs-reply', pending: { kind: 'question', summary: 'Which color?' } }), {
        timeout: 5000,
      });
      fire('tool_result', { toolName: 'ask', toolCallId: 'c2' });
      await vi.waitFor(() => expect(status()?.status).toBe('running'), { timeout: 5000 });
      fire('agent_end', { willContinue: true }); // omp 还要自动重试，不算一轮结束
      fire('agent_settled'); // omp 没有这个事件；就算来了也不该当成一轮结束
      fire('agent_end', { willContinue: false });
      await vi.waitFor(() => expect(status()?.status).toBe('idle'), { timeout: 5000 });
      expect(events.filter((e) => e.type === 'agent.turn-end')).toHaveLength(1);
    } finally {
      await rt.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe('AgentDeck MCP for the known agents (N1)', () => {
  const env = () => ({ PATH: bin });
  const mcp = { url: 'http://127.0.0.1:47621/mcp', token: 'secret-token' };
  const PLUGIN_DIR = '/Users/me/.agentdeck/mcp-plugin';

  it('omp: --plugin-dir with our plugin folder; url and token only in env', async () => {
    const omp = new KnownAgentAdapter(def('omp'), { env, agentExtension: EXTENSION, mcpPluginDir: PLUGIN_DIR });
    await omp.detect();
    const spec = omp.launch({ ...ctx({ kind: 'new' }, ['--model', 'x']), mcp });
    expect(spec.args).toEqual(['-e', EXTENSION, '--plugin-dir', PLUGIN_DIR, '--model', 'x']);
    expect(spec.env).toMatchObject({ [MCP_URL_ENV]: mcp.url, AGENTDECK_MCP_TOKEN: 'secret-token', [EXTENSION_ENV.agent]: 'omp' });
    expect(spec.args.join(' ')).not.toContain('secret-token');
    // resume 也挂
    expect(omp.launch({ ...ctx({ kind: 'resume', sessionId: 'abc' as AgentSessionId }), mcp }).args).toEqual([
      '--resume',
      'abc',
      '-e',
      EXTENSION,
      '--plugin-dir',
      PLUGIN_DIR,
    ]);
    // 没有 MCP（服务没起来）或没有插件目录时不挂
    expect(omp.launch(ctx()).args).toEqual(['-e', EXTENSION]);
    const noDir = new KnownAgentAdapter(def('omp'), { env });
    await noDir.detect();
    expect(noDir.launch({ ...ctx(), mcp })).toEqual({ cmd: 'omp', args: [], sessionId: null, consumed: { prompt: false } });
  });

  it('omp without hooks still gets the MCP (env without the extension variables)', async () => {
    const omp = new KnownAgentAdapter(def('omp'), { env, mcpPluginDir: PLUGIN_DIR });
    await omp.detect();
    expect(omp.launch({ ...ctx(), mcp })).toEqual({
      cmd: 'omp',
      args: ['--plugin-dir', PLUGIN_DIR],
      env: { [MCP_URL_ENV]: mcp.url, AGENTDECK_MCP_TOKEN: 'secret-token' },
      sessionId: null,
      consumed: { prompt: false },
    });
  });

  it('pi and kimi cannot take it at launch: nothing added', async () => {
    for (const id of ['pi', 'kimi']) {
      expect(def(id).mcp).toBeNull();
      const a = new KnownAgentAdapter(def(id), { env, mcpPluginDir: PLUGIN_DIR, newSessionId: () => 'n1' });
      await a.detect();
      const spec = a.launch({ ...ctx(), mcp });
      expect(spec.args).not.toContain('--plugin-dir');
      expect(spec.env).toBeUndefined();
    }
  });

  it('the plugin folder is fixed content: the manifest only refers to env vars', () => {
    const files = mcpPluginFiles();
    expect(Object.keys(files)).toEqual(['.claude-plugin/plugin.json']);
    const manifest = JSON.parse(files['.claude-plugin/plugin.json']!);
    expect(manifest.name).toBe('agentdeck');
    expect(manifest.mcpServers).toEqual({
      agentdeck: {
        type: 'http',
        url: '${AGENTDECK_MCP_URL}',
        headers: { Authorization: 'Bearer ${AGENTDECK_MCP_TOKEN}', 'x-agentdeck-terminal': '${AGENTDECK_TERM}' },
      },
    });
  });

  it('createAgentRuntime passes the plugin folder to omp', async () => {
    const host = recordingHost();
    const rt = createAgentRuntime({
      env,
      terminals: host,
      notifyCommand: NOTIFY,
      mcpPluginDir: PLUGIN_DIR,
      mcp: () => mcp,
      emit: () => {},
      destructivePatterns: () => [],
    });
    await rt.agents.start({ agent: 'omp', cwd: '/repo', workspaceId: null, mode: { kind: 'new' } });
    expect(host.created[0]!.args).toEqual(['--plugin-dir', PLUGIN_DIR]);
    expect(host.created[0]!.env).toMatchObject({ [MCP_URL_ENV]: mcp.url });
  });
});
