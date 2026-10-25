// X4 · Fork 对话：每种 agent fork 的启动参数（从另一个目录开）、fork 前找原来的对话（临时目录里的假会话文件）、
// 找不到时 AgentService 不开终端。真 agent 跨目录的实测记录在 AGENTS.md「Fork 对话」（DR-42）。

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentDeckError } from '@agentdeck/contracts';
import type { AgentSessionId, CreateTerminalRequest, LaunchContext, StartAgentRequest, TerminalId } from '@agentdeck/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../src/adapters/claude.ts';
import { CodexAdapter } from '../src/adapters/codex.ts';
import { KnownAgentAdapter } from '../src/adapters/generic.ts';
import { createDefaultAdapters } from '../src/adapters/index.ts';
import { KNOWN_AGENTS } from '../src/adapters/known.ts';
import { AgentServiceImpl } from '../src/agent-service.ts';
import { conversationCheckFromEnv, conversationExists } from '../src/fork.ts';
import { createAgentRuntime } from '../src/runtime.ts';
import { defaultUsageRoots } from '../src/usage/locate.ts';

const NOTIFY = '/opt/agentdeck/agentdeck-notify';
const SOURCE = 'b5e5c51f-25db-4ab1-bf98-888087addea4' as AgentSessionId;
/** fork 到的目录：另一个 worktree。 */
const TARGET = '/repo/.worktrees/feat-b';

function ctx(over: Partial<LaunchContext> = {}): LaunchContext {
  return {
    cwd: TARGET,
    terminalId: 'pending' as TerminalId,
    mode: { kind: 'fork', sessionId: SOURCE },
    notifyCommand: NOTIFY,
    extraArgs: [],
    ...over,
  };
}

function known(id: string) {
  const def = KNOWN_AGENTS.find((a) => a.id === id)!;
  return new KnownAgentAdapter(def, { env: () => ({}), newSessionId: () => 'new-id' });
}

let home: string;
let bin: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'adf-home-'));
  bin = mkdtempSync(join(tmpdir(), 'adf-bin-'));
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\necho "2.1.291 (Claude Code)"\n');
  chmodSync(join(bin, 'claude'), 0o755);
});
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
});

describe('fork launch args per agent (X4)', () => {
  it('claude: --resume <id> --fork-session with our new --session-id; the target folder is only the cwd', () => {
    const spec = new ClaudeAdapter({ env: () => ({}), newSessionId: () => 'new-id' }).launch(ctx());
    expect(spec.args.slice(0, 5)).toEqual(['--resume', SOURCE, '--fork-session', '--session-id', 'new-id']);
    expect(spec.sessionId).toBe('new-id');
  });

  it('codex: fork -C <target> <id>, so the TUI does not ask which folder to use', () => {
    const spec = new CodexAdapter({ env: () => ({}) }).launch(ctx());
    expect(spec.args.slice(0, 4)).toEqual(['fork', '-C', TARGET, SOURCE]);
    expect(spec.sessionId).toBeNull(); // 新 id 等 SessionStart
  });

  it('pi: --fork <id> --session-id <new>; omp: --fork <id>', () => {
    expect(known('pi').launch(ctx())).toMatchObject({ args: ['--fork', SOURCE, '--session-id', 'new-id'], sessionId: 'new-id' });
    expect(known('omp').launch(ctx())).toMatchObject({ args: ['--fork', SOURCE], sessionId: null });
  });

  it('kimi: not supported', () => {
    expect(known('kimi').capabilities('2.3.1').fork).toBe(false);
    expect(() => known('kimi').launch(ctx())).toThrow("Kimi can't fork a conversation");
  });
});

describe('conversationExists (X4)', () => {
  const roots = () => defaultUsageRoots(home);
  const write = (path: string) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '{}\n');
  };

  it('finds the session file wherever the original folder was; false before the first message', async () => {
    const check = conversationExists(roots());
    for (const agent of ['claude', 'codex', 'pi', 'omp'] as const) expect(await check(agent, SOURCE)).toBe(false);

    // 原来的对话在另一个项目目录（/repo）下，不在目标目录对应的地方
    write(join(home, '.claude', 'projects', '-repo', `${SOURCE}.jsonl`));
    write(join(home, '.codex', 'sessions', '2026', '10', '26', `rollout-2026-10-26T00-00-00-${SOURCE}.jsonl`));
    write(join(home, '.pi', 'agent', 'sessions', '--repo--', `2026-10-26T00-00-00-000Z_${SOURCE}.jsonl`));
    write(join(home, '.omp', 'agent', 'sessions', '--repo--', `2026-10-26T00-00-00-000Z_${SOURCE}.jsonl`));
    for (const agent of ['claude', 'codex', 'pi', 'omp'] as const) expect(await check(agent, SOURCE)).toBe(true);

    expect(await check('kimi', SOURCE)).toBeNull();
    expect(await check('claude', '../etc' as AgentSessionId)).toBe(false); // 带路径的 id 不拼路径
  });

  it('conversationCheckFromEnv follows HOME and CLAUDE_CONFIG_DIR of the login env; no HOME means unknown', async () => {
    const config = join(home, 'claude-config');
    write(join(config, 'projects', '-elsewhere', 'only-here.jsonl'));
    const check = conversationCheckFromEnv(() => ({ HOME: home, CLAUDE_CONFIG_DIR: config }));
    expect(await check('claude', 'only-here' as AgentSessionId)).toBe(true);
    expect(await check('claude', SOURCE)).toBe(false); // 另一个配置目录里没有
    expect(await conversationCheckFromEnv(() => ({}))('claude', SOURCE)).toBeNull();
  });
});

describe('AgentService fork (X4)', () => {
  function service(check: (agent: string, id: AgentSessionId) => Promise<boolean | null>) {
    const created: CreateTerminalRequest[] = [];
    const env = { PATH: bin };
    const s = new AgentServiceImpl({
      adapters: createDefaultAdapters({ env: () => env }),
      terminals: {
        create: async (req) => {
          created.push(req);
          return { id: `term-${created.length}` as TerminalId };
        },
      },
      env: () => env,
      notifyCommand: NOTIFY,
      conversationExists: check,
    });
    return { s, created };
  }
  const req: StartAgentRequest = { agent: 'claude', cwd: TARGET, workspaceId: null, mode: { kind: 'fork', sessionId: SOURCE } };

  it('starts claude in the target folder with the fork args when the conversation exists', async () => {
    const seen: string[] = [];
    const { s, created } = service(async (agent, id) => (seen.push(`${agent}:${id}`), true));
    const res = await s.start(req);
    expect(seen).toEqual([`claude:${SOURCE}`]);
    expect(created).toHaveLength(1);
    expect(created[0]!.cwd).toBe(TARGET);
    expect(created[0]!.args.slice(0, 4)).toEqual(['--resume', SOURCE, '--fork-session', '--session-id']);
    expect(res.sessionId).not.toBe(SOURCE);
  });

  it('does not open a terminal when there is no conversation yet', async () => {
    const { s, created } = service(async () => false);
    const err = await s.start(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentDeckError);
    expect((err as AgentDeckError).code).toBe('not-found');
    expect((err as AgentDeckError).message).toBe('No conversation to fork yet. Send Claude Code a message first.');
    expect(created).toHaveLength(0);
  });

  it('unknown (null) or a failing check still starts; new and resume are not checked', async () => {
    let calls = 0;
    const { s, created } = service(async () => {
      calls++;
      throw new Error('disk on fire');
    });
    await s.start(req);
    expect(created).toHaveLength(1);
    await s.start({ ...req, mode: { kind: 'new' } });
    await s.start({ ...req, mode: { kind: 'resume', sessionId: SOURCE } });
    expect(calls).toBe(1);
    const unknown = service(async () => null);
    await unknown.s.start(req);
    expect(unknown.created).toHaveLength(1);
  });

  it('createAgentRuntime checks sessionRoots by default; null turns the check off', async () => {
    const env = { PATH: bin };
    const created: CreateTerminalRequest[] = [];
    const terminals = {
      create: async (r: CreateTerminalRequest) => {
        created.push(r);
        return { id: `term-${created.length}` as TerminalId };
      },
    };
    const base = { env: () => env, terminals, notifyCommand: NOTIFY, emit: () => {}, destructivePatterns: () => [] };
    const empty = mkdtempSync(join(tmpdir(), 'adf-empty-'));
    try {
      const checked = createAgentRuntime({ ...base, sessionRoots: defaultUsageRoots(empty) });
      expect(await checked.agents.start(req).catch((e: AgentDeckError) => e.code)).toBe('not-found');
      const off = createAgentRuntime({ ...base, sessionRoots: null });
      await off.agents.start(req);
      expect(created).toHaveLength(1);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
