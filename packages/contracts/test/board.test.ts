import { describe, expect, it } from 'vitest';
import { boardPinKey, type AgentSessionId, type ProjectId, type WindowId, type WorkspaceId } from '../src/index.ts';

describe('boardPinKey（MP1）', () => {
  it('每种置顶一个不重复的 key', () => {
    expect(boardPinKey({ kind: 'session', agent: 'claude', sessionId: 'abc' as AgentSessionId })).toBe('session:claude:abc');
    expect(boardPinKey({ kind: 'session', agent: 'codex', sessionId: 'abc' as AgentSessionId })).toBe('session:codex:abc');
    expect(boardPinKey({ kind: 'window', windowId: 'w1' as WindowId })).toBe('window:w1');
    expect(boardPinKey({ kind: 'project', projectId: 'p1' as ProjectId })).toBe('project:p1');
    expect(boardPinKey({ kind: 'workspace', workspaceId: 'p1' as WorkspaceId })).toBe('workspace:p1');
  });
});
