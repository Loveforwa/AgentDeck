import { describe, expect, it } from 'vitest';
import type { StatusSnapshot, TerminalId, WindowId, WindowNode, WorkspaceId } from '@agentdeck/contracts';
import { isWaiting, nextWaiting, prevWaiting, runningLabel, summarize, waitingLabel, waitingPosition } from '../src/model/attention.ts';

const WS_A = 'ws-a' as WorkspaceId;
const WS_B = 'ws-b' as WorkspaceId;

function term(id: string, ws: WorkspaceId | null, terminalId: string | null): WindowNode {
  return {
    id: id as WindowId,
    type: 'terminal',
    workspaceId: ws,
    rect: { x: 0, y: 0, w: 100, h: 100 },
    z: 1,
    title: null,
    restoreRect: null,
    data: { terminalId, agent: 'claude', cmd: 'claude', args: [], cwd: '/', sessionId: null, startCommand: null },
  };
}

function snap(terminalId: string, status: StatusSnapshot['status'], since = '2026-10-23T10:00:00.000Z'): StatusSnapshot {
  return { terminalId: terminalId as TerminalId, status, since, exitCode: null, pending: null };
}

describe('attention (S3)', () => {
  const windows = [
    term('w1', WS_A, 't1'),
    term('w2', WS_A, 't2'),
    term('w3', WS_B, 't3'),
    term('w4', null, 't4'),
    term('w5', WS_B, null),
    { ...term('w6', WS_B, null), type: 'browser', data: { url: 'http://localhost:3000/', mode: 'frame' } },
  ];
  const statuses = {
    t1: snap('t1', 'running'),
    t2: snap('t2', 'needs-approval', '2026-10-23T10:05:00.000Z'),
    t3: snap('t3', 'needs-reply', '2026-10-23T10:01:00.000Z'),
    t4: snap('t4', 'running'),
  };

  it('counts running and waiting windows, per workspace too', () => {
    const s = summarize({ windows, statuses, badges: {} });
    expect(s.running).toBe(2);
    expect(s.waiting).toEqual(['w3', 'w2']); // 最早开始等的在前
    expect(s.waitingByWorkspace).toEqual({ [WS_A]: 1, [WS_B]: 1 });
    expect(waitingLabel(s.waitingByWorkspace[WS_A])).toBe('1 waiting');
    expect(waitingLabel(undefined)).toBe('');
  });

  it('counts running terminals per workspace, the same way as the top bar total (IS-64)', () => {
    const more = { ...statuses, t3: snap('t3', 'running') };
    const s = summarize({ windows, statuses: more, badges: {} });
    expect(s.running).toBe(3);
    // w4 不在任何工作区：算进顶栏的总数，不算进任何框
    expect(s.runningByWorkspace).toEqual({ [WS_A]: 1, [WS_B]: 1 });
    const inFrames = Object.values(s.runningByWorkspace).reduce<number>((a, b) => a + (b ?? 0), 0);
    expect(inFrames).toBe(s.running - 1);
    // 在等你的不算 running；工作区里没有 running 的就没有这一项
    const none = summarize({ windows, statuses: { t2: snap('t2', 'needs-approval') }, badges: {} });
    expect(none.runningByWorkspace).toEqual({});
    expect(runningLabel(s.runningByWorkspace[WS_A])).toBe('1 running');
    expect(runningLabel(2)).toBe('2 running');
    expect(runningLabel(undefined)).toBe('');
    expect(runningLabel(0)).toBe('');
  });

  it('a window that set an attention badge also counts', () => {
    const badges = { w6: { text: 'Sign in', tone: 'attention' as const, dot: 'filled' as const } };
    expect(isWaiting(windows[5]!, { statuses, badges })).toBe(true);
    const s = summarize({ windows, statuses, badges });
    expect(s.waiting).toEqual(['w3', 'w2', 'w6']);
    expect(s.waitingByWorkspace[WS_B]).toBe(2);
  });

  it('updates when the status changes', () => {
    const next = { ...statuses, t2: snap('t2', 'running') };
    expect(summarize({ windows, statuses: next, badges: {} }).waiting).toEqual(['w3']);
  });

  it('⌘J cycles through waiting windows', () => {
    const list = ['w3', 'w2'] as WindowId[];
    expect(nextWaiting(list, null)).toBe('w3');
    expect(nextWaiting(list, 'w3' as WindowId)).toBe('w2');
    expect(nextWaiting(list, 'w2' as WindowId)).toBe('w3');
    expect(nextWaiting(list, 'w1' as WindowId)).toBe('w3');
    expect(nextWaiting([], null)).toBeNull();
  });

  it('⌘⇧J goes the other way, starting from the newest', () => {
    const list = ['w3', 'w2', 'w6'] as WindowId[];
    expect(prevWaiting(list, null)).toBe('w6');
    expect(prevWaiting(list, 'w1' as WindowId)).toBe('w6');
    expect(prevWaiting(list, 'w6' as WindowId)).toBe('w2');
    expect(prevWaiting(list, 'w2' as WindowId)).toBe('w3');
    expect(prevWaiting(list, 'w3' as WindowId)).toBe('w6');
    expect(prevWaiting(['w3'] as WindowId[], 'w3' as WindowId)).toBe('w3');
    expect(prevWaiting([], null)).toBeNull();
  });

  it('position of the focused window in the ⌘J order', () => {
    const list = ['w3', 'w2', 'w6'] as WindowId[];
    expect(waitingPosition(list, 'w2' as WindowId)).toBe(2);
    expect(waitingPosition(list, 'w3' as WindowId)).toBe(1);
    expect(waitingPosition(list, 'w1' as WindowId)).toBeNull();
    expect(waitingPosition(list, null)).toBeNull();
  });
});
