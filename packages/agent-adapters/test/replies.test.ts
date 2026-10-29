// contracts 0.1.22：最后一条回复（AgentService.lastReply、以后的 CrewService.result）。临时目录里的假会话文件，按 2026-10-28 本机核对的格式。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { TerminalId } from '@agentdeck/contracts';
import { createLastReply, lastReplyFromLines, readLastReply, replyFromScreenLines } from '../src/replies/index.ts';
import { UsageServiceImpl } from '../src/usage/service.ts';
import { claudeProjectDirName } from '../src/usage/claude.ts';

const dir = mkdtempSync(join(tmpdir(), 'ads-replies-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const j = (x: unknown) => JSON.stringify(x);

const claudeLines = [
  j({ type: 'user', isSidechain: false, message: { role: 'user', content: 'Fix the login bug' }, timestamp: '2026-10-28T08:00:00.000Z' }),
  j({ type: 'assistant', isSidechain: false, message: { id: 'msg_A', model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'thinking', thinking: '' }] }, timestamp: '2026-10-28T08:00:01.000Z' }),
  j({ type: 'assistant', isSidechain: false, message: { id: 'msg_A', model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'Found it in auth.ts.' }] }, timestamp: '2026-10-28T08:00:02.000Z' }),
  j({ type: 'assistant', isSidechain: false, message: { id: 'msg_A', model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'The token was not refreshed.' }] }, timestamp: '2026-10-28T08:00:03.000Z' }),
  j({ type: 'assistant', isSidechain: false, message: { id: 'msg_A', model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: {} }] }, timestamp: '2026-10-28T08:00:04.000Z' }),
  j({ type: 'user', isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] }, timestamp: '2026-10-28T08:00:05.000Z' }),
  // 子 agent 的、claude 自己插的不算
  j({ type: 'assistant', isSidechain: true, message: { id: 'msg_S', model: 'claude-haiku-4-5', role: 'assistant', content: [{ type: 'text', text: 'sub-agent text' }] }, timestamp: '2026-10-28T08:00:06.000Z' }),
  j({ type: 'assistant', isSidechain: false, message: { id: 'msg_X', model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: "You've hit your limit" }] }, timestamp: '2026-10-28T08:00:07.000Z' }),
  'this line is not json',
];

const codexLines = [
  j({ timestamp: '2026-10-28T08:11:25.000Z', type: 'session_meta', payload: { id: 'c-1', cwd: '/w' } }),
  j({ timestamp: '2026-10-28T08:11:30.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Looking at it.' }], phase: 'commentary' } }),
  j({ timestamp: '2026-10-28T08:11:32.099Z', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'HERON' }], phase: 'final_answer' } } }),
  j({ timestamp: '2026-10-28T08:11:32.101Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'HERON' }], phase: 'final_answer' } }),
  j({ timestamp: '2026-10-28T08:11:32.131Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'HERON', turn_id: 't1' } }),
  j({ timestamp: '2026-10-28T08:11:33.000Z', type: 'event_msg', payload: { type: 'token_count', info: null } }),
];

describe('last reply from the transcript', () => {
  it('claude: the last text reply, its text blocks joined; sub-agents and synthetic lines skipped', () => {
    expect(lastReplyFromLines('claude', claudeLines)).toEqual({
      text: 'Found it in auth.ts.\n\nThe token was not refreshed.',
      at: '2026-10-28T08:00:03.000Z',
    });
  });

  it('codex: the last of task_complete / assistant message / AgentMessage', () => {
    expect(lastReplyFromLines('codex', codexLines)).toEqual({ text: 'HERON', at: '2026-10-28T08:11:32.131Z' });
    // 这一轮还没完：最后一条 assistant 消息
    expect(lastReplyFromLines('codex', codexLines.slice(0, 2))).toEqual({ text: 'Looking at it.', at: '2026-10-28T08:11:30.000Z' });
  });

  it('pi / omp: the last assistant message with text', () => {
    const lines = [
      j({ type: 'message', timestamp: '2026-10-24T12:48:31.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello from pi' }] } }),
      j({ type: 'message', timestamp: '2026-10-24T12:48:33.000Z', message: { role: 'assistant', content: [] } }),
    ];
    expect(lastReplyFromLines('pi', lines)).toEqual({ text: 'Hello from pi', at: '2026-10-24T12:48:31.000Z' });
    expect(lastReplyFromLines('omp', lines)?.text).toBe('Hello from pi');
  });

  it('agents whose transcript is not read (kimi, shell) give null', () => {
    expect(lastReplyFromLines('kimi', claudeLines)).toBeNull();
    expect(lastReplyFromLines('shell', claudeLines)).toBeNull();
  });

  it('reads only the end of the file, and more of it when the reply is further back', async () => {
    const file = join(dir, 'long.jsonl');
    const filler = Array.from({ length: 400 }, (_, i) => j({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'x'.repeat(200) + i }] } }));
    writeFileSync(file, [...claudeLines.slice(0, 4), ...filler].join('\n') + '\n');
    expect((await readLastReply('claude', file, { tailBytes: 4096 }))?.text).toBe('Found it in auth.ts.\n\nThe token was not refreshed.');
    expect(await readLastReply('claude', join(dir, 'missing.jsonl'))).toBeNull();
  });
});

describe('createLastReply', () => {
  const screen = ['', '⏺ Done. All 12 tests pass.', '', '╭────────╮', '│ >      │', '╰────────╯', '', ''];

  it('transcript first; the screen when there is no session file or nothing in it', async () => {
    const file = join(dir, 'codex.jsonl');
    writeFileSync(file, codexLines.join('\n') + '\n');
    const files = new Map<string, { agent: 'codex' | 'claude'; file: string }>([['t1', { agent: 'codex', file }], ['t2', { agent: 'claude', file: join(dir, 'empty.jsonl') }]]);
    writeFileSync(join(dir, 'empty.jsonl'), '');
    const read = createLastReply({
      sessionFile: async (id) => files.get(id) ?? null,
      terminals: {
        lastLines: async (id) => {
          if (id === 'gone') throw Object.assign(new Error('Terminal gone not found'), { code: 'not-found' });
          return screen;
        },
      },
    });
    expect(await read('t1' as TerminalId)).toEqual({ text: 'HERON', source: 'transcript', at: '2026-10-28T08:11:32.131Z' });
    expect(await read('t2' as TerminalId)).toEqual({ text: '⏺ Done. All 12 tests pass.\n\n╭────────╮\n│ >      │\n╰────────╯', source: 'screen', at: null });
    expect(await read('t3' as TerminalId)).toMatchObject({ source: 'screen' });
    await expect(read('gone' as TerminalId)).rejects.toMatchObject({ code: 'not-found' });
  });

  it('screen fallback keeps the last 20 lines, without trailing blank ones', () => {
    expect(replyFromScreenLines(['', '  ', ''])).toBeNull();
    const many = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    expect(replyFromScreenLines(many)?.split('\n')).toEqual(many.slice(-20));
  });

  it('UsageServiceImpl.sessionFile finds the claude transcript by session id without reading it', async () => {
    const root = join(dir, 'claude-root');
    const cwd = '/work/demo';
    const sid = '11111111-1111-4111-8111-111111111111';
    const projectDir = join(root, 'projects', claudeProjectDirName(cwd));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, `${sid}.jsonl`), claudeLines.join('\n'));
    const usage = new UsageServiceImpl({
      lookup: (id) => (id === 't1' ? { terminalId: id, agent: 'claude', sessionId: sid as never, cwd, startedAt: null } : id === 's1' ? { terminalId: id, agent: 'shell', sessionId: null, cwd, startedAt: null } : null),
      emit: () => {},
      roots: { claude: root, codex: join(dir, 'none'), pi: join(dir, 'none'), omp: join(dir, 'none'), kimi: join(dir, 'none') },
      watchFiles: false,
    });
    expect(await usage.sessionFile('t1' as TerminalId)).toEqual({ agent: 'claude', file: join(projectDir, `${sid}.jsonl`) });
    expect(await usage.sessionFile('s1' as TerminalId)).toBeNull();
    expect(await usage.sessionFile('nope' as TerminalId)).toBeNull();
    const read = createLastReply({ sessionFile: (id) => usage.sessionFile(id), terminals: { lastLines: async () => [] } });
    expect(await read('t1' as TerminalId)).toMatchObject({ source: 'transcript', text: 'Found it in auth.ts.\n\nThe token was not refreshed.' });
    usage.close();
  });
});
