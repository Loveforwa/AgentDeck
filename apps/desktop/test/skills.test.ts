// N9：启动终端时找到它在白板上存的 skill 选择（重启：刚 kill 的那个；接回：同一个会话），自带 skill 写进数据目录。

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionId, BoardState, TerminalId, TerminalWindowData, WindowId, WindowNode } from '@agentdeck/contracts';
import { createRecentKills, RESTART_WINDOW_MS, skillSelectionFor, writeBuiltinSkills } from '../src/main/skills.ts';

function term(id: string, data: Partial<TerminalWindowData>): WindowNode {
  return {
    id: id as WindowId,
    type: 'terminal',
    workspaceId: null,
    rect: { x: 0, y: 0, w: 1, h: 1 },
    z: 0,
    title: null,
    restoreRect: null,
    data: { terminalId: null, agent: 'claude', cmd: 'claude', args: [], cwd: '/repo', sessionId: null, startCommand: null, ...data },
  };
}

function board(windows: WindowNode[]) {
  const state: BoardState = { version: 1, viewport: { x: 0, y: 0, zoom: 1 }, frames: [], windows, panel: { open: true, width: 320 }, savedAt: '' };
  return { load: async () => state };
}

describe('skillSelectionFor', () => {
  const windows = [
    term('w1', { terminalId: 't1' as TerminalId, sessionId: 's1' as AgentSessionId, skills: ['skill:library:xlsx'] }),
    term('w2', { terminalId: 't2' as TerminalId, sessionId: 's2' as AgentSessionId, skills: ['mcp:library:github'] }),
    term('w3', { terminalId: 't3' as TerminalId, agent: 'codex', cwd: '/repo', skills: ['mcp:library:docs'] }),
  ];

  it('a restart: the window whose terminal was just killed (same agent and folder)', async () => {
    const kills = createRecentKills();
    kills.note('t2' as TerminalId, 1000);
    const sel = await skillSelectionFor({ agent: 'claude', cwd: '/repo', mode: { kind: 'new' } }, { board: board(windows), recentKills: kills, now: 2000 });
    expect(sel).toEqual(['mcp:library:github']);
    // 换成 Shell 重启（agent 变了）：不带
    expect(await skillSelectionFor({ agent: 'shell', cwd: '/repo', mode: { kind: 'new' } }, { board: board(windows), recentKills: kills, now: 2000 })).toBeNull();
    // 太久以前 kill 的不算
    expect(
      await skillSelectionFor({ agent: 'claude', cwd: '/repo', mode: { kind: 'new' } }, { board: board(windows), recentKills: kills, now: 1000 + RESTART_WINDOW_MS + 1 }),
    ).toBeNull();
  });

  it('the most recently killed wins', async () => {
    const kills = createRecentKills();
    kills.note('t1' as TerminalId, 1000);
    kills.note('t2' as TerminalId, 1500);
    expect(await skillSelectionFor({ agent: 'claude', cwd: '/repo', mode: { kind: 'new' } }, { board: board(windows), recentKills: kills, now: 1600 })).toEqual([
      'mcp:library:github',
    ]);
  });

  it('resume: the window with the same session; a new terminal gets the defaults (null)', async () => {
    const kills = createRecentKills();
    const deps = { board: board(windows), recentKills: kills };
    expect(await skillSelectionFor({ agent: 'claude', cwd: '/repo', mode: { kind: 'resume', sessionId: 's1' as AgentSessionId } }, deps)).toEqual(['skill:library:xlsx']);
    expect(await skillSelectionFor({ agent: 'claude', cwd: '/repo', mode: { kind: 'new' } }, deps)).toBeNull();
    expect(await skillSelectionFor({ agent: 'claude', cwd: '/repo', mode: { kind: 'fork', sessionId: 's1' as AgentSessionId } }, deps)).toBeNull();
  });

  it('a board that can’t be read means the defaults', async () => {
    const sel = await skillSelectionFor(
      { agent: 'claude', cwd: '/repo', mode: { kind: 'new' } },
      { board: { load: () => Promise.reject(new Error('locked')) }, recentKills: createRecentKills() },
    );
    expect(sel).toBeNull();
  });
});

describe('recent kills', () => {
  it('wrap() records kill and passes everything else through', async () => {
    const kills = createRecentKills();
    const kill = vi.fn(async (_id: TerminalId) => {});
    const terminals = { kill, other: () => 'x', startError: null };
    const wrapped = kills.wrap(terminals);
    await wrapped.kill('t9' as TerminalId);
    expect(kill).toHaveBeenCalledWith('t9');
    expect(kills.since('t9' as TerminalId)).not.toBeNull();
    expect(wrapped.other()).toBe('x');
    expect(wrapped.startError).toBeNull();
  });
});

describe('writeBuiltinSkills', () => {
  it('writes the agentdeck skill', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ad-builtin-'));
    try {
      await writeBuiltinSkills(dir);
      expect(readFileSync(join(dir, 'agentdeck', 'SKILL.md'), 'utf8')).toMatch(/^---\nname: agentdeck\n/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
