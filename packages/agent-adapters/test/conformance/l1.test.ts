// 适配器合格测试 L1（AH2，画布 A1 第 2 节）：每家 agent × K1–K18，离线（fixture、假 PATH、假程序），在 pnpm check 里。
// 按适配器的能力声明（declareCapabilities）逐项跑：声明 no 的跳过并检查写了原因（没写算失败），声明 yes / partial 的必须过。
// 启动参数、按键对照 verified.ts（真程序上核对过的标准答案），改了适配器的参数这里会失败。
// L2（真程序）见 l2.test.ts；新增或升级一家 agent 的步骤见 AGENTS.md「新增或升级一家 agent」。

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { autoApproveSupportFromReport, capabilitiesFromReport } from '@agentdeck/contracts';
import type { AgentCapabilityReport, AgentKind, CapabilityEntry, StatusEvent, TerminalId } from '@agentdeck/contracts';
import { FakeTerminalHost } from '@agentdeck/fakes';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseHooksList } from '../../src/adapters/codex.ts';
import type { CodexTrustQuery } from '../../src/adapters/codex.ts';
import { createDefaultAdapters } from '../../src/adapters/index.ts';
import type { AdapterLaunchContext, AgentAdapterExt } from '../../src/adapters/types.ts';
import { AgentServiceImpl } from '../../src/agent-service.ts';
import { declared } from '../../src/capabilities/declare.ts';
import { COMPAT_RECORDS } from '../../src/compat/records.ts';
import { CONFORMANCE_AGENTS, SCENARIOS } from '../../src/compat/scenarios.ts';
import type { Scenario, ScenarioId } from '../../src/compat/scenarios.ts';
import { readClaudeSession, readCodexSession, readPiSession, parseCodexIndex, parseKimiState } from '../../src/history/readers.ts';
import { hookHint } from '../../src/hook-payload.ts';
import { matchOmpApproval } from '../../src/status/screens.ts';
import { HOOKS_DIDNT_REPORT, StatusMachine } from '../../src/status/machine.ts';
import { createAgentRuntime } from '../../src/runtime.ts';
import { approvalStrategy } from '../../src/status/support.ts';
import { ClaudeUsageParser, CodexUsageParser, KimiUsageParser, PiUsageParser, parseKimiIndex } from '../../src/usage/index.ts';
import type { UsageParser } from '../../src/usage/index.ts';
import { claude as claudeHooks, codex as codexHooks } from '../fixtures.ts';
import { readCompatFiles, recordsSource } from './records.mjs';
import { ProcessHost } from './support/process-host.ts';
import { fill, indexOfRun, VERIFIED } from './verified.ts';

const PKG = fileURLToPath(new URL('../..', import.meta.url));
const NOTIFY = '/opt/agentdeck/agentdeck-notify';
const EXTENSION = '/opt/agentdeck/agentdeck-pi-extension.mjs';
const MCP_PLUGIN = '/opt/agentdeck/mcp-plugin';
const MCP = { url: 'http://127.0.0.1:47621/mcp', token: 'secret-token' };
const PROMPT = 'reply with the word PELICAN';

let bin: string;
let work: string;
beforeAll(() => {
  bin = mkdtempSync(join(tmpdir(), 'conf-bin-'));
  work = mkdtempSync(join(tmpdir(), 'conf-work-'));
  for (const agent of CONFORMANCE_AGENTS) {
    writeFileSync(join(bin, agent), `#!/bin/sh\necho "${VERIFIED[agent]!.versionOutput}"\n`);
    chmodSync(join(bin, agent), 0o755);
  }
});
afterAll(() => {
  rmSync(bin, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

const env = () => ({ PATH: bin, SHELL: '/bin/sh' });

/** codex 的信任哈希：假的 app-server 把我们这几条钩子都列出来。 */
const queryTrust: CodexTrustQuery = async ({ overrides }) => {
  const commands = overrides.filter((_, i) => i % 2 === 1).map((o) => JSON.parse(/command=("(?:[^"\\]|\\.)*")/.exec(o)![1]!) as string);
  return parseHooksList(codexHooks.hooksList(commands));
};

function adapters(): AgentAdapterExt[] {
  return createDefaultAdapters({ env, agentExtension: EXTENSION, mcpPluginDir: MCP_PLUGIN, queryTrust });
}

/** 检测过的适配器（launch 按检测到的版本决定带什么）。 */
async function adapterFor(agent: AgentKind): Promise<AgentAdapterExt> {
  const a = adapters().find((x) => x.id === agent)!;
  await a.detect();
  if (a.prepare) await a.prepare(ctx());
  return a;
}

function ctx(over: Partial<AdapterLaunchContext> = {}): AdapterLaunchContext {
  return { cwd: '/repo', terminalId: 'pending' as TerminalId, mode: { kind: 'new' }, notifyCommand: NOTIFY, extraArgs: [], ...over };
}

function declaredFor(agent: AgentKind): CapabilityEntry[] {
  const a = adapters().find((x) => x.id === agent)!;
  return a.declareCapabilities!(VERIFIED[agent]!.version);
}

// ---- 钩子负载：claude、codex 用实测抓到的（fixtures.ts），pi、omp 用扩展发的同名钩子 ----

const HOOKS: Record<string, { start: unknown; prompt: unknown; permission: unknown; question?: [string, unknown]; stop: unknown; interrupt?: unknown }> = {
  claude: {
    start: claudeHooks.SessionStart,
    prompt: claudeHooks.UserPromptSubmit,
    permission: claudeHooks.PermissionRequestBash,
    question: ['PermissionRequest', claudeHooks.PermissionRequestAsk],
    stop: claudeHooks.Stop,
  },
  codex: {
    start: codexHooks.SessionStart,
    prompt: { hook_event_name: 'UserPromptSubmit', prompt: 'reply with OK' },
    permission: codexHooks.PermissionRequest,
    stop: codexHooks.Stop,
    interrupt: codexHooks.Interrupt,
  },
  pi: { start: { session_id: 'pi-s1' }, prompt: {}, permission: null, stop: {} },
  omp: {
    start: { session_id: 'omp-s1' },
    prompt: {},
    permission: { tool_name: 'bash', tool_input: { command: 'mkdir agentdeck-probe' } },
    question: ['Question', { question: 'Which color?' }],
    stop: {},
  },
};

function machine() {
  const events: StatusEvent[] = [];
  const m = new StatusMachine({ emit: (e) => events.push(e), destructivePatterns: () => [] });
  return { m, events, id: 't1' as TerminalId };
}

function hook(a: AgentAdapterExt, m: StatusMachine, id: TerminalId, name: string, payload: unknown): void {
  m.onHook(id, a.parseHook(name, payload), hookHint(name, payload));
}

const hookLike = (e: CapabilityEntry | null) => !!e && (e.via === 'hook' || e.via === 'extension' || e.via === 'local-server');
const now = () => new Date().toISOString();

// ---- 每一项的 L1 ----

type Check = (agent: AgentKind, entry: CapabilityEntry | null) => Promise<void>;

const L1: Record<ScenarioId, Check> = {
  async K1(agent) {
    const a = adapters().find((x) => x.id === agent)!;
    expect(await a.detect()).toEqual({ installed: true, version: VERIFIED[agent]!.version, path: join(bin, agent) });
    const missing = createDefaultAdapters({ env: () => ({ PATH: '/nonexistent' }) }).find((x) => x.id === agent)!;
    expect((await missing.detect()).installed).toBe(false);
  },

  async K2(agent) {
    const v = VERIFIED[agent]!;
    const a = await adapterFor(agent);
    const extra = ['--model', 'm1'];
    const spec = a.launch(ctx({ prompt: PROMPT, extraArgs: extra }));
    if (v.prompt.kind === 'tail') {
      expect(spec.args.slice(-v.prompt.args.length)).toEqual(fill(v.prompt.args, { prompt: PROMPT }));
      expect(spec.consumed?.prompt).toBe(true);
    } else if (v.prompt.kind === 'before-extra') {
      expect(spec.args.slice(-extra.length - 1)).toEqual([PROMPT, ...extra]);
      expect(a.launch(ctx({ prompt: '@README.md hi' })).args.at(-1)).toBe(' @README.md hi');
      expect(spec.consumed?.prompt).toBe(true);
    } else {
      // 启动后打进去：AgentService 等终端安静下来
      expect(spec.consumed?.prompt).toBe(false);
      expect(spec.sendAfterReady).toBe(PROMPT);
      const terminals = new FakeTerminalHost({ silenceMs: 0 });
      const s = new AgentServiceImpl({ adapters: [a], terminals, env, notifyCommand: NOTIFY, firstMessageTiming: { typeDelayMs: 0 } });
      const { terminalId: id } = await s.start({ agent, cwd: '/repo', workspaceId: null, mode: { kind: 'new' }, prompt: PROMPT });
      expect(terminals.get(id).keys).toEqual([]);
      terminals.feed(id, '> \n');
      s.onTerminalEvent({ type: 'terminal.silence', id, at: now() });
      await vi.waitFor(() => expect(terminals.get(id).keys).toEqual([[PROMPT], ['Enter']]));
      s.dispose();
      terminals.dispose();
    }
  },

  async K3(agent, entry) {
    const a = await adapterFor(agent);
    if (entry!.via === 'flag') {
      const spec = a.launch(ctx());
      expect(spec.sessionId).toBeTruthy();
      expect(indexOfRun(spec.args, fill(VERIFIED[agent]!.newArgs, { new: spec.sessionId! }))).toBe(0);
    } else if (hookLike(entry)) {
      const p = HOOKS[agent]!.start as { session_id: string };
      expect(a.parseHook('SessionStart', p)).toEqual({ type: 'session-start', sessionId: p.session_id });
    } else if (entry!.via === 'session-file') {
      // kimi：会话 id 启动时不知道，从它自己的 session_index.jsonl 里按目录猜（usage/locate.ts locateKimi）
      expect(a.launch(ctx()).sessionId).toBeNull();
      const line = JSON.stringify({ sessionId: 'session_k1', sessionDir: '/k/sessions/wd_1/session_k1', workDir: '/repo' });
      expect(parseKimiIndex(`${line}\n`)).toEqual([{ sessionId: 'session_k1', sessionDir: '/k/sessions/wd_1/session_k1', workDir: '/repo' }]);
    } else {
      throw new Error(`no L1 for session-id via ${entry!.via}`);
    }
  },

  async K4(agent, entry) {
    const a = await adapterFor(agent);
    const { m, events, id } = machine();
    const st = () => m.get(id)?.status;
    if (hookLike(entry)) {
      const h = HOOKS[agent]!;
      m.track(id, { agent, workspaceId: null, hooks: true });
      hook(a, m, id, 'SessionStart', h.start);
      expect(st()).toBe('idle');
      hook(a, m, id, 'UserPromptSubmit', h.prompt);
      expect(st()).toBe('running');
      hook(a, m, id, 'Stop', h.stop);
      expect(st()).toBe('idle');
      expect(events.filter((e) => e.type === 'agent.turn-end')).toHaveLength(1);
    } else {
      m.track(id, { agent, workspaceId: null, hooks: false });
      m.onTerminalEvent({ type: 'terminal.activity', id, at: now() });
      expect(st()).toBe('running');
      m.onTerminalEvent({ type: 'terminal.silence', id, at: now() });
      expect(st()).toBe('idle');
    }
  },

  async K5(agent) {
    const a = await adapterFor(agent);
    const { m, id } = machine();
    m.track(id, { agent, workspaceId: null, hooks: true });
    hook(a, m, id, 'PermissionRequest', HOOKS[agent]!.permission);
    const s = m.get(id)!;
    expect(s.status).toBe('needs-approval');
    expect(s.pending).toMatchObject({ kind: 'approval', command: 'mkdir agentdeck-probe' });
    expect(s.pending!.summary).toContain('mkdir agentdeck-probe');
  },

  async K6(agent, entry) {
    const a = await adapterFor(agent);
    expect(a.approveOnceKeys).toEqual(VERIFIED[agent]!.approveOnce);
    const strategy = approvalStrategy(agent);
    if (entry!.via === 'hook') {
      expect(strategy.method).toBe('hook');
    } else {
      // 认屏后发键：屏幕上认得出确认框才发
      expect(strategy).toMatchObject({ method: 'keys', screen: 'omp' });
      // omp 18.0.4 真 TUI 的样子（L2 抓的）
      const screen = ['╭─ Allow tool: bash ──────────╮', '│ Command: mkdir agentdeck-probe │', '│                             │', '│  ❯ Approve                  │', '│    Deny                     │', '╰─────────────────────────────╯'];
      expect(matchOmpApproval(screen)).toMatchObject({ command: 'mkdir agentdeck-probe' });
      expect(matchOmpApproval(['Approve', 'Deny'])).toBeNull();
    }
  },

  async K7(agent, entry) {
    const a = await adapterFor(agent);
    const { m, events, id } = machine();
    const st = () => m.get(id)?.status;
    if (!hookLike(entry)) {
      m.track(id, { agent, workspaceId: null, hooks: false });
      m.onTerminalEvent({ type: 'terminal.activity', id, at: now() });
      m.onTerminalEvent({ type: 'terminal.silence', id, at: now() });
      expect(st()).toBe('idle');
      return;
    }
    m.track(id, { agent, workspaceId: null, hooks: true });
    hook(a, m, id, 'UserPromptSubmit', HOOKS[agent]!.prompt);
    expect(st()).toBe('running');
    const interrupt = HOOKS[agent]!.interrupt;
    if (interrupt) {
      // codex 拒绝或 Esc 时有 Interrupt
      hook(a, m, id, 'Interrupt', interrupt);
    } else {
      // claude、pi、omp 拒绝或 Esc 时没有钩子：用户按过键、之后安静、期间没有钩子 → idle（状态表第 15 行）
      m.noteInput(id);
      m.onTerminalEvent({ type: 'terminal.silence', id, at: now() });
    }
    expect(st()).toBe('idle');
    expect(events.filter((e) => e.type === 'agent.turn-end')).toHaveLength(1);
  },

  async K8(agent) {
    const a = await adapterFor(agent);
    const { m, id } = machine();
    m.track(id, { agent, workspaceId: null, hooks: true });
    const [name, payload] = HOOKS[agent]!.question!;
    hook(a, m, id, name, payload);
    expect(m.get(id)).toMatchObject({ status: 'needs-reply', pending: { kind: 'question' } });
  },

  async K9(agent) {
    const a = await adapterFor(agent);
    const spec = a.launch(ctx({ mode: { kind: 'resume', sessionId: 'abc' as never } }));
    expect(indexOfRun(spec.args, fill(VERIFIED[agent]!.resume!, { id: 'abc' }))).toBe(0);
    expect(spec.sessionId).toBe('abc');
  },

  async K10(agent) {
    const a = await adapterFor(agent);
    const spec = a.launch(ctx({ cwd: '/repo/b', mode: { kind: 'fork', sessionId: 'abc' as never } }));
    expect(indexOfRun(spec.args, fill(VERIFIED[agent]!.fork!, { id: 'abc', cwd: '/repo/b', new: spec.sessionId ?? '' }))).toBe(0);
    expect(spec.sessionId).not.toBe('abc');
  },

  async K11(agent) {
    const put = (name: string, rows: object[]) => {
      const file = join(work, agent, name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
      return file;
    };
    const user = { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'helo' }] } };
    switch (agent) {
      case 'claude': {
        const f = put('c1.jsonl', [{ type: 'user', cwd: '/repo', entrypoint: 'cli', sessionId: 'c1', timestamp: '2026-10-28T09:00:00.000Z', message: { content: 'helo' } }]);
        expect(await readClaudeSession(f)).toMatchObject({ id: 'c1', cwd: '/repo', firstPrompt: 'helo' });
        return;
      }
      case 'codex': {
        const f = put('rollout-x1.jsonl', [
          { type: 'session_meta', payload: { id: 'x1', cwd: '/repo', timestamp: '2026-10-28T09:00:00.000Z', source: 'cli', originator: 'codex-tui' } },
          { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'helo' }] } } },
        ]);
        expect(await readCodexSession(f, parseCodexIndex('', ''))).toMatchObject({ id: 'x1', cwd: '/repo', title: 'helo' });
        return;
      }
      case 'pi':
      case 'omp': {
        const f = put('s.jsonl', [{ type: 'session', version: 3, id: 'p1', timestamp: '2026-10-28T09:00:00.000Z', cwd: '/repo' }, user]);
        expect(await readPiSession(f)).toMatchObject({ id: 'p1', cwd: '/repo', firstPrompt: 'helo' });
        return;
      }
      case 'kimi': {
        const state = { id: 'session_k1', cwd: '/repo', title: 'helo', isCustomTitle: false, lastPrompt: 'helo', createdAt: 1792847231205, updatedAt: 1792847343395 };
        expect(parseKimiState(JSON.stringify(state))).toMatchObject({ id: 'session_k1', cwd: '/repo' });
        return;
      }
    }
    throw new Error(`no L1 history check for ${agent}`);
  },

  async K12(agent) {
    const p = usageOf(agent);
    expect(p.total).not.toBeNull();
  },

  async K13(agent) {
    const p = usageOf(agent);
    expect(p.rateLimits?.primary?.resetsAt).toBeTruthy();
  },

  async K14(agent) {
    const a = await adapterFor(agent);
    const spec = a.launch(ctx({ mcp: MCP }));
    const want = fill(VERIFIED[agent]!.mcpArgs!, { url: MCP.url, 'mcp-plugin': MCP_PLUGIN });
    expect(indexOfRun(spec.args, want)).toBeGreaterThanOrEqual(0);
    // token 只进环境，不进命令行
    expect(spec.args.join(' ')).not.toContain(MCP.token);
    expect(Object.values(spec.env ?? {})).toContain(MCP.token);
  },

  async K15(agent) {
    const a = await adapterFor(agent);
    const skill = { id: 'library:demo', name: 'demo', path: '/data/skills/demo' };
    const spec = a.launch(
      ctx({
        skills: { ids: ['library:demo'], agentdeckMcp: true, skills: [skill], mcp: [], setDir: '/data/sets/x', keepSkillRoots: [] } as never,
      }),
    );
    expect(spec.args).toContain(VERIFIED[agent]!.skillFlag!);
  },

  async K16(agent) {
    // 钩子一直不来（notify 路径是错的、用户关掉了钩子……）：hookTimeoutMs 之后退回按输出判断，快照和报告都说明原因
    const terminals = new FakeTerminalHost({ silenceMs: 0 });
    const rt = createAgentRuntime({
      env,
      terminals,
      adapters: adapters(),
      notifyCommand: '/nonexistent/agentdeck-notify',
      emit: () => {},
      destructivePatterns: () => [],
      socketPath: join(work, `k16-${agent}.sock`),
      sessionRoots: null,
      hookTimeoutMs: 50,
    });
    try {
      const { terminalId: id } = await rt.agents.start({ agent, cwd: '/repo', workspaceId: null, mode: { kind: 'new' } });
      rt.noteInput(id); // codex 从第一次输入开始等
      await vi.waitFor(() => expect(rt.status.get(id)!.degraded).toBe(HOOKS_DIDNT_REPORT), { timeout: 2000 });
      const info = (await rt.agents.list()).find((a) => a.id === agent)!;
      expect(declared(info.report!.entries, 'status')).toMatchObject({ level: 'partial', via: 'output', reason: "Hooks didn't report at the last launch" });
      // 之后按输出判断
      rt.onTerminalEvent({ type: 'terminal.activity', id, at: now() });
      expect(rt.status.get(id)!.status).toBe('running');
      rt.onTerminalEvent({ type: 'terminal.silence', id, at: now() });
      expect(rt.status.get(id)!.status).toBe('idle');
    } finally {
      await rt.close();
      terminals.dispose();
    }
  },

  async K17(agent) {
    // 假程序：版本没核对过；参数里有 --agentdeck-bogus 时像 commander 一样报 unknown option、退出 2，否则一直开着
    const pbin = mkdtempSync(join(tmpdir(), 'conf-k17-'));
    const prog = join(pbin, agent);
    writeFileSync(
      prog,
      [
        '#!/bin/sh',
        'case "$1" in --version|-V|-v) echo "99.0.0"; exit 0 ;; esac',
        'for a in "$@"; do',
        '  if [ "$a" = "--agentdeck-bogus" ]; then echo "error: unknown option \'--agentdeck-bogus\'" >&2; exit 2; fi',
        'done',
        'exec sleep 30',
        '',
      ].join('\n'),
    );
    chmodSync(prog, 0o755);
    const penv = () => ({ PATH: `${pbin}:/usr/bin:/bin`, SHELL: '/bin/sh' });
    let s: AgentServiceImpl | null = null;
    const host = new ProcessHost(penv(), (e) => s?.onTerminalEvent(e));
    const started: { hooks: boolean; degraded: string | null }[] = [];
    s = new AgentServiceImpl({
      adapters: createDefaultAdapters({ env: penv, agentExtension: EXTENSION, mcpPluginDir: MCP_PLUGIN, queryTrust }),
      terminals: host,
      env: penv,
      notifyCommand: NOTIFY,
      extraArgs: () => ['--agentdeck-bogus'],
      onStarted: (x) => started.push(x),
      launchTiming: { earlyExitMs: 2000 },
    });
    try {
      const res = await s.start({ agent, cwd: work, workspaceId: null, mode: { kind: 'new' } });
      expect(host.created).toHaveLength(2);
      expect(host.created[0]!.args).toContain('--agentdeck-bogus');
      expect(res.args).not.toContain('--agentdeck-bogus');
      expect(host.alive(res.terminalId)).toBe(true);
      expect(started.at(-1)).toMatchObject({ hooks: false, degraded: "Started with session options only · error: unknown option '--agentdeck-bogus'" });
    } finally {
      host.dispose();
      s.dispose();
      rmSync(pbin, { recursive: true, force: true });
    }
  },

  async K18(agent) {
    const a = await adapterFor(agent);
    const v = VERIFIED[agent]!;
    for (const mode of [{ kind: 'new' }, { kind: 'resume', sessionId: 'abc' }, { kind: 'fork', sessionId: 'abc' }] as const) {
      if ((mode.kind === 'fork' && v.fork === null) || (mode.kind === 'resume' && v.resume === null)) continue;
      const spec = a.launch(ctx({ cwd: '/repo/frame', mode: mode as never, mcp: MCP, prompt: PROMPT }));
      for (const f of v.worktreeFlags) expect(spec.args.slice(0, spec.args.indexOf('--') >= 0 ? spec.args.indexOf('--') : undefined)).not.toContain(f);
      // codex fork 的 -C 就是框的目录
      const c = spec.args.indexOf('-C');
      if (c >= 0) expect(spec.args[c + 1]).toBe('/repo/frame');
    }
    // AgentService 把框的目录交给终端
    const terminals = new FakeTerminalHost({ silenceMs: 0 });
    const s = new AgentServiceImpl({ adapters: [a], terminals, env, notifyCommand: NOTIFY });
    const { terminalId } = await s.start({ agent, cwd: '/repo/frame', workspaceId: null, mode: { kind: 'new' } });
    expect(terminals.get(terminalId).request.cwd).toBe('/repo/frame');
    s.dispose();
    terminals.dispose();
  },
};

const USAGE_FIXTURES = fileURLToPath(new URL('../usage-fixtures/', import.meta.url));

function usageOf(agent: AgentKind) {
  let parser: UsageParser;
  let file: string;
  switch (agent) {
    case 'claude':
      [parser, file] = [new ClaudeUsageParser(), 'claude.jsonl'];
      break;
    case 'codex':
      [parser, file] = [new CodexUsageParser(), 'codex.jsonl'];
      break;
    case 'pi':
      [parser, file] = [new PiUsageParser(), 'pi.jsonl'];
      break;
    case 'omp':
      [parser, file] = [new PiUsageParser(), 'omp.jsonl'];
      break;
    case 'kimi':
      [parser, file] = [new KimiUsageParser(), 'kimi-wire.jsonl'];
      break;
    default:
      throw new Error(`no usage fixture for ${agent}`);
  }
  for (const line of readFileSync(join(USAGE_FIXTURES, file), 'utf8').split('\n')) parser.feed(line);
  return parser.snapshot();
}

// ---- 跑表 ----

function skipReason(s: Scenario, entry: CapabilityEntry | null, all: CapabilityEntry[]): string | null {
  if (s.capability && (!entry || entry.level === 'no')) return entry?.reason ?? '';
  if (s.id === 'K16' && !hookLike(declared(all, 'status'))) return 'No hooks to lose: status already comes from terminal activity';
  return null;
}

for (const agent of CONFORMANCE_AGENTS) {
  describe(`L1 · ${agent}`, () => {
    const all = declaredFor(agent);
    for (const s of SCENARIOS) {
      const entry = s.capability ? declared(all, s.capability) : null;
      const reason = skipReason(s, entry, all);
      const name = `${s.id} ${s.title}`;
      const check = L1[s.id];
      if (reason === '') {
        it(`${name} — declared No without a reason`, () => expect.fail(`${agent} declares ${s.capability} as No but gives no reason`));
      } else if (reason !== null) {
        it.skip(`${name} — skip: ${reason}`, () => {});
      } else {
        it(name, () => check(agent, entry));
      }
    }

    it('the old capabilities and Auto-approve support follow from the declaration', async () => {
      const a = await adapterFor(agent);
      const report: AgentCapabilityReport = { agent, version: VERIFIED[agent]!.version, checkedAt: now(), entries: all };
      expect(capabilitiesFromReport(report)).toEqual(a.capabilities(VERIFIED[agent]!.version));
      const s = approvalStrategy(agent);
      expect(autoApproveSupportFromReport(report)).toMatchObject({ method: s.method, verified: s.verified });
    });

    it('every declaration that is not Yes says why (the menu hint uses it)', () => {
      for (const e of all) {
        if (e.level === 'yes') expect(e.reason, e.key).toBeNull();
        else expect(e.reason, e.key).toBeTruthy();
      }
    });
  });
}

describe('compat records', () => {
  it('src/compat/records.ts matches compat/*.json (run `pnpm --filter @agentdeck/agent-adapters conformance --records` after editing them)', () => {
    expect(readFileSync(join(PKG, 'src/compat/records.ts'), 'utf8')).toBe(recordsSource(readCompatFiles(PKG)));
  });

  it('there is a record for each of the five agents, with a result for every K', () => {
    for (const agent of CONFORMANCE_AGENTS) {
      const r = COMPAT_RECORDS[agent];
      expect(r, agent).toBeDefined();
      for (const s of SCENARIOS) {
        const item = r!.results[s.id];
        expect(item, `${agent} ${s.id}`).toBeDefined();
        if (item!.result !== 'pass') expect(item!.reason, `${agent} ${s.id}`).toBeTruthy();
      }
    }
  });
});
