// AH3（DR-60 P0）：运行时按合格测试记录降级。TC-48（超过核对版本时按键类功能关掉）、IS-73（参数被拒只带会话参数重开）、
// IS-74（钩子没来，见 status-machine.test.ts 第 20–23 行）、IS-77（可执行文件变了重读版本）、版本读不出时不当作够新、Check again。

import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capabilityEntry } from '@agentdeck/contracts';
import type { CreateTerminalRequest, StartAgentRequest, StatusEvent, TerminalId, WorkspaceId } from '@agentdeck/contracts';
import { FakeTerminalHost } from '@agentdeck/fakes';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDefaultAdapters } from '../src/adapters/index.ts';
import { AgentServiceImpl } from '../src/agent-service.ts';
import type { StartedAgent } from '../src/agent-service.ts';
import { buildReport, verifiedUpTo } from '../src/capabilities/report.ts';
import { COMPAT_RECORDS } from '../src/compat/records.ts';
import { createAgentRuntime } from '../src/runtime.ts';

const NOTIFY = '/opt/agentdeck/agentdeck-notify';
const EXTENSION = '/opt/agentdeck/agentdeck-pi-extension.mjs';

let dir: string;
let n = 0;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ah3-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** 一个只有这几个假程序的 PATH。help 是 `--help` 打印的内容，version 是 `--version` 打印的。 */
function binWith(programs: Record<string, { version: string; help?: string }>): string {
  const bin = join(dir, `bin-${++n}`);
  mkdirSync(bin, { recursive: true });
  for (const [name, p] of Object.entries(programs)) writeProgram(join(bin, name), p);
  return bin;
}
function writeProgram(path: string, p: { version: string; help?: string }) {
  const help = (p.help ?? '').replace(/'/g, `'\\''`);
  writeFileSync(path, `#!/bin/sh\ncase "$1" in\n  --version|-V|-v) echo '${p.version}' ;;\n  --help|-h) echo '${help}' ;;\nesac\n`);
  chmodSync(path, 0o755);
}

const req = (over: Partial<StartAgentRequest>): StartAgentRequest => ({ agent: 'claude', cwd: '/repo', workspaceId: null, mode: { kind: 'new' }, ...over });
const entry = (r: Parameters<typeof capabilityEntry>[0] | null | undefined, key: Parameters<typeof capabilityEntry>[1]) => capabilityEntry(r!, key);

let terminals: FakeTerminalHost;
afterEach(() => terminals?.dispose());

function service(bin: string, over: Partial<ConstructorParameters<typeof AgentServiceImpl>[0]> = {}) {
  const env = () => ({ PATH: bin, SHELL: '/bin/sh' });
  terminals = new FakeTerminalHost({ silenceMs: 0 });
  const started: StartedAgent[] = [];
  const s = new AgentServiceImpl({
    adapters: createDefaultAdapters({ env, agentExtension: EXTENSION }),
    terminals,
    env,
    notifyCommand: NOTIFY,
    onStarted: (x) => started.push(x),
    launchTiming: { earlyExitMs: 100, probeMs: 100 },
    ...over,
  });
  terminals.bus.onAny((e) => {
    if (e.type.startsWith('terminal.')) s.onTerminalEvent(e as never);
  });
  return { s, started };
}

describe('the compat record fills verifiedUpTo', () => {
  it('per capability, from the K scenarios that cover it; skipped ones do not count', () => {
    const omp = COMPAT_RECORDS['omp']!;
    expect(verifiedUpTo(omp, 'approve-keys')).toBe('18.0.4');
    expect(verifiedUpTo(omp, 'quota')).toBeNull();
    expect(verifiedUpTo(null, 'status')).toBeNull();
  });
});

describe('TC-48: a version newer than checked turns off what presses keys for you', () => {
  it('omp 18.12.6: Approve keys is Off · “Untested on 18.12.6”; hooks, history and usage stay Yes', async () => {
    const bin = binWith({ omp: { version: 'omp/18.12.6' } });
    const { s } = service(bin);
    const info = (await s.list()).find((a) => a.id === 'omp')!;
    expect(info.version).toBe('18.12.6');
    expect(entry(info.report, 'approve-keys')).toMatchObject({ level: 'no', downgrade: 'off', reason: 'Untested on 18.12.6', verifiedUpTo: '18.0.4' });
    for (const key of ['status', 'history', 'usage', 'resume'] as const) expect(entry(info.report, key)!.level).toBe('yes');
    // 核对过的版本照常
    const ok = service(binWith({ omp: { version: 'omp/18.0.4' } })).s;
    expect(entry((await ok.list()).find((a) => a.id === 'omp')!.report, 'approve-keys')).toMatchObject({ level: 'yes', via: 'screen' });
  });

  it('Auto-approve is unsupported for it with the same reason, and a waiting request goes to “needs you” without keys', async () => {
    const bin = binWith({ omp: { version: 'omp/18.12.6' } });
    const env = () => ({ PATH: bin });
    terminals = new FakeTerminalHost({ silenceMs: 0 });
    const events: StatusEvent[] = [];
    const sent: string[][] = [];
    const host = {
      create: (r: CreateTerminalRequest) => terminals.create(r),
      sendKeys: async (_id: TerminalId, keys: string[]) => void sent.push(keys),
      lastLines: async () => ['╭─ Allow tool: bash ──╮', '│ Command: rm x │', '│               │', '│  ❯ Approve    │', '│    Deny       │'],
    };
    const rt = createAgentRuntime({
      env,
      terminals: host,
      notifyCommand: NOTIFY,
      agentExtension: EXTENSION,
      emit: (e) => events.push(e),
      destructivePatterns: () => [],
      socketPath: join(dir, `unused-${++n}.sock`),
      sessionRoots: null,
      launchTiming: { earlyExitMs: 50 },
      approvalTiming: { confirmMs: 100, pollMs: 10, keyDelayMs: 0 },
    });
    await rt.agents.list();
    const support = (await rt.approvals.autoApproveSupport()).find((x) => x.agent === 'omp')!;
    expect(support).toMatchObject({ method: 'unsupported', note: 'Untested on 18.12.6' });
    const ws = 'ws-1' as WorkspaceId;
    const { terminalId: id } = await rt.agents.start({ agent: 'omp', cwd: '/repo', workspaceId: ws, mode: { kind: 'new' } });
    await expect(rt.approvals.setTerminalAutoApprove(id, true)).rejects.toThrow('Untested on 18.12.6');
    await rt.approvals.setAutoApprove(ws, true);
    rt.status.onHook(id, { type: 'session-start', sessionId: 's1' as never });
    rt.status.onHook(id, { type: 'permission-request', tool: 'bash', summary: 'rm x', command: 'rm x' });
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toEqual([]);
    expect(rt.status.get(id)!.status).toBe('needs-approval');
    expect(events.filter((e) => e.type === 'approval.needs-you').at(-1)).toMatchObject({ terminalId: id, reason: 'unsupported' });
    await rt.close();
  });
});

describe('an unreadable version is not taken as new enough', () => {
  it('claude: no --settings (and the report says why) unless --help lists it', async () => {
    const noHelp = service(binWith({ claude: { version: 'dev build' } }));
    const a = (await noHelp.s.list()).find((x) => x.id === 'claude')!;
    expect(a.version).toBeNull();
    expect(a.capabilities.hooks).toBe(false);
    expect(entry(a.report, 'status')).toMatchObject({ level: 'partial', via: 'output' });
    expect((await noHelp.s.start(req({}))).args).not.toContain('--settings');

    const withHelp = service(binWith({ claude: { version: 'dev build', help: '  --settings <file-or-json>  Path to a settings JSON file' } }));
    expect((await withHelp.s.start(req({}))).args).toContain('--settings');
  });

  it('omp: -e only when --help lists it; key-pressing items are off (“couldn\'t read the version”)', async () => {
    const { s } = service(binWith({ omp: { version: 'nightly', help: '  -e, --extension=<value>  Load an extension file' } }));
    const info = (await s.list()).find((x) => x.id === 'omp')!;
    expect(info.capabilities.hooks).toBe(true);
    expect(entry(info.report, 'approve-keys')).toMatchObject({ level: 'no', downgrade: 'off', reason: "Untested: couldn't read the Oh My Pi version" });
    expect((await s.start(req({ agent: 'omp' }))).args).toEqual(['-e', EXTENSION]);
  });
});

describe('IS-73 / K17: a rejected launch option restarts once with session options only', () => {
  /** claude 2.1.999（没核对过）：带 --settings 时马上打印 unknown option 并退出 1。 */
  function rejecting() {
    const bin = binWith({ claude: { version: '2.1.999 (Claude Code)' } });
    const r = service(bin);
    const created: CreateTerminalRequest[] = [];
    const ids: TerminalId[] = [];
    const killed: TerminalId[] = [];
    const create = terminals.create.bind(terminals);
    const kill = terminals.kill.bind(terminals);
    terminals.create = async (q) => {
      created.push(q);
      const res = await create(q);
      ids.push(res.id);
      if (q.args.includes('--settings')) {
        setTimeout(() => {
          terminals.feed(res.id, "error: unknown option '--settings'\n");
          terminals.exit(res.id, 1);
        }, 5);
      }
      return res;
    };
    terminals.kill = async (id) => {
      killed.push(id);
      return kill(id);
    };
    return { ...r, created, ids, killed };
  }

  it('the terminal comes up without our options and is marked degraded; the report says so', async () => {
    const { s, started, created, ids, killed } = rejecting();
    const res = await s.start(req({ prompt: 'fix the bug', mode: { kind: 'new' } }));
    expect(created).toHaveLength(2);
    // 第一个（退出了的）收掉，返回的是重开的那个
    expect(killed).toEqual([ids[0]]);
    expect(res.terminalId).toBe(ids[1]);
    expect(created[1]!.args).not.toContain('--settings');
    // 会话参数和第一条消息还在
    expect(created[1]!.args.slice(0, 2)).toEqual(['--session-id', res.sessionId]);
    expect(created[1]!.args.slice(-2)).toEqual(['--', 'fix the bug']);
    expect(res.args).toEqual(created[1]!.args);
    expect(started.at(-1)).toMatchObject({ terminalId: res.terminalId, hooks: false, watchHooks: null });
    expect(started.at(-1)!.degraded).toBe("Started with session options only · error: unknown option '--settings'");
    const info = (await s.list()).find((a) => a.id === 'claude')!;
    expect(entry(info.report, 'status')).toMatchObject({ level: 'partial', via: 'output', reason: started.at(-1)!.degraded });
    expect(info.warning).toBe(started.at(-1)!.degraded);
  });

  it('later launches of the same version go straight to session options only (no second wait)', async () => {
    const { s, created } = rejecting();
    await s.start(req({}));
    created.length = 0;
    await s.start(req({}));
    expect(created).toHaveLength(1);
    expect(created[0]!.args).not.toContain('--settings');
  });

  it('a version the conformance record checked is not watched at all', async () => {
    const { s } = service(binWith({ claude: { version: '2.1.291 (Claude Code)' } }), { launchTiming: { earlyExitMs: 5_000 } });
    const t0 = Date.now();
    await s.start(req({}));
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it('an unchecked version that stays up is remembered: the next launch does not wait', async () => {
    const { s } = service(binWith({ claude: { version: '2.1.999 (Claude Code)' } }), { launchTiming: { earlyExitMs: 300 } });
    const t0 = Date.now();
    const a = await s.start(req({}));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(290);
    expect(a.args).toContain('--settings');
    const t1 = Date.now();
    await s.start(req({}));
    expect(Date.now() - t1).toBeLessThan(250);
  });

  it('a quick non-zero exit without an option error is left alone', async () => {
    const bin = binWith({ claude: { version: '2.1.999 (Claude Code)' } });
    const { s, started } = service(bin);
    const create = terminals.create.bind(terminals);
    terminals.create = async (q) => {
      const res = await create(q);
      setTimeout(() => {
        terminals.feed(res.id, 'No conversation found with session ID x\n');
        terminals.exit(res.id, 1);
      }, 5);
      return res;
    };
    const res = await s.start(req({}));
    expect(res.args).toContain('--settings');
    expect(started.at(-1)!.degraded).toBeNull();
  });
});

describe('IS-77: the agent upgraded itself', () => {
  it('a changed binary is detected again before the next launch', async () => {
    const bin = binWith({ pi: { version: '0.83.0' } });
    const { s } = service(bin);
    expect((await s.list()).find((a) => a.id === 'pi')!.version).toBe('0.83.0');
    writeProgram(join(bin, 'pi'), { version: '1.4.0' });
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(bin, 'pi'), later, later);
    await s.start(req({ agent: 'pi' }));
    expect((await s.list()).find((a) => a.id === 'pi')!.version).toBe('1.4.0');
  });
});

describe('Check again (agents.check)', () => {
  it('looks for our launch options in --help: a missing one fails the items that need it', async () => {
    const help = ['  --session-id <uuid>', '  -r, --resume [value]', '  --fork-session', '  --settings <file-or-json>', '  --mcp-config <configs...>', '  --append-system-prompt <prompt>'].join('\n');
    const { s } = service(binWith({ claude: { version: '2.1.291 (Claude Code)', help } }));
    const r = await s.check('claude');
    expect(entry(r, 'skills')).toMatchObject({ level: 'no', downgrade: 'failed', reason: "--plugin-dir isn't in claude --help" });
    expect(entry(r, 'status')!.level).toBe('yes');
    // 报告也存下来了：list 里是同一份
    expect(entry((await s.list()).find((a) => a.id === 'claude')!.report, 'skills')!.downgrade).toBe('failed');
  });

  it('starts it once with hooks in the last folder, waits for a hook, then closes it; no prompt is sent', async () => {
    const help = '  --session-id --resume --fork-session --settings --mcp-config --plugin-dir --append-system-prompt';
    let answer = false;
    const { s } = service(binWith({ claude: { version: '2.1.291 (Claude Code)', help } }), { waitForHook: async () => answer });
    // 还不知道在哪个目录启动过：不做空启动
    expect(entry(await s.check('claude'), 'status')!.level).toBe('yes');
    expect(await terminals.list()).toHaveLength(0);
    await s.start(req({ cwd: '/work/repo' }));
    const before = (await terminals.list()).length;
    expect(entry(await s.check('claude'), 'status')).toMatchObject({ level: 'partial', via: 'output', reason: "Hooks didn't report when checked" });
    // 空启动的终端关掉了，没有 prompt
    expect(await terminals.list()).toHaveLength(before);
    answer = true;
    expect(entry(await s.check('claude'), 'status')).toMatchObject({ level: 'yes', reason: null });
  });

  it('unknown agents are not-found', async () => {
    const { s } = service(binWith({}));
    await expect(s.check('nope' as never)).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('IS-74 at the service level: a launch whose hooks never reported is noted in the report', () => {
  it('runtime: no SessionStart within the timeout → snapshot degraded and the report’s status says so; a later launch with hooks clears it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const bin = binWith({ claude: { version: '2.1.291 (Claude Code)' } });
      terminals = new FakeTerminalHost({ silenceMs: 0 });
      const rt = createAgentRuntime({
        env: () => ({ PATH: bin }),
        terminals,
        notifyCommand: NOTIFY,
        emit: () => {},
        destructivePatterns: () => [],
        socketPath: join(dir, `unused-${++n}.sock`),
        sessionRoots: null,
        hookTimeoutMs: 10_000,
      });
      const { terminalId: id } = await rt.agents.start(req({}));
      vi.advanceTimersByTime(10_000);
      expect(rt.status.get(id)!.degraded).toBe("Hooks didn't report · status from terminal activity");
      const info = (await rt.agents.list()).find((a) => a.id === 'claude')!;
      expect(entry(info.report, 'status')).toMatchObject({ level: 'partial', via: 'output', reason: "Hooks didn't report at the last launch" });
      const again = await rt.agents.start(req({}));
      rt.status.onHook(again.terminalId, { type: 'session-start', sessionId: again.sessionId! });
      expect(entry((await rt.agents.list()).find((a) => a.id === 'claude')!.report, 'status')!.level).toBe('yes');
      await rt.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('buildReport', () => {
  it('an agent with no record at all: key-pressing items are off, the rest as declared', () => {
    const r = buildReport({
      agent: 'omp',
      label: 'Oh My Pi',
      version: '18.0.4',
      declared: [
        { key: 'approve-keys', level: 'yes', via: 'screen', verifiedUpTo: null, reason: null },
        { key: 'status', level: 'yes', via: 'extension', verifiedUpTo: null, reason: null },
      ],
      record: null,
      checkedAt: '2026-10-28T00:00:00.000Z',
    });
    expect(r.entries).toEqual([
      { key: 'approve-keys', level: 'no', via: 'screen', verifiedUpTo: null, reason: 'Untested on 18.0.4', downgrade: 'off' },
      { key: 'status', level: 'yes', via: 'extension', verifiedUpTo: null, reason: null },
    ]);
  });
});
