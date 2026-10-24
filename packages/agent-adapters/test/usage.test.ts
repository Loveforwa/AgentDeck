// 用量模块（PL2）：各 agent 的读取器（test/usage-fixtures 里是手写的小样例，不是真对话）、
// 找文件、增量读、UsageServiceImpl 的 get / watch / unwatch 和事件。

import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentKind, AgentSessionId, TerminalId, UsageEvent } from '@agentdeck/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ClaudeUsageParser,
  claudeProjectDirName,
  claudeWindow,
  CodexUsageParser,
  JsonlTail,
  KimiUsageParser,
  parseKimiConfig,
  PiUsageParser,
  USAGE_HOOK,
  UsageServiceImpl,
} from '../src/index.ts';
import type { UsageParser, UsageRoots, UsageTarget } from '../src/index.ts';

const FIX = (name: string) => fileURLToPath(new URL(`./usage-fixtures/${name}`, import.meta.url));
const lines = (name: string) => readFileSync(FIX(name), 'utf8').split('\n');
const feedAll = <P extends UsageParser>(p: P, ...names: string[]): P => {
  for (const n of names) for (const l of lines(n)) p.feed(l);
  return p;
};

const CLAUDE_ID = '11111111-1111-4111-8111-111111111111';
const CODEX_ID = '019a0000-0000-7000-8000-000000000001';
const PI_ID = '019e0000-aaaa-7000-8000-000000000002';
const OMP_ID = '01a16e05-44bd-7000-98ad-000000000003';

describe('ClaudeUsageParser', () => {
  it('dedupes split messages by id, sums everything, context from the last main-line answer', () => {
    const u = feedAll(new ClaudeUsageParser(), 'claude.jsonl').snapshot();
    expect(u.requests).toBe(3); // msg_A（两行）、msg_S（子 agent 侧链）、msg_B；<synthetic> 不算
    expect(u.total).toEqual({ input: 15, output: 127, cacheRead: 11100, cacheWrite: 1300, reasoning: 12 });
    expect(u.last).toEqual({ input: 2, output: 80, cacheRead: 6000, cacheWrite: 300, reasoning: null });
    expect(u.model).toBe('claude-opus-5-5');
    expect(u.context).toEqual({ tokens: 6302, window: 1_000_000, percent: 0.6, windowSource: 'model-table' });
    expect(u.updatedAt).toBe('2026-10-25T01:00:05.000Z');
    expect(u.sessionId).toBe(CLAUDE_ID);
  });

  it('context is unknown after a compact boundary until the next answer', () => {
    const u = feedAll(new ClaudeUsageParser(), 'claude.jsonl', 'claude-compact.jsonl').snapshot();
    expect(u.context).toEqual({ tokens: null, window: 1_000_000, percent: null, windowSource: 'model-table' });
    expect(u.requests).toBe(3);
  });

  it('window from the model table; more context than the table allows means 1M', () => {
    expect(claudeWindow('claude-opus-5-5')).toBe(1_000_000);
    expect(claudeWindow('claude-opus-4-6')).toBe(200_000);
    expect(claudeWindow('claude-opus-4-7')).toBe(1_000_000);
    expect(claudeWindow('claude-sonnet-4-5-20250929')).toBe(200_000);
    expect(claudeWindow('claude-sonnet-4-6[1m]')).toBe(1_000_000);
    expect(claudeWindow('claude-haiku-4-5-20251001')).toBe(200_000);
    expect(claudeWindow('some-gateway-model')).toBe(200_000);
    const p = new ClaudeUsageParser();
    p.feed(
      JSON.stringify({
        type: 'assistant',
        message: { id: 'm1', model: 'claude-sonnet-4-6', usage: { input_tokens: 1, cache_read_input_tokens: 250_000, output_tokens: 1 } },
      }),
    );
    expect(p.snapshot().context).toEqual({ tokens: 250_001, window: 1_000_000, percent: 25, windowSource: 'observed' });
  });

  it('no answers yet: no numbers', () => {
    const u = new ClaudeUsageParser().snapshot();
    expect(u).toMatchObject({ requests: 0, total: null, last: null, context: null });
  });

  it('project dir name replaces every non-alphanumeric character', () => {
    expect(claudeProjectDirName('/Users/me/2026/agenduck/.agentdeck-dev/a_b')).toBe('-Users-me-2026-agenduck--agentdeck-dev-a-b');
  });
});

describe('CodexUsageParser', () => {
  it('token_count totals, last request, window and rate limits; duplicates are one request', () => {
    const u = feedAll(new CodexUsageParser(), 'codex.jsonl').snapshot();
    expect(u.requests).toBe(2);
    expect(u.total).toEqual({ input: 1800, output: 150, cacheRead: 1200, cacheWrite: 0, reasoning: 30 });
    expect(u.last).toEqual({ input: 1000, output: 100, cacheRead: 1000, cacheWrite: 0, reasoning: 20 });
    expect(u.context).toEqual({ tokens: 2100, window: 258400, percent: 0.8, windowSource: 'agent' });
    expect(u.model).toBe('gpt-test');
    expect(u.sessionId).toBe(CODEX_ID);
    expect(u.rateLimits).toEqual({
      primary: { usedPercent: 6, windowMinutes: 300, resetsAt: new Date(1792777730 * 1000).toISOString() },
      secondary: { usedPercent: 2, windowMinutes: 10080, resetsAt: new Date(1793323183 * 1000).toISOString() },
    });
    expect(u.updatedAt).toBe('2026-10-23T13:06:20.000Z');
  });

  it('older files without cache_write report it as unknown', () => {
    const p = new CodexUsageParser();
    for (const l of lines('codex.jsonl').slice(0, 5)) p.feed(l);
    expect(p.snapshot().total?.cacheWrite).toBeNull();
  });

  it('context is unknown right after compaction', () => {
    const u = feedAll(new CodexUsageParser(), 'codex.jsonl', 'codex-compact.jsonl').snapshot();
    expect(u.context).toEqual({ tokens: null, window: 258400, percent: null, windowSource: 'agent' });
  });
});

describe('PiUsageParser (pi and omp)', () => {
  it('pi: sums assistant usage, skips aborted zeros, no window from the file', () => {
    const u = feedAll(new PiUsageParser(), 'pi.jsonl').snapshot();
    expect(u.requests).toBe(2);
    expect(u.total).toEqual({ input: 150, output: 50, cacheRead: 2100, cacheWrite: 5, reasoning: 10 });
    expect(u.last).toEqual({ input: 50, output: 30, cacheRead: 1100, cacheWrite: 5, reasoning: 10 });
    expect(u.context).toEqual({ tokens: 1185, window: null, percent: null, windowSource: null });
    expect(u.model).toBe('model-pi');
    expect(u.sessionId).toBe(PI_ID);
  });

  it('omp: reasoningTokens, unknown lines ignored, compaction clears the context', () => {
    const u = feedAll(new PiUsageParser(), 'omp.jsonl').snapshot();
    expect(u.requests).toBe(1);
    expect(u.total).toEqual({ input: 638, output: 291, cacheRead: 24818, cacheWrite: 0, reasoning: 100 });
    expect(u.context?.tokens).toBeNull();
    expect(u.model).toBe('model-omp');
    expect(u.sessionId).toBe(OMP_ID);
  });
});

describe('KimiUsageParser', () => {
  it('usage.record per request, measured context, window from config', () => {
    const cfg = parseKimiConfig(readFileSync(FIX('kimi-config.toml'), 'utf8'));
    expect(cfg.defaultModel).toBe('test/model-a');
    expect([...cfg.windows]).toEqual([
      ['test/model-a', 262144],
      ['test/model-b', 1_000_000],
    ]);
    const p = feedAll(new KimiUsageParser((m) => (m ? (cfg.windows.get(m) ?? null) : null)), 'kimi-wire.jsonl');
    const u = p.snapshot();
    expect(u.requests).toBe(2);
    expect(u.total).toEqual({ input: 20300, output: 392, cacheRead: 24560, cacheWrite: 40, reasoning: null });
    expect(u.last).toEqual({ input: 500, output: 100, cacheRead: 22000, cacheWrite: 40, reasoning: null });
    expect(u.context).toEqual({ tokens: 23990, window: 262144, percent: 9.2, windowSource: 'config' });
    expect(u.model).toBe('test/model-a');
    expect(p.createdAt).toBe(1792847231000);
  });

  it('no window in config: percent unknown', () => {
    const u = feedAll(new KimiUsageParser(), 'kimi-wire.jsonl').snapshot();
    expect(u.context).toEqual({ tokens: 23990, window: null, percent: null, windowSource: null });
  });
});

describe('JsonlTail', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adus-tail-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads only new complete lines; resets when the file shrinks', async () => {
    const file = join(dir, 'a.jsonl');
    const got: string[] = [];
    let resets = 0;
    const tail = new JsonlTail(file, (l) => got.push(l), () => resets++);
    expect(await tail.poll()).toBe(false); // 还没有文件
    writeFileSync(file, '{"a":1}\r\n{"b":"é');
    await tail.poll();
    expect(got).toEqual(['{"a":1}']);
    appendFileSync(file, '"}\n\n{"c":3}\n');
    await tail.poll();
    expect(got).toEqual(['{"a":1}', '{"b":"é"}', '{"c":3}']);
    expect(await tail.poll()).toBe(false);
    writeFileSync(file, '{"d":4}\n');
    await tail.poll();
    expect(resets).toBe(1);
    expect(got.at(-1)).toBe('{"d":4}');
  });

  it('keeps multibyte characters split across reads intact', async () => {
    const file = join(dir, 'b.jsonl');
    const got: string[] = [];
    const tail = new JsonlTail(file, (l) => got.push(l));
    const bytes = Buffer.from('{"t":"用量"}\n', 'utf8');
    writeFileSync(file, bytes.subarray(0, 7));
    await tail.poll();
    appendFileSync(file, bytes.subarray(7));
    await tail.poll();
    expect(got).toEqual(['{"t":"用量"}']);
  });
});

describe('UsageServiceImpl', () => {
  let home: string;
  let roots: UsageRoots;
  let targets: Map<TerminalId, UsageTarget>;
  let events: UsageEvent[];
  let svc: UsageServiceImpl;
  const T = (s: string) => s as TerminalId;
  const S = (s: string) => s as AgentSessionId;
  const track = (id: string, agent: AgentKind, sessionId: string | null, cwd: string | null = '/work/demo', startedAt: number | null = null) =>
    targets.set(T(id), { terminalId: T(id), agent, sessionId: sessionId as AgentSessionId | null, cwd, startedAt });
  const place = (fixture: string, dest: string) => {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(FIX(fixture), dest);
    return dest;
  };
  const make = (extra: Partial<ConstructorParameters<typeof UsageServiceImpl>[0]> = {}) =>
    new UsageServiceImpl({
      lookup: (id) => targets.get(id) ?? null,
      targets: () => [...targets.values()],
      emit: (e) => events.push(e),
      roots,
      pollMs: 20,
      throttleMs: 5,
      relocateMs: 0,
      watchFiles: false,
      ...extra,
    });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'adus-svc-'));
    roots = {
      claude: join(home, '.claude'),
      codex: join(home, '.codex'),
      pi: join(home, '.pi', 'agent'),
      omp: join(home, '.omp', 'agent'),
      kimi: join(home, '.kimi-code'),
    };
    targets = new Map();
    events = [];
    svc = make();
  });
  afterEach(() => {
    svc.close();
    rmSync(home, { recursive: true, force: true });
  });

  it('claude: finds <projects>/<cwd dir>/<session>.jsonl', async () => {
    const cwd = join(home, 'my.proj');
    mkdirSync(cwd);
    const file = place('claude.jsonl', join(roots.claude, 'projects', claudeProjectDirName(cwd), `${CLAUDE_ID}.jsonl`));
    track('t1', 'claude', CLAUDE_ID, cwd);
    const u = await svc.get(T('t1'));
    expect(u).toMatchObject({ state: 'ok', reason: null, agent: 'claude', sessionId: CLAUDE_ID, match: 'exact', file, requests: 3 });
    expect(u.total?.output).toBe(127);
  });

  it('claude: falls back to scanning project dirs, and uses the hook transcript_path', async () => {
    const file = place('claude.jsonl', join(roots.claude, 'projects', 'some-other-dir', `${CLAUDE_ID}.jsonl`));
    track('t1', 'claude', CLAUDE_ID, '/nowhere');
    expect((await svc.get(T('t1'))).file).toBe(file);
    const other = place('claude.jsonl', join(home, 'elsewhere', `${CLAUDE_ID}.jsonl`));
    await svc.watch(T('t1'));
    expect(svc.noteHook({ terminalId: T('t1'), agent: 'claude', hookName: 'Stop', payload: { transcript_path: other } })).toBe(false);
    await vi.waitFor(() => expect(events.at(-1)?.usage.file).toBe(other));
  });

  it('no session id, no file, unknown agent: explicit states, never numbers', async () => {
    track('a', 'codex', null);
    track('b', 'claude', 'ffffffff-0000-4000-8000-000000000000');
    track('c', 'shell', null);
    expect(await svc.get(T('a'))).toMatchObject({ state: 'no-data', reason: 'Waiting for the session id', total: null });
    expect(await svc.get(T('b'))).toMatchObject({ state: 'no-data', reason: 'No session file yet', total: null, context: null });
    expect(await svc.get(T('c'))).toMatchObject({ state: 'unsupported', reason: 'Usage is not available for shell' });
    expect(await svc.get(T('zzz'))).toMatchObject({ state: 'no-data', reason: 'Unknown terminal' });
    // 文件有了，但还没有请求
    const empty = join(roots.claude, 'projects', claudeProjectDirName('/work/demo'), 'ffffffff-0000-4000-8000-000000000000.jsonl');
    mkdirSync(dirname(empty), { recursive: true });
    writeFileSync(empty, '{"type":"user","message":{"role":"user","content":"hi"}}\n');
    expect(await svc.get(T('b'))).toMatchObject({ state: 'no-data', reason: 'No usage recorded yet', file: empty, requests: 0 });
  });

  it('path-like session ids are refused', async () => {
    track('t1', 'claude', '../../etc/passwd');
    expect((await svc.get(T('t1'))).state).toBe('no-data');
  });

  it('codex: finds the newest rollout file for the id, with rate limits', async () => {
    place('codex.jsonl', join(roots.codex, 'sessions', '2026', '10', '22', `rollout-2026-10-22T10-00-00-${CODEX_ID}.jsonl`));
    const file = place('codex.jsonl', join(roots.codex, 'sessions', '2026', '10', '23', `rollout-2026-10-23T21-05-55-${CODEX_ID}.jsonl`));
    track('t1', 'codex', CODEX_ID);
    const u = await svc.get(T('t1'));
    expect(u).toMatchObject({ state: 'ok', file, requests: 2, model: 'gpt-test' });
    expect(u.rateLimits?.primary?.usedPercent).toBe(6);
  });

  it('pi / omp: context window comes from the extension report', async () => {
    place('pi.jsonl', join(roots.pi, 'sessions', '--work-demo--', `2026-10-24T12-48-24-845Z_${PI_ID}.jsonl`));
    place('omp.jsonl', join(roots.omp, 'sessions', '-demo', `2026-10-24T13-06-41-469Z_${OMP_ID}.jsonl`));
    track('p', 'pi', PI_ID);
    track('o', 'omp', OMP_ID);
    expect((await svc.watch(T('p'))).context).toEqual({ tokens: 1185, window: null, percent: null, windowSource: null });
    expect((await svc.get(T('o'))).total?.reasoning).toBe(100);
    const consumed = svc.noteHook({
      terminalId: T('p'),
      agent: 'pi',
      hookName: USAGE_HOOK,
      payload: { session_id: PI_ID, tokens: 1300, contextWindow: 128000, percent: 1.015625, model: 'model-pi' },
    });
    expect(consumed).toBe(true);
    await vi.waitFor(() =>
      expect(events.at(-1)?.usage.context).toEqual({ tokens: 1300, window: 128000, percent: 1, windowSource: 'agent' }),
    );
    // 别的会话报的不算
    svc.noteHook({ terminalId: T('p'), agent: 'pi', hookName: USAGE_HOOK, payload: { session_id: 'other', tokens: 9, contextWindow: 10, percent: 90 } });
    await new Promise((r) => setTimeout(r, 60));
    expect(events.at(-1)?.usage.context?.tokens).toBe(1185);
  });

  it('kimi: exact id from the index, or inferred by directory and start time', async () => {
    const cwd = join(home, 'proj');
    mkdirSync(cwd);
    const T0 = 1792847230000;
    const sessionDir = (n: string) => join(roots.kimi, 'sessions', 'wd_proj_abc', `session_${n}`);
    const wire = (n: string, createdAt: number) => {
      const f = join(sessionDir(n), 'agents', 'main', 'wire.jsonl');
      mkdirSync(dirname(f), { recursive: true });
      const body = readFileSync(FIX('kimi-wire.jsonl'), 'utf8').replace('"created_at":1792847231000', `"created_at":${createdAt}`);
      writeFileSync(f, body);
      return f;
    };
    const w1 = wire('one', T0 + 1000);
    const w2 = wire('two', T0 + 60_000);
    wire('old', T0 - 3_600_000);
    writeFileSync(
      join(roots.kimi, 'session_index.jsonl'),
      ['one', 'two', 'old'].map((n) => JSON.stringify({ sessionId: `session_${n}`, sessionDir: sessionDir(n), workDir: cwd })).join('\n') + '\n',
    );
    copyFileSync(FIX('kimi-config.toml'), join(roots.kimi, 'config.toml'));
    track('a', 'kimi', null, cwd, T0);
    track('b', 'kimi', null, cwd, T0 + 59_000);
    track('c', 'kimi', 'session_old', cwd, null);
    const a = await svc.get(T('a'));
    expect(a).toMatchObject({ state: 'ok', match: 'inferred', file: w1, sessionId: 'session_one', requests: 2 });
    expect(a.context).toEqual({ tokens: 23990, window: 262144, percent: 9.2, windowSource: 'config' });
    expect(await svc.get(T('b'))).toMatchObject({ match: 'inferred', file: w2, sessionId: 'session_two' });
    expect(await svc.get(T('c'))).toMatchObject({ match: 'exact', sessionId: 'session_old' });
    track('d', 'kimi', null, join(home, 'elsewhere'), T0);
    expect(await svc.get(T('d'))).toMatchObject({ state: 'no-data', reason: 'No session file yet' });
  });

  it('watch: emits usage.changed after each new request; unwatch stops it and forgets the terminal', async () => {
    const cwd = '/work/demo';
    const file = place('claude.jsonl', join(roots.claude, 'projects', claudeProjectDirName(cwd), `${CLAUDE_ID}.jsonl`));
    track('t1', 'claude', CLAUDE_ID, cwd);
    const first = await svc.watch(T('t1'));
    expect(first.requests).toBe(3);
    appendFileSync(
      file,
      JSON.stringify({
        type: 'assistant',
        isSidechain: false,
        timestamp: '2026-10-25T01:01:00.000Z',
        message: { id: 'msg_C', model: 'claude-opus-5-5', usage: { input_tokens: 4, cache_read_input_tokens: 6302, output_tokens: 9 } },
      }) + '\n',
    );
    await vi.waitFor(() => expect(events.at(-1)?.usage.requests).toBe(4));
    expect(events.at(-1)?.usage.last).toEqual({ input: 4, output: 9, cacheRead: 6302, cacheWrite: 0, reasoning: null });
    const n = events.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(events.length).toBe(n); // 没变就不发
    await svc.unwatch(T('t1'));
    appendFileSync(file, JSON.stringify({ type: 'assistant', message: { id: 'msg_D', usage: { input_tokens: 1, output_tokens: 1 } } }) + '\n');
    await new Promise((r) => setTimeout(r, 80));
    expect(events.length).toBe(n);
  });

  it('a new session id (claude /clear) switches to the new file', async () => {
    const cwd = '/work/demo';
    place('claude.jsonl', join(roots.claude, 'projects', claudeProjectDirName(cwd), `${CLAUDE_ID}.jsonl`));
    track('t1', 'claude', CLAUDE_ID, cwd);
    await svc.watch(T('t1'));
    track('t1', 'claude', 'eeeeeeee-0000-4000-8000-000000000000', cwd);
    svc.noteSession(T('t1'));
    await vi.waitFor(() => expect(events.at(-1)?.usage).toMatchObject({ state: 'no-data', reason: 'No session file yet' }));
  });

  it('fs.watch path also delivers updates', async () => {
    svc.close();
    svc = make({ watchFiles: true, pollMs: 60_000 });
    const cwd = '/work/demo';
    const file = place('codex.jsonl', join(roots.codex, 'sessions', '2026', '10', '23', `rollout-x-${CODEX_ID}.jsonl`));
    track('t1', 'codex', S(CODEX_ID), cwd);
    await svc.watch(T('t1'));
    const extra = lines('codex.jsonl')[7]!.replace(/3150/g, '4150').replace('"input_tokens":3000', '"input_tokens":4000');
    appendFileSync(file, extra + '\n');
    await vi.waitFor(() => expect(events.at(-1)?.usage.requests).toBe(3), { timeout: 3000 });
  });

  it('the extension uses the same hook name', () => {
    const src = readFileSync(fileURLToPath(new URL('../../../tools/agentdeck-notify/bin/agentdeck-pi-extension.mjs', import.meta.url)), 'utf8');
    expect(src).toContain(`export const USAGE_HOOK = '${USAGE_HOOK}';`);
  });
});
