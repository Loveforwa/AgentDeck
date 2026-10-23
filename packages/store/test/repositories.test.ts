import type { AgentSessionId, ProjectId, TerminalId, WindowId, WorkspaceId } from '@agentdeck/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore } from '../src/index.ts';
import type { Store } from '../src/index.ts';
import { approval, project, terminal, workspace } from './fixtures.ts';

let store: Store;
beforeEach(() => {
  store = openStore(':memory:');
});
afterEach(() => store.close());

const p2 = 'p2' as ProjectId;
const w2 = 'w2' as WorkspaceId;

describe('projects', () => {
  it('round-trips a project, including JSON columns and nulls', () => {
    const p = project();
    store.projects.put(p);
    expect(store.projects.get(p.id)).toEqual(p);

    const plain = project({ id: p2, kind: 'plain', path: '/tmp/notes', repos: [], copyIntoWorktrees: [], setupCommand: null, missing: true });
    store.projects.put(plain);
    expect(store.projects.get(p2)).toEqual(plain);
  });

  it('returns null for unknown ids and paths', () => {
    expect(store.projects.get('nope' as ProjectId)).toBeNull();
    expect(store.projects.findByPath('/nope')).toBeNull();
  });

  it('finds a project by folder', () => {
    store.projects.put(project());
    expect(store.projects.findByPath('/Users/me/code/web')?.id).toBe('p1');
  });

  it('lists the most recently used first, and touch moves a project up', () => {
    store.projects.put(project({ id: 'old' as ProjectId, path: '/a', lastUsedAt: '2026-01-01T00:00:00.000Z' }));
    store.projects.put(project({ id: 'new' as ProjectId, path: '/b', lastUsedAt: '2026-06-01T00:00:00.000Z' }));
    expect(store.projects.list().map((p) => p.id)).toEqual(['new', 'old']);

    expect(store.projects.touch('old' as ProjectId, '2026-07-01T00:00:00.000Z')).toBe(true);
    expect(store.projects.list().map((p) => p.id)).toEqual(['old', 'new']);
    expect(store.projects.touch('nope' as ProjectId, '2026-07-01T00:00:00.000Z')).toBe(false);
  });

  it('updates in place without dropping its workspaces', () => {
    store.projects.put(project());
    store.workspaces.put(workspace());
    store.projects.put(project({ name: 'renamed', setupCommand: null }));
    expect(store.projects.get('p1' as ProjectId)).toMatchObject({ name: 'renamed', setupCommand: null });
    expect(store.workspaces.list()).toHaveLength(1);
  });

  it('refuses two projects on the same folder', () => {
    store.projects.put(project());
    expect(() => store.projects.put(project({ id: p2 }))).toThrow(/UNIQUE/);
  });

  it('removing a project removes its workspaces, terminals and approvals', () => {
    store.projects.put(project());
    store.workspaces.put(workspace());
    store.terminals.put(terminal());
    store.approvals.add(approval());

    expect(store.projects.remove('p1' as ProjectId)).toBe(true);
    expect(store.workspaces.list()).toEqual([]);
    expect(store.terminals.list()).toEqual([]);
    expect(store.approvals.history('w1' as WorkspaceId, 10)).toEqual([]);
    expect(store.projects.remove('p1' as ProjectId)).toBe(false);
  });
});

describe('workspaces', () => {
  beforeEach(() => {
    store.projects.put(project());
    store.projects.put(project({ id: p2, path: '/other' }));
  });

  it('round-trips a workspace', () => {
    const w = workspace();
    store.workspaces.put(w);
    expect(store.workspaces.get(w.id)).toEqual(w);

    const main = workspace({ id: w2, mode: 'main-folder', branch: null, repos: [], missing: true });
    store.workspaces.put(main);
    expect(store.workspaces.get(w2)).toEqual(main);
  });

  it('lists by creation time and by project', () => {
    store.workspaces.put(workspace({ id: 'b' as WorkspaceId, createdAt: '2026-10-03T00:00:00.000Z' }));
    store.workspaces.put(workspace({ id: 'a' as WorkspaceId, createdAt: '2026-10-01T00:00:00.000Z' }));
    store.workspaces.put(workspace({ id: 'c' as WorkspaceId, projectId: p2, createdAt: '2026-10-02T00:00:00.000Z' }));
    expect(store.workspaces.list().map((w) => w.id)).toEqual(['a', 'c', 'b']);
    expect(store.workspaces.listByProject('p1' as ProjectId).map((w) => w.id)).toEqual(['a', 'b']);
  });

  it('updates in place', () => {
    store.workspaces.put(workspace());
    store.workspaces.put(workspace({ name: 'Login page' }));
    expect(store.workspaces.list()).toHaveLength(1);
    expect(store.workspaces.get('w1' as WorkspaceId)?.name).toBe('Login page');
  });

  it('needs an existing project', () => {
    expect(() => store.workspaces.put(workspace({ projectId: 'ghost' as ProjectId }))).toThrow(/FOREIGN KEY/);
  });

  it('allows only one main-folder workspace per project', () => {
    store.workspaces.put(workspace({ id: 'm1' as WorkspaceId, mode: 'main-folder' }));
    expect(() => store.workspaces.put(workspace({ id: 'm2' as WorkspaceId, mode: 'main-folder' }))).toThrow(/UNIQUE/);
    store.workspaces.put(workspace({ id: 'm3' as WorkspaceId, projectId: p2, mode: 'main-folder' }));
  });

  it('removing a workspace removes its terminals but not scattered ones', () => {
    store.workspaces.put(workspace());
    store.terminals.put(terminal());
    store.terminals.put(terminal({ terminalId: 't2' as TerminalId, windowId: 'win2' as WindowId, workspaceId: null }));
    expect(store.workspaces.remove('w1' as WorkspaceId)).toBe(true);
    expect(store.terminals.list().map((t) => t.terminalId)).toEqual(['t2']);
  });
});

describe('terminals', () => {
  beforeEach(() => {
    store.projects.put(project());
    store.workspaces.put(workspace());
  });

  it('round-trips a record', () => {
    const t = terminal();
    store.terminals.put(t);
    expect(store.terminals.get(t.terminalId)).toEqual(t);
    expect(store.terminals.getByWindow('win1' as WindowId)).toEqual(t);

    const shell = terminal({
      terminalId: 't2' as TerminalId,
      windowId: null,
      workspaceId: null,
      agent: 'shell',
      cmd: 'zsh',
      args: [],
      sessionId: null,
      startCommand: 'pnpm dev',
      lastStatus: 'exited',
      exitCode: 0,
    });
    store.terminals.put(shell);
    expect(store.terminals.get(shell.terminalId)).toEqual(shell);
  });

  it('replaces the old terminal of a window when it is restored under a new id', () => {
    store.terminals.put(terminal());
    store.terminals.put(terminal({ terminalId: 't9' as TerminalId, updatedAt: '2026-10-03T00:00:00.000Z' }));
    expect(store.terminals.list().map((t) => t.terminalId)).toEqual(['t9']);
    expect(store.terminals.getByWindow('win1' as WindowId)?.terminalId).toBe('t9');
  });

  it('keeps several background terminals without a window', () => {
    store.terminals.put(terminal({ windowId: null }));
    store.terminals.put(terminal({ terminalId: 't2' as TerminalId, windowId: null }));
    expect(store.terminals.list()).toHaveLength(2);
  });

  it('records the last status and the session id', () => {
    store.terminals.put(terminal({ sessionId: null }));
    expect(store.terminals.updateStatus('t1' as TerminalId, 'error', 1, '2026-10-02T10:00:00.000Z')).toBe(true);
    expect(store.terminals.updateSession('t1' as TerminalId, 's-9' as AgentSessionId, '2026-10-02T10:00:01.000Z')).toBe(true);
    expect(store.terminals.get('t1' as TerminalId)).toMatchObject({
      lastStatus: 'error',
      exitCode: 1,
      sessionId: 's-9',
      updatedAt: '2026-10-02T10:00:01.000Z',
    });
    expect(store.terminals.updateStatus('nope' as TerminalId, 'idle', null)).toBe(false);
  });

  it('lists newest first, and by workspace', () => {
    store.terminals.put(terminal({ terminalId: 'a' as TerminalId, windowId: null, updatedAt: '2026-10-01T00:00:00.000Z' }));
    store.terminals.put(terminal({ terminalId: 'b' as TerminalId, windowId: null, updatedAt: '2026-10-05T00:00:00.000Z' }));
    store.terminals.put(terminal({ terminalId: 'c' as TerminalId, windowId: null, workspaceId: null, updatedAt: '2026-10-03T00:00:00.000Z' }));
    expect(store.terminals.list().map((t) => t.terminalId)).toEqual(['b', 'c', 'a']);
    expect(store.terminals.listByWorkspace('w1' as WorkspaceId).map((t) => t.terminalId)).toEqual(['b', 'a']);
  });

  it('removes a record', () => {
    store.terminals.put(terminal());
    expect(store.terminals.remove('t1' as TerminalId)).toBe(true);
    expect(store.terminals.get('t1' as TerminalId)).toBeNull();
    expect(store.terminals.remove('t1' as TerminalId)).toBe(false);
  });
});

describe('approvals', () => {
  beforeEach(() => {
    store.projects.put(project());
    store.workspaces.put(workspace());
    store.workspaces.put(workspace({ id: w2 }));
  });

  it('round-trips a record', () => {
    const r = approval();
    store.approvals.add(r);
    expect(store.approvals.history('w1' as WorkspaceId, 10)).toEqual([r]);
  });

  it('returns the newest first, limited, per workspace', () => {
    store.approvals.add(approval({ id: 'r1', at: '2026-10-02T09:00:00.000Z' }));
    store.approvals.add(approval({ id: 'r2', at: '2026-10-02T11:00:00.000Z' }));
    store.approvals.add(approval({ id: 'r3', at: '2026-10-02T10:00:00.000Z' }));
    store.approvals.add(approval({ id: 'other', workspaceId: w2 }));
    expect(store.approvals.history('w1' as WorkspaceId, 2).map((r) => r.request.id)).toEqual(['r2', 'r3']);
    expect(store.approvals.history(w2, 10).map((r) => r.request.id)).toEqual(['other']);
  });
});

describe('transaction', () => {
  it('rolls back every write when the function throws', () => {
    store.projects.put(project());
    expect(() =>
      store.transaction(() => {
        store.projects.put(project({ name: 'changed' }));
        store.workspaces.put(workspace());
        store.terminals.put(terminal());
        throw new Error('abort');
      }),
    ).toThrow('abort');
    expect(store.projects.get('p1' as ProjectId)?.name).toBe('web');
    expect(store.workspaces.list()).toEqual([]);
    expect(store.terminals.list()).toEqual([]);
  });

  it('commits and returns the value when the function succeeds', () => {
    const n = store.transaction(() => {
      store.projects.put(project());
      store.workspaces.put(workspace());
      return store.workspaces.list().length;
    });
    expect(n).toBe(1);
    expect(store.workspaces.list()).toHaveLength(1);
  });

  it('rolls back only the inner part of a nested transaction', () => {
    store.transaction(() => {
      store.projects.put(project());
      try {
        store.transaction(() => {
          store.workspaces.put(workspace());
          throw new Error('inner');
        });
      } catch {
        // 外层继续
      }
    });
    expect(store.projects.list()).toHaveLength(1);
    expect(store.workspaces.list()).toEqual([]);
  });
});
