// 历史会话（N11，DR-62）：各 agent 的读取器和 HistoryServiceImpl。样例照 2026-10-26 本机核对的字段手写（不是真对话）。

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HistoryServiceImpl, oneLine, parseCodexIndex, parseKimiState, readClaudeSession, readCodexSession, readPiSession } from '../src/index.ts';
import type { UsageRoots } from '../src/index.ts';

const jsonl = (...rows: object[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

let home: string;
let roots: UsageRoots;
const put = (file: string, text: string, mtime?: Date) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  if (mtime) utimesSync(file, mtime, mtime);
  return file;
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'adhist-'));
  roots = { claude: join(home, '.claude'), codex: join(home, '.codex'), pi: join(home, '.pi/agent'), omp: join(home, '.omp/agent'), kimi: join(home, '.kimi-code') };
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

const claudeLine = (extra: object) => ({ cwd: '/work/shop', gitBranch: 'feat/login', entrypoint: 'cli', sessionId: 'c1', timestamp: '2026-10-26T09:00:00.000Z', ...extra });

describe('readers', () => {
  it('oneLine keeps the first non-empty line and cuts long text', () => {
    expect(oneLine('\n  Fix the   login bug \nmore')).toBe('Fix the login bug');
    expect(oneLine('x'.repeat(200))!.length).toBe(120);
    expect(oneLine('  ')).toBeNull();
  });

  it('claude: custom title beats the agent title, which beats the first prompt; skips its own inserted prompts', async () => {
    const f = put(
      join(roots.claude, 'projects/-work-shop/c1.jsonl'),
      jsonl(
        claudeLine({ type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } }),
        claudeLine({ type: 'user', message: { role: 'user', content: 'Fix the login bug\nplease' } }),
        claudeLine({ type: 'assistant', message: { model: 'claude-opus-5-5', role: 'assistant', content: [] } }),
        { type: 'ai-title', aiTitle: 'Login fix', sessionId: 'c1' },
        { type: 'custom-title', customTitle: 'OAuth work', sessionId: 'c1' },
      ),
    );
    expect(await readClaudeSession(f)).toMatchObject({
      id: 'c1',
      cwd: '/work/shop',
      branch: 'feat/login',
      title: 'OAuth work',
      titleKind: 'custom',
      firstPrompt: 'Fix the login bug',
      source: 'terminal',
      model: 'claude-opus-5-5',
      startedAt: '2026-10-26T09:00:00.000Z',
    });
  });

  it('claude: scripted runs and empty sessions are not listed; desktop sessions are; HEAD is no branch', async () => {
    const sdk = put(join(roots.claude, 'projects/a/s.jsonl'), jsonl(claudeLine({ entrypoint: 'sdk-cli', type: 'user', message: { content: 'hi' } })));
    const empty = put(join(roots.claude, 'projects/a/e.jsonl'), jsonl({ type: 'permission-mode', permissionMode: 'auto' }));
    const desk = put(
      join(roots.claude, 'projects/a/d.jsonl'),
      jsonl(claudeLine({ entrypoint: 'claude-desktop', gitBranch: 'HEAD', type: 'user', message: { content: [{ type: 'text', text: 'Plan the week' }] } })),
    );
    expect(await readClaudeSession(sdk)).toBeNull();
    expect(await readClaudeSession(empty)).toBeNull();
    expect(await readClaudeSession(desk)).toMatchObject({ source: 'desktop', title: 'Plan the week', titleKind: 'prompt', branch: null });
  });

  it('claude: finds the title at the end of a big file', async () => {
    const filler = Array.from({ length: 2000 }, (_, i) => claudeLine({ type: 'user', isMeta: true, message: { content: `x${i}`.repeat(30) } }));
    const f = put(
      join(roots.claude, 'projects/a/big.jsonl'),
      jsonl(claudeLine({ type: 'user', message: { content: 'Start here' } }), ...filler, { type: 'ai-title', aiTitle: 'Late title' }),
    );
    expect(await readClaudeSession(f)).toMatchObject({ title: 'Late title', titleKind: 'agent', firstPrompt: 'Start here' });
  });

  it('codex: thread name from session_index, else the first prompt; scripts and subagents are not listed', async () => {
    const meta = (id: string, source: unknown, originator = 'codex-tui') => ({
      type: 'session_meta',
      payload: { id, cwd: '/work/api', timestamp: '2026-10-26T08:00:00.000Z', source, originator, git: { branch: 'main' } },
    });
    const userMsg = (text: string) => ({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text }] } } });
    const settings = { type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-6.1-sol' } } };
    const index = parseCodexIndex(jsonl({ id: 'x1', thread_name: 'Old name' }, { id: 'x1', thread_name: 'Review API' }), jsonl({ session_id: 'x3', text: 'From history' }));
    const named = put(join(home, 'c/1.jsonl'), jsonl(meta('x1', 'cli'), settings, userMsg('ignored')));
    const prompt = put(join(home, 'c/2.jsonl'), jsonl(meta('x2', 'vscode', 'Codex Desktop'), userMsg('Explain the build')));
    const hist = put(join(home, 'c/3.jsonl'), jsonl(meta('x3', 'vscode', 'claudian')));
    const exec = put(join(home, 'c/4.jsonl'), jsonl(meta('x4', 'exec'), userMsg('scripted')));
    const sub = put(join(home, 'c/5.jsonl'), jsonl(meta('x5', { subagent: { other: 'guardian' } }), userMsg('child')));
    expect(await readCodexSession(named, index)).toMatchObject({ id: 'x1', title: 'Review API', titleKind: 'agent', source: 'terminal', branch: 'main', model: 'gpt-6.1-sol' });
    expect(await readCodexSession(prompt, index)).toMatchObject({ title: 'Explain the build', titleKind: 'prompt', source: 'desktop' });
    expect(await readCodexSession(hist, index)).toMatchObject({ title: 'From history', source: 'ide' });
    expect(await readCodexSession(exec, index)).toBeNull();
    expect(await readCodexSession(sub, index)).toBeNull();
  });

  it('pi and omp: session line (second for omp, after its title line), first user message, model', async () => {
    const session = { type: 'session', version: 3, id: 'p1', timestamp: '2026-10-26T07:00:00.000Z', cwd: '/work/web' };
    const user = { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'helo' }] } };
    const pi = put(join(home, 'p.jsonl'), jsonl(session, { type: 'model_change', modelId: 'deepseek-v4-flash' }, user));
    const omp = put(join(home, 'o.jsonl'), jsonl({ type: 'title', title: 'Add DeepSeek', pad: '   ' }, session, user, { type: 'title_change', title: 'Add DeepSeek V4.1' }));
    expect(await readPiSession(pi)).toMatchObject({ id: 'p1', cwd: '/work/web', title: 'helo', titleKind: 'prompt', model: 'deepseek-v4-flash' });
    expect(await readPiSession(omp)).toMatchObject({ title: 'Add DeepSeek V4.1', titleKind: 'agent', firstPrompt: 'helo' });
  });

  it('kimi: state.json, archived sessions are not listed', () => {
    const state = { id: 'session_k1', cwd: '/work/web', title: '你好', isCustomTitle: false, lastPrompt: '好的', createdAt: 1792847231205, updatedAt: 1792847343395 };
    expect(parseKimiState(JSON.stringify(state))).toMatchObject({ id: 'session_k1', title: '你好', titleKind: 'agent', updatedAt: new Date(1792847343395).toISOString() });
    expect(parseKimiState(JSON.stringify({ ...state, archived: true }))).toBeNull();
    expect(parseKimiState('not json')).toBeNull();
  });
});

describe('HistoryServiceImpl', () => {
  it('lists every agent newest first, skips subagent folders, and rereads only changed files', async () => {
    const t = (h: number) => new Date(Date.UTC(2026, 9, 26, h));
    put(join(roots.claude, 'projects/-work-shop/c1.jsonl'), jsonl(claudeLine({ type: 'user', message: { content: 'Claude one' } })), t(1));
    put(join(roots.claude, 'projects/-work-shop/c1/subagents/agent-a1.jsonl'), jsonl(claudeLine({ type: 'user', message: { content: 'child' } })), t(9));
    put(
      join(roots.codex, 'sessions/2026/10/26/rollout-2026-10-26T00-00-00-x1.jsonl'),
      jsonl({ type: 'session_meta', payload: { id: 'x1', cwd: '/work/api', source: 'cli', timestamp: '2026-10-26T00:00:00.000Z' } }),
      t(3),
    );
    put(join(roots.codex, 'session_index.jsonl'), jsonl({ id: 'x1', thread_name: 'Codex one' }));
    put(join(roots.pi, 'sessions/--work--/a_p1.jsonl'), jsonl({ type: 'session', id: 'p1', cwd: '/work' }, { type: 'message', message: { role: 'user', content: 'Pi one' } }), t(2));
    put(join(roots.kimi, 'sessions/wd_x/session_k1/state.json'), JSON.stringify({ id: 'session_k1', cwd: '/work', title: 'Kimi one', updatedAt: t(4).getTime() }));

    const svc = new HistoryServiceImpl({ roots });
    const first = await svc.list();
    expect(first.map((s) => [s.agent, s.title])).toEqual([
      ['kimi', 'Kimi one'],
      ['codex', 'Codex one'],
      ['pi', 'Pi one'],
      ['claude', 'Claude one'],
    ]);
    expect(first[1]).toMatchObject({ id: 'x1', cwd: '/work/api', updatedAt: t(3).toISOString() });

    // 改了 claude 的那个：重读，排到最前；codex 的名字改了也重读
    put(join(roots.claude, 'projects/-work-shop/c1.jsonl'), jsonl(claudeLine({ type: 'user', message: { content: 'Claude one' } }), { type: 'ai-title', aiTitle: 'Renamed' }), t(5));
    put(join(roots.codex, 'session_index.jsonl'), jsonl({ id: 'x1', thread_name: 'Codex renamed' }));
    const second = await svc.list();
    expect(second.map((s) => s.title)).toEqual(['Renamed', 'Kimi one', 'Codex renamed', 'Pi one']);
  });

  it('copes with missing agent folders', async () => {
    expect(await new HistoryServiceImpl({ roots }).list()).toEqual([]);
  });
});
