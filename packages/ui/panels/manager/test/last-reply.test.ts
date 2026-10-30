// CO4 搬过来：开着的 agent 一行悬停提示里的最后一条回复（先读会话记录，读不到认屏幕）。
import type { TerminalId } from '@agentdeck/contracts';
import { describe, expect, it, vi } from 'vitest';
import { agentReplyReader, replyFromScreen } from '../src/index.ts';

describe('last reply from the screen', () => {
  it('finds the last claude reply above the input box', () => {
    const lines = [
      '> Run the load test',
      '',
      '⏺ Bash(pnpm bench)',
      '  ⎿  p50 41ms',
      '',
      '⏺ The p99 spike comes from the cold pool in db/pool.ts:88.',
      '  I can raise idleTimeout or add a keep-alive.',
      '',
      '╭────────────────────────────────────────╮',
      '│ >                                      │',
      '╰────────────────────────────────────────╯',
      '  ? for shortcuts',
    ];
    expect(replyFromScreen(lines)).toEqual({
      text: 'The p99 spike comes from the cold pool in db/pool.ts:88.\nI can raise idleTimeout or add a keep-alive.',
      source: 'screen',
      kind: 'reply',
    });
  });

  it('finds a codex reply above a plain prompt line and falls back to the last lines', () => {
    expect(replyFromScreen(['› fix it', '', '• Fixed the off-by-one in cart.ts.', '', '› ', '  ⏎ send   ⇧⏎ newline'])).toMatchObject({
      text: 'Fixed the off-by-one in cart.ts.',
      kind: 'reply',
    });
    expect(replyFromScreen(['one', 'two', 'three', 'four', 'five', ''])).toEqual({ text: 'two\nthree\nfour\nfive', source: 'screen', kind: 'lines' });
    expect(replyFromScreen(['', '  '])).toBeNull();
  });

  it('clips long replies', () => {
    const many = ['● start', ...Array.from({ length: 20 }, (_, i) => `line ${i}`)];
    const r = replyFromScreen(many)!;
    expect(r.text.split('\n')).toHaveLength(8);
    expect(r.text.endsWith('…')).toBe(true);
  });
});

describe('agentReplyReader (contracts 0.1.22)', () => {
  const screenLines = ['⏺ From the screen.', '', '╭──────────╮', '│ >        │', '╰──────────╯'];
  const api = (lastReply?: (id: TerminalId) => Promise<{ text: string | null; source: 'transcript' | 'screen'; at: string | null }>) => ({
    terminals: { lastLines: vi.fn(async () => screenLines) } as never,
    agents: (lastReply ? { lastReply } : {}) as never,
  });

  it('uses the transcript when agents.lastReply reads one (blank lines merged)', async () => {
    const a = api(async () => ({ text: 'Fixed it.\n\n\n\nAll tests pass.', source: 'transcript', at: null }));
    expect(await agentReplyReader(a)('t1' as TerminalId)).toEqual({ text: 'Fixed it.\n\nAll tests pass.', source: 'transcript', kind: 'reply' });
  });

  it('falls back to reading the screen: no lastReply (fakes, old builds), a screen-only answer, or an error', async () => {
    const fromScreen = { text: 'From the screen.', source: 'screen', kind: 'reply' };
    expect(await agentReplyReader(api())('t1' as TerminalId)).toEqual(fromScreen);
    expect(await agentReplyReader(api(async () => ({ text: 'x', source: 'screen', at: null })))('t1' as TerminalId)).toEqual(fromScreen);
    expect(await agentReplyReader(api(async () => Promise.reject(new Error('boom'))))('t1' as TerminalId)).toEqual(fromScreen);
    expect(await agentReplyReader(api(async () => ({ text: '  ', source: 'transcript', at: null })))('t1' as TerminalId)).toEqual(fromScreen);
  });
});
