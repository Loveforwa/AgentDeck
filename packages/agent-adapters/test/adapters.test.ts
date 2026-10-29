import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentDeckError } from '@agentdeck/contracts';
import type { AgentSessionId, LaunchContext, TerminalId } from '@agentdeck/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeAdapter, claudeHookSettings, claudeMcpConfig } from '../src/adapters/claude.ts';
import { CODEX_HOOK_EVENTS, CodexAdapter, codexHookOverrides, codexMcpOverrides, parseHooksList } from '../src/adapters/codex.ts';
import type { CodexTrustQuery } from '../src/adapters/codex.ts';
import { CustomCommandAdapter, ShellAdapter } from '../src/adapters/shell.ts';
import { hookHint } from '../src/hook-payload.ts';
import * as fx from './fixtures.ts';

const NOTIFY = '/Applications/Agent Deck.app/notify/agentdeck-notify';

function ctx(over: Partial<LaunchContext & { command: string }> = {}): LaunchContext & { command?: string } {
  return {
    cwd: '/repo',
    terminalId: 'pending' as TerminalId,
    mode: { kind: 'new' },
    notifyCommand: NOTIFY,
    extraArgs: [],
    ...over,
  };
}

/** 一个临时 bin 目录，放假的 claude / codex：打印版本号。 */
let bin: string;
/** 新版的 codex（0.165.0），钩子、MCP 都带。 */
let newBin: string;
beforeAll(() => {
  newBin = mkdtempSync(join(tmpdir(), 'adb-new-'));
  writeFileSync(join(newBin, 'codex'), '#!/bin/sh\necho "codex-cli 0.165.0"\n');
  chmodSync(join(newBin, 'codex'), 0o755);
  bin = mkdtempSync(join(tmpdir(), 'adb-'));
  for (const [name, out] of [
    ['claude', '2.1.291 (Claude Code)'],
    ['codex', 'codex-cli 0.150.0'],
  ]) {
    const p = join(bin, name!);
    writeFileSync(p, `#!/bin/sh\necho "${out}"\n`);
    chmodSync(p, 0o755);
  }
  mkdirSync(join(bin, 'notexec'));
});
afterAll(() => {
  rmSync(bin, { recursive: true, force: true });
  rmSync(newBin, { recursive: true, force: true });
});

describe('ClaudeAdapter', () => {
  const claude = new ClaudeAdapter({ env: () => ({ PATH: bin }), newSessionId: () => 'new-uuid' });

  it('detects the command on the given PATH and reads its version', async () => {
    expect(await claude.detect()).toEqual({ installed: true, version: '2.1.291', path: join(bin, 'claude') });
    expect(await new ClaudeAdapter({ env: () => ({ PATH: '/nonexistent' }) }).detect()).toEqual({
      installed: false,
      version: null,
      path: null,
    });
  });

  it('has hooks, resume, fork and the ask tool', () => {
    expect(claude.capabilities('2.1.291')).toEqual({ hooks: true, resume: true, fork: true, askTool: true });
    expect(claude.capabilities('1.0.0').hooks).toBe(false);
  });

  it('new: generates a session id and passes --session-id, hooks via --settings, truecolor env', () => {
    const spec = claude.launch(ctx({ extraArgs: ['--model', 'opus'] }));
    expect(spec.cmd).toBe('claude');
    expect(spec.sessionId).toBe('new-uuid');
    expect(spec.args.slice(0, 2)).toEqual(['--session-id', 'new-uuid']);
    expect(spec.args[2]).toBe('--settings');
    expect(JSON.parse(spec.args[3]!)).toEqual(claudeHookSettings(NOTIFY, '2.1.291'));
    // 主题跟着终端背景走，不用 ~/.claude.json 里给别的终端选的（IS-42）
    expect(JSON.parse(spec.args[3]!).theme).toBe('auto');
    expect(spec.args.slice(4)).toEqual(['--model', 'opus']);
    expect(spec.env).toEqual({ CLAUDE_CODE_TMUX_TRUECOLOR: '1' });
  });

  it('mcp: --mcp-config refers to the token and terminal through env vars; the token itself only goes into env', () => {
    const mcp = { url: 'http://127.0.0.1:47621/mcp', token: 'secret-token' };
    const spec = claude.launch(ctx({ mcp, extraArgs: ['--model', 'opus'] }));
    const i = spec.args.indexOf('--mcp-config');
    expect(i).toBeGreaterThan(0);
    expect(JSON.parse(spec.args[i + 1]!)).toEqual({
      mcpServers: {
        agentdeck: {
          type: 'http',
          url: 'http://127.0.0.1:47621/mcp',
          headers: { Authorization: 'Bearer ${AGENTDECK_MCP_TOKEN}', 'x-agentdeck-terminal': '${AGENTDECK_TERM}' },
        },
      },
    });
    expect(spec.args.join(' ')).not.toContain('secret-token');
    expect(spec.env).toEqual({ CLAUDE_CODE_TMUX_TRUECOLOR: '1', AGENTDECK_MCP_TOKEN: 'secret-token' });
    expect(claudeMcpConfig(mcp)).toEqual(JSON.parse(spec.args[i + 1]!));
    expect(claude.launch(ctx()).args).not.toContain('--mcp-config');
  });

  it('prompt: goes last after --, only for new conversations', () => {
    const spec = claude.launch(ctx({ prompt: '-fix the tests', extraArgs: ['--allowedTools', 'Bash'] }));
    expect(spec.args.slice(-4)).toEqual(['--allowedTools', 'Bash', '--', '-fix the tests']);
    const resumed = claude.launch(ctx({ prompt: 'hi', mode: { kind: 'resume', sessionId: 'old' as AgentSessionId } }));
    expect(resumed.args).not.toContain('hi');
  });

  it('resume: --resume <id>, same session id', () => {
    const spec = claude.launch(ctx({ mode: { kind: 'resume', sessionId: 'old' as AgentSessionId } }));
    expect(spec.args.slice(0, 2)).toEqual(['--resume', 'old']);
    expect(spec.sessionId).toBe('old');
  });

  it('fork: --resume <id> --fork-session with a new --session-id', () => {
    const spec = claude.launch(ctx({ mode: { kind: 'fork', sessionId: 'old' as AgentSessionId } }));
    expect(spec.args.slice(0, 5)).toEqual(['--resume', 'old', '--fork-session', '--session-id', 'new-uuid']);
    expect(spec.sessionId).toBe('new-uuid');
  });

  it('injects every hook with a shell-quoted notify command; PermissionRequest gets a longer timeout', () => {
    const { hooks } = claudeHookSettings(NOTIFY, '2.1.291');
    expect(Object.keys(hooks)).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'PermissionRequest',
      'PostToolUse',
      'Notification',
      'Stop',
      'SessionEnd',
      'StopFailure',
      'SubagentStart',
      'SubagentStop',
    ]);
    expect(hooks.Stop).toEqual([
      { hooks: [{ type: 'command', command: `'${NOTIFY}' claude Stop`, timeout: 3 }] },
    ]);
    expect((hooks.PermissionRequest as { hooks: { timeout: number }[] }[])[0]!.hooks[0]!.timeout).toBe(5);
    expect(Object.keys(claudeHookSettings(NOTIFY, '2.0.5').hooks)).not.toContain('StopFailure');
    expect(Object.keys(claudeHookSettings(NOTIFY, '2.0.5').hooks)).not.toContain('SubagentStart');
  });

  it('parses the real hook payloads', () => {
    expect(claude.parseHook('SessionStart', fx.claude.SessionStart)).toEqual({
      type: 'session-start',
      sessionId: 'c2874ef2-d753-4246-a52b-c4eec2e93598',
      reason: 'start',
    });
    // SE2：SessionStart 的 source 记成这一段对话的原因
    const id = 'c2874ef2-d753-4246-a52b-c4eec2e93598';
    for (const [source, reason] of [
      ['resume', 'resume'],
      ['clear', 'clear'],
      ['compact', 'compact'],
      ['something-new', 'unknown'],
    ] as const) {
      expect(claude.parseHook('SessionStart', { session_id: id, source })).toEqual({ type: 'session-start', sessionId: id, reason });
    }
    expect(claude.parseHook('SessionStart', { session_id: id })).toEqual({ type: 'session-start', sessionId: id });
    expect(claude.parseHook('UserPromptSubmit', fx.claude.UserPromptSubmit)).toEqual({ type: 'prompt-submitted' });
    expect(claude.parseHook('PermissionRequest', fx.claude.PermissionRequestBash)).toEqual({
      type: 'permission-request',
      tool: 'Bash',
      summary: 'mkdir agentdeck-probe',
      command: 'mkdir agentdeck-probe',
    });
    expect(claude.parseHook('PermissionRequest', fx.claude.PermissionRequestAsk)).toEqual({
      type: 'question',
      summary: 'Do you prefer tea or coffee?',
    });
    expect(claude.parseHook('PostToolUse', fx.claude.PostToolUseAsk)).toEqual({ type: 'prompt-submitted' });
    expect(claude.parseHook('Notification', fx.claude.NotificationPermission)).toBeNull();
    expect(claude.parseHook('Notification', { notification_type: 'elicitation_dialog', message: 'Pick a repo' })).toEqual({
      type: 'question',
      summary: 'Pick a repo',
    });
    expect(claude.parseHook('Stop', fx.claude.Stop)).toEqual({ type: 'turn-end' });
    expect(claude.parseHook('StopFailure', {})).toEqual({ type: 'turn-end' });
    expect(claude.parseHook('SessionEnd', fx.claude.SessionEnd)).toEqual({ type: 'session-end' });
    expect(claude.parseHook('SomethingNew', {})).toBeNull();
    expect(claude.parseHook('PermissionRequest', 'garbage')).toBeNull();
  });

  it('summarises tools without a command', () => {
    expect(claude.parseHook('PermissionRequest', { tool_name: 'Edit', tool_input: { file_path: '/repo/.env' } })).toMatchObject({
      summary: 'Edit /repo/.env',
      command: null,
    });
    expect(claude.parseHook('PermissionRequest', { tool_name: 'WebFetch', tool_input: { url: 'https://x.dev' } })).toMatchObject({
      summary: 'WebFetch https://x.dev',
    });
    expect(claude.parseHook('PermissionRequest', { tool_name: 'ExitPlanMode', tool_input: {} })).toEqual({
      type: 'question',
      summary: 'Approve the plan?',
    });
    const long = claude.parseHook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: `echo ${'x'.repeat(300)}\nls` } });
    expect(long?.type === 'permission-request' && long.summary.length).toBe(200);
  });

  it('hookHint gives the finished tool the same summary as its request', () => {
    expect(hookHint('PostToolUse', fx.claude.PostToolUseAsk)).toEqual({ afterTool: 'Do you prefer tea or coffee?' });
    expect(hookHint('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'pnpm test' } })).toEqual({ afterTool: 'pnpm test' });
    expect(hookHint('Stop', {})).toEqual({});
  });

  it('approves once with 1 (not Enter, which picks the highlighted row)', () => {
    expect(claude.approveOnceKeys).toEqual(['1']);
  });
});

describe('CodexAdapter', () => {
  const env = () => ({ PATH: bin });
  const envNew = () => ({ PATH: newBin });
  const allTrusted: CodexTrustQuery = async ({ overrides }) => {
    const commands = overrides.filter((_, i) => i % 2 === 1).map((o) => /command=("(?:[^"\\]|\\.)*")/.exec(o)![1]!).map((s) => JSON.parse(s) as string);
    return parseHooksList(fx.codex.hooksList(commands));
  };

  it('detects the version; hooks need 0.159', async () => {
    const codex = new CodexAdapter({ env });
    expect(await codex.detect()).toMatchObject({ installed: true, version: '0.150.0' });
    expect(codex.capabilities('0.150.0')).toEqual({ hooks: false, resume: true, fork: false, askTool: false });
    expect(codex.capabilities('0.159.2')).toEqual({ hooks: true, resume: true, fork: true, askTool: false });
  });

  it('prepare() asks codex for the hook hashes and launch() trusts exactly those', async () => {
    let seen: Parameters<CodexTrustQuery>[0] | null = null;
    const codex = new CodexAdapter({
      env: envNew,
      queryTrust: async (q) => {
        seen = q;
        return allTrusted(q);
      },
    });
    await codex.detect();
    expect(await codex.prepare(ctx())).toEqual({ hooks: true });
    expect(seen!.cwd).toBe('/repo');
    expect(seen!.overrides).toEqual(codexHookOverrides(NOTIFY));
    const spec = codex.launch(ctx({ extraArgs: ['--full-auto'] }));
    expect(spec.cmd).toBe('codex');
    expect(spec.sessionId).toBeNull();
    expect(spec.args.slice(0, CODEX_HOOK_EVENTS.length * 2)).toEqual(codexHookOverrides(NOTIFY));
    const state = spec.args[CODEX_HOOK_EVENTS.length * 2 + 1]!;
    expect(spec.args[CODEX_HOOK_EVENTS.length * 2]).toBe('-c');
    expect(state).toMatch(/^hooks\.state=\{"\/<session-flags>\/config\.toml:event0:0:0"=\{trusted_hash="sha256:0"\},/);
    expect(state).not.toContain('project');
    expect(spec.args.at(-1)).toBe('--full-auto');
  });

  it('the hook overrides are valid -c values with the notify command and a timeout', () => {
    const o = codexHookOverrides(NOTIFY);
    expect(o[0]).toBe('-c');
    expect(o[1]).toBe(`hooks.SessionStart=[{hooks=[{type="command",command="'${NOTIFY}' codex SessionStart",timeout=3}]}]`);
    expect(o.find((x) => x.startsWith('hooks.PermissionRequest'))).toContain('timeout=5');
    expect(o.filter((x) => x === '-c')).toHaveLength(CODEX_HOOK_EVENTS.length);
  });

  it('resume and fork put the subcommand first', async () => {
    const codex = new CodexAdapter({ env, queryTrust: allTrusted });
    await codex.prepare(ctx());
    const r = codex.launch(ctx({ mode: { kind: 'resume', sessionId: 'th-1' as AgentSessionId } }));
    expect(r.args.slice(0, 2)).toEqual(['resume', 'th-1']);
    expect(r.sessionId).toBe('th-1');
    const f = codex.launch(ctx({ mode: { kind: 'fork', sessionId: 'th-1' as AgentSessionId } }));
    // X4：-C 写明新目录，不然从别的 worktree fork 时 TUI 先问用哪个目录、默认是原来的（0.164.0 实测）
    expect(f.args.slice(0, 4)).toEqual(['fork', '-C', '/repo', 'th-1']);
    expect(f.sessionId).toBeNull();
  });

  it('prompt: positional after --, after the MCP overrides and the user’s args', () => {
    const codex = new CodexAdapter({ env, queryTrust: allTrusted });
    const spec = codex.launch(ctx({ prompt: 'review this', extraArgs: ['--full-auto'], mcp: { url: 'http://x/mcp', token: 't' } }));
    expect(spec.args.slice(-3)).toEqual(['--full-auto', '--', 'review this']);
  });

  it('mcp (N1): -c mcp_servers.agentdeck with env var names only; the token goes into env', async () => {
    const mcp = { url: 'http://127.0.0.1:47621/mcp', token: 'secret-token' };
    const codex = new CodexAdapter({ env: envNew, queryTrust: allTrusted });
    await codex.detect();
    const spec = codex.launch(ctx({ mcp }));
    const overrides = codexMcpOverrides(mcp);
    // 0.164.0 用临时 CODEX_HOME 实测 `codex mcp get agentdeck --json` 认出的就是这三条
    expect(overrides).toEqual([
      '-c',
      'mcp_servers.agentdeck.url="http://127.0.0.1:47621/mcp"',
      '-c',
      'mcp_servers.agentdeck.bearer_token_env_var="AGENTDECK_MCP_TOKEN"',
      '-c',
      'mcp_servers.agentdeck.env_http_headers={"x-agentdeck-terminal"="AGENTDECK_TERM"}',
    ]);
    const at = spec.args.indexOf(overrides[1]!);
    expect(spec.args.slice(at - 1, at + 5)).toEqual(overrides);
    expect(spec.args.join(' ')).not.toContain('secret-token');
    expect(spec.env).toEqual({ AGENTDECK_MCP_TOKEN: 'secret-token' });
    // 没有 MCP 时不加
    const plain = codex.launch(ctx());
    expect(plain.args.join(' ')).not.toContain('mcp_servers');
    expect(plain.env).toBeUndefined();
    // resume 也挂
    const resumed = codex.launch(ctx({ mcp, mode: { kind: 'resume', sessionId: 'th-1' as AgentSessionId } }));
    expect(resumed.args.slice(0, 2)).toEqual(['resume', 'th-1']);
    expect(resumed.args).toContain(overrides[1]);
  });

  it('mcp: codex older than the checked version gets none (unknown fields could break its config)', async () => {
    const old = new CodexAdapter({ env: () => ({ PATH: bin }), queryTrust: allTrusted });
    await old.detect(); // 0.150.0
    const spec = old.launch(ctx({ mcp: { url: 'http://x/mcp', token: 't' } }));
    expect(spec.args.join(' ')).not.toContain('mcp_servers');
    expect(spec.env).toBeUndefined();
  });

  it('falls back to no hooks when codex does not list them', async () => {
    const codex = new CodexAdapter({ env: () => ({ PATH: bin }), queryTrust: async () => [] });
    await codex.detect(); // 0.150.0：没有 hooks
    expect(await codex.prepare(ctx())).toEqual({ hooks: false });
    const failing = new CodexAdapter({
      env,
      queryTrust: async () => {
        throw new Error('boom');
      },
    });
    expect(await failing.prepare(ctx())).toEqual({ hooks: false });
    expect(failing.launch(ctx()).args).toEqual([]);
  });

  it('an unreadable version is not taken as new enough (AH3): no hooks, no legacy notify, no MCP', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adb-nover-'));
    writeFileSync(join(dir, 'codex'), '#!/bin/sh\necho "codex dev build"\n');
    chmodSync(join(dir, 'codex'), 0o755);
    const codex = new CodexAdapter({ env: () => ({ PATH: dir }), queryTrust: allTrusted });
    expect(await codex.detect()).toMatchObject({ installed: true, version: null });
    expect(codex.capabilities(null).hooks).toBe(false);
    expect(await codex.prepare(ctx())).toEqual({ hooks: false });
    expect(codex.launch(ctx({ mcp: { url: 'http://x/mcp', token: 't' } })).args).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('the trust hashes are asked again when the codex binary changes (IS-77)', async () => {
    let asked = 0;
    const codex = new CodexAdapter({
      env: envNew,
      queryTrust: async (q) => {
        asked++;
        return allTrusted(q);
      },
    });
    await codex.detect();
    await codex.prepare(ctx());
    await codex.prepare(ctx());
    expect(asked).toBe(1);
    // codex 升级了：文件的修改时间变了
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(newBin, 'codex'), later, later);
    await codex.prepare(ctx());
    expect(asked).toBe(2);
  });

  it('old versions get the legacy notify instead', async () => {
    const codex = new CodexAdapter({ env });
    await codex.detect();
    expect(codex.launch(ctx()).args).toEqual(['-c', `notify=["${NOTIFY}","codex","notify"]`]);
  });

  it('parses the real hook payloads, Interrupt and legacy notify', () => {
    const codex = new CodexAdapter({ env });
    expect(codex.parseHook('SessionStart', fx.codex.SessionStart)).toEqual({
      type: 'session-start',
      sessionId: '01a168da-2729-7752-adf2-dd274b58dd05',
      reason: 'start',
    });
    expect(codex.parseHook('PermissionRequest', fx.codex.PermissionRequest)).toEqual({
      type: 'permission-request',
      tool: 'Bash',
      summary: 'mkdir agentdeck-probe',
      command: 'mkdir agentdeck-probe',
    });
    expect(codex.parseHook('Interrupt', fx.codex.Interrupt)).toEqual({ type: 'turn-end' });
    expect(codex.parseHook('Stop', fx.codex.Stop)).toEqual({ type: 'turn-end' });
    expect(codex.parseHook('notify', { type: 'agent-turn-complete', 'thread-id': 't' })).toEqual({ type: 'turn-end' });
    expect(codex.parseHook('notify', { type: 'other' })).toBeNull();
  });

  it('approves once with y', () => {
    expect(new CodexAdapter({ env }).approveOnceKeys).toEqual(['y']);
  });

  it('parseHooksList ignores malformed entries', () => {
    expect(parseHooksList(null)).toEqual([]);
    expect(parseHooksList({ data: [{ hooks: [{ key: 1 }] }] })).toEqual([]);
  });
});

describe('ShellAdapter and CustomCommandAdapter', () => {
  it('shell runs the login shell from the environment', () => {
    const shell = new ShellAdapter({ env: () => ({ SHELL: '/bin/bash' }) });
    expect(shell.command).toBe('/bin/bash');
    expect(shell.launch(ctx())).toEqual({ cmd: '/bin/bash', args: ['-l'], sessionId: null, consumed: { prompt: false } });
    expect(shell.launch(ctx({ command: 'pnpm install' })).args).toEqual(['-l', '-c', 'pnpm install']);
    expect(new ShellAdapter({ env: () => ({}) }).command).toBe('/bin/zsh');
  });

  it('shell detects its binary', async () => {
    expect((await new ShellAdapter({ env: () => ({ SHELL: '/bin/sh' }) }).detect()).installed).toBe(true);
    expect((await new ShellAdapter({ env: () => ({ SHELL: join(bin, 'notexec') }) }).detect()).installed).toBe(false);
  });

  it('shell and custom cannot resume or fork', () => {
    const resume = ctx({ mode: { kind: 'resume', sessionId: 'x' as AgentSessionId } });
    expect(() => new ShellAdapter({ env: () => ({}) }).launch(resume)).toThrow(AgentDeckError);
    try {
      new CustomCommandAdapter().launch(ctx({ mode: { kind: 'fork', sessionId: 'x' as AgentSessionId }, command: 'x' }));
    } catch (e) {
      expect((e as AgentDeckError).code).toBe('unsupported');
      expect((e as AgentDeckError).message).toBe("Custom command can't fork a conversation");
    }
  });

  it('custom splits the command like a shell', () => {
    const c = new CustomCommandAdapter();
    expect(c.launch(ctx({ command: `gemini --prompt "hello world" 'a b'` }))).toEqual({
      cmd: 'gemini',
      args: ['--prompt', 'hello world', 'a b'],
      sessionId: null,
      consumed: { prompt: false },
    });
    expect(() => c.launch(ctx({ command: '   ' }))).toThrow('Enter a command to run');
    expect(c.parseHook()).toBeNull();
  });
});
