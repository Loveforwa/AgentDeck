// 后台 agent 模块（N10）：claude 的 task-notification、记录读取器、SubagentServiceImpl 的钩子处理和事件。
// 钩子负载照 claude 2.1.291 实测的字段手写（不是真对话）。

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SubagentEvent, TerminalId } from '@agentdeck/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ClaudeTranscriptParser,
  claudeSubagentFile,
  isClaudeSyntheticPrompt,
  parseClaudeBackgroundTasks,
  parseClaudeTaskNotification,
  SubagentServiceImpl,
} from '../src/index.ts';

const NOTIFICATION = `<task-notification>
<task-id>a48ad2e2dd0cfcfa8</task-id>
<tool-use-id>toolu_012uKvGGRB9hMbmyVwsqtSg7</tool-use-id>
<status>completed</status>
<summary>Agent "Count" finished</summary>
<result>1
2
3</result>
<usage><subagent_tokens>21893</subagent_tokens><tool_uses>0</tool_uses><duration_ms>1630</duration_ms></usage>
</task-notification>`;

const user = (content: unknown) => JSON.stringify({ type: 'user', isSidechain: true, message: { role: 'user', content } });
const assistant = (id: string, content: unknown[], usage?: object) =>
  JSON.stringify({ type: 'assistant', isSidechain: true, message: { id, model: 'claude-haiku-4-5', role: 'assistant', content, usage } });

describe('claude task notifications', () => {
  it('reads the agent id, status, tokens and duration', () => {
    expect(parseClaudeTaskNotification(NOTIFICATION)).toEqual({ agentId: 'a48ad2e2dd0cfcfa8', status: 'completed', tokens: 21893, durationMs: 1630 });
    expect(parseClaudeTaskNotification('look up the weather')).toBeNull();
  });

  it('tells its own prompts apart from yours', () => {
    expect(isClaudeSyntheticPrompt(NOTIFICATION)).toBe(true);
    expect(isClaudeSyntheticPrompt('查一下天气')).toBe(false);
  });

  it('reads background_tasks as an array or a JSON string', () => {
    const list = [{ id: 'a1', type: 'subagent', status: 'running', description: 'Say hi', agent_type: 'general-purpose' }, { id: 'b', type: 'shell' }];
    const want = [{ id: 'a1', description: 'Say hi', agentType: 'general-purpose', status: 'running' }];
    expect(parseClaudeBackgroundTasks(list)).toEqual(want);
    expect(parseClaudeBackgroundTasks(JSON.stringify(list))).toEqual(want);
    expect(parseClaudeBackgroundTasks('oops')).toEqual([]);
  });

  it('puts the subagent transcript next to the main one', () => {
    expect(claudeSubagentFile('/p/-a/abc.jsonl', 'a1')).toBe('/p/-a/abc/subagents/agent-a1.jsonl');
  });
});

describe('ClaudeTranscriptParser', () => {
  it('turns the transcript into prompt, tool, result and text lines', () => {
    const p = new ClaudeTranscriptParser();
    p.feed(user('Look up the weather in Beijing on 2016-10-26.'));
    p.feed(assistant('m1', [{ type: 'tool_use', id: 't1', name: 'WebSearch', input: { query: 'beijing weather 26 october 2016' } }], {
      input_tokens: 10,
      cache_read_input_tokens: 30000,
      cache_creation_input_tokens: 500,
      output_tokens: 40,
    }));
    p.feed(user([{ type: 'tool_result', tool_use_id: 't1', content: '10 results\nmore' }]));
    p.feed(user([{ type: 'tool_result', tool_use_id: 't2', content: 'denied', is_error: true }]));
    p.feed(assistant('m2', [{ type: 'text', text: 'It was sunny, 18°C.' }], { input_tokens: 5, cache_read_input_tokens: 31000, output_tokens: 20 }));
    p.feed('not json');
    const s = p.snapshot();
    expect(s.lines).toEqual([
      { kind: 'prompt', text: 'Look up the weather in Beijing on 2016-10-26.' },
      { kind: 'tool', text: 'WebSearch beijing weather 26 october 2016' },
      { kind: 'result', text: '10 results …' },
      { kind: 'error', text: 'denied' },
      { kind: 'text', text: 'It was sunny, 18°C.' },
    ]);
    expect(s.tokens).toBe(31025);
    expect(s.lastStep).toBe('It was sunny, 18°C.');
  });
});

describe('SubagentServiceImpl', () => {
  let home: string;
  let main: string;
  let events: SubagentEvent[];
  let svc: SubagentServiceImpl;
  const T = 't1' as TerminalId;
  const hook = (hookName: string, payload: object, agent = 'claude') =>
    svc.noteHook({ terminalId: T, agent, hookName, payload: { session_id: 's1', transcript_path: main, ...payload } });
  const changes = () => events.flatMap((e) => (e.type === 'subagents.changed' ? [e.agents] : []));
  const last = () => changes().at(-1)?.agents ?? [];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'adsub-'));
    main = join(home, 'projects', '-work', 's1.jsonl');
    mkdirSync(dirname(main), { recursive: true });
    writeFileSync(main, '');
    events = [];
    svc = new SubagentServiceImpl({ emit: (e) => events.push(e), pollMs: 20, throttleMs: 5 });
  });

  afterEach(() => {
    svc.close();
    rmSync(home, { recursive: true, force: true });
  });

  const writeAgent = (id: string, description: string, lines: string[]) => {
    const file = claudeSubagentFile(main, id);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ agentType: 'general-purpose', description, requestShape: 'background' }));
    writeFileSync(file, lines.map((l) => `${l}\n`).join(''));
    return file;
  };

  it('lists a started agent with its description and last step, then marks it done', async () => {
    writeAgent('a1', 'Weather 10 years ago', [
      user('Look up the weather.'),
      assistant('m1', [{ type: 'tool_use', id: 't1', name: 'WebFetch', input: { url: 'https://example.com/history' } }], { input_tokens: 1, output_tokens: 2 }),
    ]);
    hook('SubagentStart', { agent_id: 'a1', agent_type: 'general-purpose' });
    await vi.waitFor(() => expect(last()[0]?.description).toBe('Weather 10 years ago'));
    expect(last()[0]).toMatchObject({ state: 'running', background: true, current: true, lastStep: 'WebFetch https://example.com/history', tokens: 3 });

    hook('SubagentStop', { agent_id: 'a1', agent_type: 'general-purpose', agent_transcript_path: claudeSubagentFile(main, 'a1') });
    await vi.waitFor(() => expect(last()[0]?.state).toBe('done'));
    expect(last()[0]?.endedAt).not.toBeNull();
  });

  it('takes tokens and duration from the task notification, and failures from its status', async () => {
    writeAgent('a48ad2e2dd0cfcfa8', 'Count', [user('Count to 3')]);
    writeAgent('a2', 'Check CI', [user('Check the CI logs')]);
    hook('SubagentStart', { agent_id: 'a48ad2e2dd0cfcfa8' });
    hook('SubagentStart', { agent_id: 'a2' });
    hook('UserPromptSubmit', { prompt: NOTIFICATION });
    hook('UserPromptSubmit', { prompt: NOTIFICATION.replace('a48ad2e2dd0cfcfa8', 'a2').replace('completed', 'failed') });
    await vi.waitFor(() => expect(last().map((a) => a.state)).toEqual(['done', 'failed']));
    expect(last()[0]).toMatchObject({ tokens: 21893, durationMs: 1630 });
    expect(last()[1]).toMatchObject({ reason: 'Failed', current: true });
  });

  it('your next message takes finished agents out of the current round; running ones stay', async () => {
    hook('SubagentStart', { agent_id: 'a1' });
    hook('SubagentStart', { agent_id: 'a2' });
    hook('SubagentStop', { agent_id: 'a1' });
    hook('UserPromptSubmit', { prompt: 'thanks, now summarize' });
    await vi.waitFor(() => expect(last().map((a) => [a.id, a.current])).toEqual([['a1', false], ['a2', true]]));
  });

  it('fills the description from background_tasks before meta.json exists', async () => {
    hook('SubagentStart', { agent_id: 'a1' });
    hook('Stop', { background_tasks: [{ id: 'a1', type: 'subagent', status: 'running', description: 'Say hi', agent_type: 'general-purpose' }] });
    await vi.waitFor(() => expect(last()[0]?.description).toBe('Say hi'));
  });

  it('follows a transcript only while someone watches it', async () => {
    const file = writeAgent('a1', 'Say hi', [user('Say hi')]);
    hook('SubagentStart', { agent_id: 'a1' });
    const t = await svc.watchTranscript(T, 'a1');
    expect(t.lines).toEqual([{ kind: 'prompt', text: 'Say hi' }]);
    appendFileSync(file, `${assistant('m1', [{ type: 'text', text: 'hi' }])}\n`);
    await vi.waitFor(() =>
      expect(events.filter((e) => e.type === 'subagents.transcript-changed').at(-1)).toMatchObject({
        transcript: { agentId: 'a1', lines: [{ kind: 'prompt' }, { kind: 'text', text: 'hi' }] },
      }),
    );
    await svc.unwatchTranscript(T, 'a1');
    expect((await svc.watchTranscript(T, 'nope')).state).toBe('no-data');
  });

  it('marks running agents failed when the session ends, and forgets a closed terminal', async () => {
    hook('SubagentStart', { agent_id: 'a1' });
    hook('SessionEnd', {});
    await vi.waitFor(() => expect(last()[0]).toMatchObject({ state: 'failed', reason: 'Session ended' }));
    svc.noteTerminalGone(T);
    expect(changes().at(-1)).toEqual({ terminalId: T, agents: [] });
    expect(await svc.list()).toEqual([]);
  });

  it("ignores a SubagentStop without a SubagentStart (claude's own internal queries)", async () => {
    hook('SubagentStart', { agent_id: 'a1', agent_type: 'general-purpose' });
    hook('SubagentStop', { agent_id: 'internal' });
    hook('SubagentStop', { agent_id: 'a1', agent_type: 'general-purpose' });
    await vi.waitFor(() => expect(last().map((a) => [a.id, a.state])).toEqual([['a1', 'done']]));
  });

  it('ignores other agents and your prompts before any subagent', async () => {
    hook('SubagentStart', { agent_id: 'x' }, 'codex');
    hook('UserPromptSubmit', { prompt: 'hello' });
    await new Promise((r) => setTimeout(r, 30));
    expect(await svc.list()).toEqual([]);
    expect(events).toEqual([]);
  });
});
