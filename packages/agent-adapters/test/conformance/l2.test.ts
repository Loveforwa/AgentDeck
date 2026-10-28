// 适配器合格测试 L2（AH2）：真程序在 tmux 里跑（tmux -L agentdeck-conformance -f /dev/null），默认跳过。
//   AGENTDECK_REAL_AGENTS=1 pnpm --filter @agentdeck/agent-adapters conformance [--agent pi]
// 跑完把结果写进 compat/<agent>.json（版本、日期、每项 pass / fail / skip），再生成 src/compat/records.ts。没跑的项保留原来的记录。
//
// pi、omp、kimi 接本地假模型（support/fake-model.ts），临时 HOME（配置、会话都写在临时目录里），不用账号、不花钱。
// claude、codex 用你登录的账号：只问不改文件的问题（批准请求一律 Esc 拒绝），一共四五轮很短的对话；会话记录会留在
// ~/.claude/projects、~/.codex/sessions 里（不去删，不改 agent 自己的目录）。目录用本包下的 .conformance/（已在 .gitignore），
// 在信任过的仓库里，不会弹“信任这个文件夹吗”。
// 屏幕上的启动对话框（omp 的首次设置、kimi 的信任框）由这里的脚手架代替用户处理，产品代码不认这些字。

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentKind, AgentSessionId, StatusEvent, TerminalId, TerminalStatus } from '@agentdeck/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { declared } from '../../src/capabilities/declare.ts';
import { CONFORMANCE_AGENTS, SCENARIOS } from '../../src/compat/scenarios.ts';
import type { ScenarioId } from '../../src/compat/scenarios.ts';
import type { CompatItem, CompatRecord } from '../../src/compat/types.ts';
import { compareVersions, findExecutable, readVersion } from '../../src/env.ts';
import { HistoryServiceImpl } from '../../src/history/service.ts';
import type { ReceivedHook } from '../../src/hook-server.ts';
import { createAgentRuntime } from '../../src/runtime.ts';
import type { AgentRuntime } from '../../src/runtime.ts';
import { defaultUsageRoots, UsageServiceImpl } from '../../src/usage/index.ts';
import type { UsageRoots } from '../../src/usage/index.ts';
import { writeRecords } from './records.mjs';
import { startFakeModel } from './support/fake-model.ts';
import type { FakeModel } from './support/fake-model.ts';
import { ConformanceTmuxHost } from './support/tmux-host.ts';

const REAL = process.env.AGENTDECK_REAL_AGENTS === '1';
const ONLY = (process.env.AGENTDECK_CONFORMANCE_AGENTS ?? '').split(',').filter(Boolean);
const PKG = fileURLToPath(new URL('../..', import.meta.url));
const NOTIFY = fileURLToPath(new URL('../../../../tools/agentdeck-notify/bin/agentdeck-notify.mjs', import.meta.url));
const EXTENSION = fileURLToPath(new URL('../../../../tools/agentdeck-notify/bin/agentdeck-pi-extension.mjs', import.meta.url));
const TODAY = new Date().toISOString().slice(0, 10);
const CODE = 'PELICAN';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- 每家 agent 怎么准备 ----

interface Sandbox {
  /** 窗格里额外的环境（临时 HOME 等）。 */
  paneEnv: Record<string, string>;
  extraArgs: string[];
  /** 用量、历史从哪里读。 */
  roots: UsageRoots;
  fake: FakeModel | null;
}

interface Profile {
  agent: AgentKind;
  /** 用假模型（不花钱）。 */
  fake: boolean;
  setup(home: string, fake: FakeModel | null): Sandbox;
  /** 启动后、输入框出现前的对话框：返回要按的键（脚手架），null 表示没有。 */
  scaffold?(screen: string): string[] | null;
  /** 输入框出现了。 */
  ready(screen: string): boolean;
  /** 恢复会话用的 id：一般就是状态机记下的；kimi 从它自己的 session_index.jsonl 里找。 */
  sessionIdFor?(sandbox: Sandbox, cwd: string): string | null;
}

const realHome = process.env.HOME!;

const PROFILES: Record<string, Profile> = {
  claude: {
    agent: 'claude',
    fake: false,
    setup: () => ({ paneEnv: {}, extraArgs: ['--permission-mode', 'default'], roots: defaultUsageRoots(realHome, process.env), fake: null }),
    ready: (s) => /❯|>\s/.test(s) && /Claude Code/.test(s),
  },
  codex: {
    agent: 'codex',
    fake: false,
    // 只读沙箱、按需批准：要跑命令就会问（问了就 Esc 拒绝）
    setup: () => ({ paneEnv: {}, extraArgs: ['-a', 'on-request', '-s', 'read-only'], roots: defaultUsageRoots(realHome, process.env), fake: null }),
    scaffold: (s) => (/Skip until next version/.test(s) ? ['Escape'] : null),
    ready: (s) => /Ask Codex to do anything|for shortcuts|›/.test(s),
  },
  pi: {
    agent: 'pi',
    fake: true,
    setup: (home, fake) => {
      const dir = join(home, '.pi', 'agent');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'models.json'),
        JSON.stringify({
          providers: {
            fake: {
              baseUrl: fake!.url,
              api: 'openai-completions',
              apiKey: 'x',
              compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
              models: [{ id: 'fake-model' }],
            },
          },
        }),
      );
      return { paneEnv: { HOME: home, PI_OFFLINE: '1' }, extraArgs: ['--provider', 'fake', '--model', 'fake-model'], roots: defaultUsageRoots(home), fake };
    },
    // 仓库里有 AGENTS.md 这类项目文件时先问信任（记在临时 HOME 里）
    scaffold: (s) => (/Trust project folder\?/.test(s) ? ['Enter'] : null),
    ready: (s) => /pi v\d/.test(s) && !/Trust project folder/.test(s),
  },
  omp: {
    agent: 'omp',
    fake: true,
    setup: (home, fake) => {
      const dir = join(home, '.omp', 'agent');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'models.yml'),
        [
          'providers:',
          '  fake:',
          `    baseUrl: ${fake!.url}`,
          '    api: openai-completions',
          '    apiKey: x',
          '    compat:',
          '      supportsDeveloperRole: false',
          '      supportsReasoningEffort: false',
          '    models:',
          '      - id: fake-model',
          '',
        ].join('\n'),
      );
      return {
        paneEnv: { HOME: home },
        extraArgs: ['--model', 'fake/fake-model', '--approval-mode', 'always-ask', '--no-title'],
        roots: defaultUsageRoots(home),
        fake,
      };
    },
    // 第一次启动的设置向导：Esc 一步步跳过（只在临时 HOME 里）
    scaffold: (s) => (/Setup step \d+ of \d+/.test(s) ? ['Escape'] : null),
    ready: (s) => /fake-model/.test(s) && !/Setup step/.test(s),
  },
  kimi: {
    agent: 'kimi',
    fake: true,
    setup: (home, fake) => {
      const dir = join(home, '.kimi-code');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'config.toml'),
        [
          'default_model = "fake/fake-model"',
          '',
          '[providers.fake]',
          'type = "openai"',
          'api_key = "x"',
          `base_url = "${fake!.url}"`,
          '',
          '[models."fake/fake-model"]',
          'provider = "fake"',
          'model = "fake-model"',
          'max_context_size = 128000',
          'max_output_size = 4096',
          'capabilities = [ "tool_use" ]',
          'display_name = "Fake"',
          '',
        ].join('\n'),
      );
      return { paneEnv: { HOME: home, KIMI_CODE_HOME: dir }, extraArgs: [], roots: defaultUsageRoots(home), fake };
    },
    // 新目录第一次打开时的信任框：替用户选 Trust and continue（只记在临时 HOME 里）
    scaffold: (s) => (/Trust this folder\?/.test(s) ? ['Enter'] : null),
    ready: (s) => /context: \d+%/.test(s) && !/Trust this folder/.test(s),
    sessionIdFor: (sb, cwd) => {
      const file = join(sb.roots.kimi, 'session_index.jsonl');
      if (!existsSync(file)) return null;
      const rows = readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { sessionId?: string; workDir?: string });
      return rows.filter((r) => r.workDir === cwd).at(-1)?.sessionId ?? null;
    },
  },
};

// ---- 结果 ----

type Outcome = Pick<CompatItem, 'result' | 'reason'>;

function compatPath(agent: string): string {
  return join(PKG, 'compat', `${agent}.json`);
}

function writeCompat(agent: AgentKind, version: string | null, outcomes: Map<ScenarioId, Outcome>): void {
  const file = compatPath(agent);
  const prev: CompatRecord | null = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as CompatRecord) : null;
  const results: CompatRecord['results'] = { ...(prev?.results ?? {}) };
  for (const s of SCENARIOS) {
    const o = outcomes.get(s.id);
    if (!o) continue;
    const before = results[s.id];
    results[s.id] = {
      result: o.result,
      suite: 'L2',
      ...(o.reason ? { reason: o.reason } : {}),
      // 通过才前进；失败、跳过保留原来的值（跳过但以前手工核对过的，记录照旧）
      verifiedUpTo: o.result === 'pass' ? version : (before?.verifiedUpTo ?? null),
    };
    if (o.result === 'skip' && before && before.suite === 'manual') results[s.id] = before;
  }
  const failed = [...outcomes.values()].some((o) => o.result === 'fail');
  const passed = [...outcomes.values()].some((o) => o.result === 'pass');
  const record: CompatRecord = {
    agent,
    version,
    date: TODAY,
    verifiedUpTo: failed || !passed ? (prev?.verifiedUpTo ?? null) : maxVersion(prev?.verifiedUpTo ?? null, version),
    results,
    ...(prev?.notes ? { notes: prev.notes } : {}),
  };
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  writeRecords(PKG);
}

function maxVersion(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return compareVersions(a, b) >= 0 ? a : b;
}

// ---- 跑一家 ----

const selected = CONFORMANCE_AGENTS.filter((a) => ONLY.length === 0 || ONLY.includes(a));

for (const agent of selected) {
  const profile = PROFILES[agent]!;
  describe.skipIf(!REAL)(`L2 · ${agent}`, () => {
    const outcomes = new Map<ScenarioId, Outcome>();
    let installed = false;
    let version: string | null = null;
    let root: string;
    let sb: Sandbox;
    let host: ConformanceTmuxHost;
    let rt: AgentRuntime;
    let events: StatusEvent[];
    let hooks: ReceivedHook[];
    let cwdA: string;
    let cwdB: string;
    let first: { terminalId: TerminalId; sessionId: string | null } | null = null;
    let worktreesBefore: string[] = [];
    let sockDir: string | null = null;
    let ready = false;
    const worktreeList = (): string[] => {
      try {
        return execFileSync('git', ['-C', PKG, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' })
          .split('\n')
          .filter((l) => l.startsWith('worktree '))
          .sort();
      } catch {
        return [];
      }
    };

    const status = (id: TerminalId): TerminalStatus | undefined => rt.status.get(id)?.status;
    const turnEnds = (id: TerminalId) => events.filter((e) => e.type === 'agent.turn-end' && e.terminalId === id).length;

    async function waitFor(what: string, id: TerminalId | null, pred: () => boolean, timeoutMs = 90_000): Promise<void> {
      const until = Date.now() + timeoutMs;
      while (!pred()) {
        if (id && profile.scaffold) {
          const keys = profile.scaffold(host.screen(id));
          if (keys) await host.sendKeys(id, keys);
        }
        if (Date.now() > until) throw new Error(`timed out waiting for ${what}\n${id ? host.screen(id) : ''}`);
        await sleep(400);
      }
    }

    async function start(mode: Parameters<AgentRuntime['agents']['start']>[0]['mode'], cwd: string, prompt?: string) {
      const res = await rt.agents.start({ agent, cwd, workspaceId: null, mode, ...(prompt ? { prompt } : {}) });
      await waitFor(`${agent} input box`, res.terminalId, () => profile.ready(host.screen(res.terminalId)), 60_000);
      return res;
    }

    async function say(id: TerminalId, text: string): Promise<void> {
      rt.noteInput(id);
      await host.type(id, text);
    }

    /** 记一项。fn 抛错算 fail（照样往外抛，测试显示失败）。 */
    function k(id: ScenarioId, fn: () => Promise<void>, timeoutMs = 180_000) {
      const s = SCENARIOS.find((x) => x.id === id)!;
      it(`${id} ${s.title}`, async () => {
        if (!installed) {
          outcomes.set(id, { result: 'skip', reason: `${agent} is not installed here` });
          return;
        }
        // 除了 K1、K2，都要用 K2 开起来的那个会话
        if (id !== 'K1' && id !== 'K2' && !first) {
          outcomes.set(id, { result: 'skip', reason: 'K2 did not pass, so there is no session to use' });
          return;
        }
        const entry = s.capability ? declared(rt.agents.adapter(agent)!.declareCapabilities!(version), s.capability) : null;
        if (s.capability && (!entry || entry.level === 'no')) {
          outcomes.set(id, { result: 'skip', reason: entry?.reason ?? 'Declared No' });
          return;
        }
        try {
          await fn();
          outcomes.set(id, { result: 'pass' });
        } catch (e) {
          outcomes.set(id, { result: 'fail', reason: String(e instanceof Error ? e.message : e).split('\n')[0]!.slice(0, 200) });
          throw e;
        }
      }, timeoutMs);
    }
    /** L2 不跑的项，写明原因。 */
    function skip(id: ScenarioId, reason: string) {
      const s = SCENARIOS.find((x) => x.id === id)!;
      it.skip(`${id} ${s.title} — skip: ${reason}`, () => {});
      outcomes.set(id, { result: 'skip', reason });
    }

    beforeAll(async () => {
      const path = await findExecutable(agent, process.env as Record<string, string>);
      installed = path !== null;
      if (!installed) return;
      version = await readVersion(path!, process.env as Record<string, string>);
      worktreesBefore = worktreeList();
      root = join(PKG, '.conformance', `${agent}-${process.pid}`);
      cwdA = join(root, 'a');
      cwdB = join(root, 'b');
      for (const d of [cwdA, cwdB]) mkdirSync(d, { recursive: true });
      const fake = profile.fake ? await startFakeModel() : null;
      sb = profile.setup(join(root, 'home'), fake);
      events = [];
      hooks = [];
      // unix socket 的路径不能太长（macOS 104 字节），放在系统临时目录
      sockDir = mkdtempSync(join(tmpdir(), 'adconf-'));
      const socketPath = join(sockDir, 'hooks.sock');
      host = new ConformanceTmuxHost(() => ({ ...sb.paneEnv, AGENTDECK_HOOK_SOCKET: socketPath }));
      const loginEnv = { ...(process.env as Record<string, string>) };
      rt = createAgentRuntime({
        env: () => loginEnv,
        terminals: host,
        notifyCommand: NOTIFY,
        agentExtension: EXTENSION,
        socketPath,
        emit: (e) => events.push(e),
        destructivePatterns: () => [],
        extraArgs: (a) => (a === agent ? sb.extraArgs : []),
        sessionRoots: sb.roots,
        tapHook: (h) => {
          hooks.push(h);
          return false;
        },
      });
      host.on((e) => rt.onTerminalEvent(e));
      await rt.start();
      ready = true;
    }, 60_000);

    afterAll(async () => {
      if (!installed) {
        for (const s of SCENARIOS) if (!outcomes.has(s.id)) outcomes.set(s.id, { result: 'skip', reason: `${agent} is not installed here` });
      }
      host?.dispose();
      await rt?.close();
      await sb?.fake?.close();
      if (root) rmSync(root, { recursive: true, force: true });
      if (sockDir) rmSync(sockDir, { recursive: true, force: true });
      // 准备没做完（tmux、socket 出错）时不写记录
      if (REAL && (ready || !installed)) writeCompat(agent, version, outcomes);
    }, 30_000);

    k('K1', async () => {
      const info = (await rt.agents.list()).find((a) => a.id === agent)!;
      expect(info.installed).toBe(true);
      expect(info.version).toBe(version);
      expect(version).toMatch(/^\d+\.\d+\.\d+/);
    });

    k('K2', async () => {
      const res = await start({ kind: 'new' }, cwdA, `reply with the word ${CODE}`);
      first = { terminalId: res.terminalId, sessionId: res.sessionId };
      const id = res.terminalId;
      await waitFor('the answer', id, () => host.screen(id).split('\n').some((l) => l.includes(CODE) && !l.includes('reply with the word')), 120_000);
      // 假模型收到的就是原文
      if (sb.fake) expect(sb.fake.userTexts().some((t) => t.includes(`reply with the word ${CODE}`))).toBe(true);
      await waitFor('idle after the first turn', id, () => status(id) === 'idle', 60_000);
    });

    k('K3', async () => {
      const id = first!.terminalId;
      if (agent === 'kimi') {
        await waitFor('kimi session index', id, () => profile.sessionIdFor!(sb, cwdA) !== null, 30_000);
        const u = await usageOf(id, null);
        expect(u.sessionId).toBe(profile.sessionIdFor!(sb, cwdA));
        return;
      }
      await waitFor('session id', id, () => !!rt.status.get(id)?.sessionId, 30_000);
      const sid = rt.status.get(id)!.sessionId!;
      if (first!.sessionId) expect(sid).toBe(first!.sessionId);
      // agent 自己写的会话文件对得上
      const u = await usageOf(id, sid);
      expect(u.file).toContain(sid);
    });

    k('K4', async () => {
      const id = first!.terminalId;
      const before = turnEnds(id);
      const from = events.length;
      // 看状态事件，不轮询：假模型回答得很快，running 可能只有几十毫秒
      const ranSince = () =>
        events.slice(from).some((e) => e.type === 'status.changed' && e.snapshot.terminalId === id && e.snapshot.status === 'running');
      await say(id, 'reply with the word HERON');
      await waitFor('running', id, ranSince, 30_000);
      await waitFor('idle with a turn-end', id, () => status(id) === 'idle' && (agent === 'kimi' || turnEnds(id) > before), 120_000);
    });

    {
      k('K5', async () => {
        const id = first!.terminalId;
        const target = join(root, `${agent}-probe`);
        const ask =
          agent === 'omp'
            ? `run the command: touch ${target}`
            : `Run the shell command \`touch ${target}\` with your shell tool${agent === 'codex' ? ' (it needs approval because the sandbox is read-only)' : ''}. Do nothing else.`;
        await say(id, ask);
        await waitFor('needs-approval', id, () => status(id) === 'needs-approval', 120_000);
        expect(rt.status.get(id)!.pending).toMatchObject({ kind: 'approval', command: expect.stringContaining(`touch ${target}`) });
      });
    }

    if (agent === 'omp') {
      k('K6', async () => {
        const id = first!.terminalId;
        const pending = rt.status.get(id)!.pending!;
        const [r] = await rt.approvals.approve([pending.id]);
        expect(r).toMatchObject({ ok: true });
        await waitFor('the command ran', id, () => existsSync(join(root, 'omp-probe')), 60_000);
        await waitFor('idle', id, () => status(id) === 'idle', 60_000);
      });
    } else if (agent === 'claude' || agent === 'codex') {
      skip('K6', 'Approving would change files; the hook answer was checked by hand (AGENTS.md, Auto-approve)');
    } else k('K6', async () => {});

    k('K7', async () => {
      const id = first!.terminalId;
      if (agent === 'claude' || agent === 'codex') {
        // 还停在 K5 的确认框上：Esc 拒绝
        expect(status(id)).toBe('needs-approval');
      } else {
        await say(id, agent === 'omp' ? `run the command: touch ${join(root, 'omp-denied')}` : 'think slowly');
        await waitFor(agent === 'omp' ? 'needs-approval' : 'running', id, () => status(id) === (agent === 'omp' ? 'needs-approval' : 'running'), 60_000);
        await sleep(1000);
      }
      rt.noteInput(id);
      await host.sendKeys(id, ['Escape']);
      await waitFor('idle after Esc', id, () => status(id) === 'idle', 30_000);
      // 拒绝了：命令没跑
      expect(existsSync(join(root, agent === 'omp' ? 'omp-denied' : `${agent}-probe`))).toBe(false);
    });

    {
      k('K8', async () => {
        const id = first!.terminalId;
        await say(id, agent === 'omp' ? 'ask me a question' : 'Use the AskUserQuestion tool to ask me whether I prefer tea or coffee. Do nothing else.');
        await waitFor('needs-reply', id, () => status(id) === 'needs-reply', 120_000);
        rt.noteInput(id);
        await host.sendKeys(id, ['Enter']);
        await waitFor('idle after the answer', id, () => status(id) === 'idle', 120_000);
      });
    }

    k('K9', async () => {
      const id = first!.terminalId;
      const sid = profile.sessionIdFor ? profile.sessionIdFor(sb, cwdA) : rt.status.get(id)!.sessionId!;
      expect(sid).toBeTruthy();
      await host.kill(id);
      const res = await start({ kind: 'resume', sessionId: sid as AgentSessionId }, cwdA);
      const n0 = recallCount(res.terminalId, CODE);
      await say(res.terminalId, 'what was the word I asked you to reply with at the very start? Reply with just that word.');
      await waitFor('the code word again', res.terminalId, () => recallCount(res.terminalId, CODE) > n0, 120_000);
      first = { terminalId: res.terminalId, sessionId: sid };
    });

    k('K10', async () => {
      const sid = first!.sessionId!;
      const res = await start({ kind: 'fork', sessionId: sid as AgentSessionId }, cwdB);
      const n0 = recallCount(res.terminalId, CODE);
      await say(res.terminalId, 'what was the word I asked you to reply with at the very start? Reply with just that word.');
      await waitFor('the code word in the fork', res.terminalId, () => recallCount(res.terminalId, CODE) > n0, 120_000);
      expect(host.cwd(res.terminalId)).toBe(cwdB);
      await host.kill(res.terminalId);
    });

    k('K11', async () => {
      const sid = first!.sessionId ?? (profile.sessionIdFor ? profile.sessionIdFor(sb, cwdA) : null);
      const list = await new HistoryServiceImpl({ roots: sb.roots }).list();
      expect(list.some((s) => s.agent === agent && s.id === sid)).toBe(true);
    });

    k('K12', async () => {
      const u = await usageOf(first!.terminalId, first!.sessionId);
      expect(u.state).toBe('ok');
      expect(u.total).not.toBeNull();
    });

    k('K13', async () => {
      const u = await usageOf(first!.terminalId, first!.sessionId);
      expect(u.rateLimits?.primary?.resetsAt).toBeTruthy();
    });

    skip('K14', "Needs AgentDeck's MCP server running; packages/mcp-server checks it with real agents");
    skip('K15', "Checked with the agent's own loader (AGENTS.md, Skills · MCP), not in the TUI yet");
    it.todo('K16 missing hooks fall back to terminal activity and say so (AH3)');
    skip('K17', "Can't make a real agent reject an option on purpose; L1 covers it with a fake program");

    k('K18', async () => {
      const id = first!.terminalId;
      expect(host.cwd(id)).toBe(cwdA);
      // claude 的钩子负载带 cwd：一直是框的目录（没有进 EnterWorktree）
      const cwds = hooks.filter((h) => h.terminalId === id).map((h) => (h.envelope.payload as { cwd?: string } | null)?.cwd).filter(Boolean);
      for (const c of cwds) expect(c).toBe(cwdA);
      // agent 没有自己另开 git worktree
      expect(worktreeList()).toEqual(worktreesBefore);
    });

    /**
     * 答出了暗号几次。claude、codex 数这个终端带 word 的 Stop 钩子（last_assistant_message）；假模型那几家数假模型收到的、
     * 问 “what was the word” 而前面的对话里带着 “reply with the word <word>” 的请求（说明 agent 把原来的对话接上了，假模型就按它回答）。
     * 不看屏幕：接回的会话会把以前的回答也画出来。
     */
    function recallCount(id: TerminalId, word: string): number {
      if (sb.fake) {
        return sb.fake.requests.filter((r) => {
          const users = r.messages.filter((m) => m.role === 'user').map((m) => JSON.stringify(m.content ?? ''));
          return /what was the word/i.test(users.at(-1) ?? '') && users.slice(0, -1).some((u) => u.includes(`reply with the word ${word}`));
        }).length;
      }
      return hooks.filter((h) => {
        if (h.terminalId !== id || h.hookName !== 'Stop') return false;
        const msg = (h.envelope.payload as { last_assistant_message?: string } | null)?.last_assistant_message;
        return !!msg && msg.includes(word);
      }).length;
    }

    async function usageOf(id: TerminalId, sessionId: string | null) {
      const usage = new UsageServiceImpl({
        lookup: (t) => (t === id ? { terminalId: id, agent, sessionId: sessionId as AgentSessionId | null, cwd: cwdA, startedAt: 0 } : null),
        emit: () => {},
        roots: sb.roots,
        watchFiles: false,
      });
      return usage.get(id);
    }
  });
}
