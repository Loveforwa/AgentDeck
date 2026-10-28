import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { currentVersion, latestVersion, migrate, migrations, openStore } from '../src/index.ts';
import type { Migration } from '../src/index.ts';
import type { AgentSessionId, BoardState, SessionId, TerminalId, TerminalWindowData, WindowGroupRef, WindowNode } from '@agentdeck/contracts';
import { board, project, tempDir, workspace } from './fixtures.ts';

let tmp: ReturnType<typeof tempDir>;
beforeEach(() => {
  tmp = tempDir();
});
afterEach(() => tmp.cleanup());

function tables(db: Database.Database): string[] {
  return db
    .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
}

describe('migrate', () => {
  it('creates every table on an empty database', () => {
    const db = new Database(':memory:');
    expect(migrate(db)).toEqual({ from: 0, to: latestVersion() });
    expect(tables(db)).toEqual([
      'approval_history',
      'board',
      'projects',
      'schema_version',
      'session_agent_ids',
      'sessions',
      'terminals',
      'workspaces',
    ]);
    expect(currentVersion(db)).toBe(migrations.length);
  });

  it('does nothing the second time', () => {
    const db = new Database(':memory:');
    migrate(db);
    const n = latestVersion();
    expect(migrate(db)).toEqual({ from: n, to: n });
    expect(db.prepare('SELECT COUNT(*) AS n FROM schema_version').get()).toEqual({ n });
  });

  it('upgrades an existing file and keeps the data', () => {
    const file = join(tmp.dir, 'a.db');
    const store = openStore(file);
    store.projects.put(project());
    store.close();

    const n = latestVersion();
    const next: Migration = {
      version: n + 1,
      name: 'add-color',
      up: (db) => db.exec("ALTER TABLE projects ADD COLUMN color TEXT NOT NULL DEFAULT 'gray'"),
    };
    const db = new Database(file);
    expect(migrate(db, [...migrations, next])).toEqual({ from: n, to: n + 1 });
    expect(db.prepare('SELECT name, color FROM projects').get()).toEqual({ name: 'web', color: 'gray' });
    db.close();
  });

  it('rolls back a failing step and keeps the earlier ones', () => {
    const db = new Database(':memory:');
    const broken: Migration = {
      version: latestVersion() + 1,
      name: 'broken',
      up(d) {
        d.exec('CREATE TABLE half_done (x INTEGER)');
        throw new Error('boom');
      },
    };
    expect(() => migrate(db, [...migrations, broken])).toThrow('boom');
    expect(currentVersion(db)).toBe(latestVersion());
    expect(tables(db)).not.toContain('half_done');
  });

  it('refuses a step that leaves broken foreign keys', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    const orphan: Migration = {
      version: latestVersion() + 1,
      name: 'orphan',
      up: (d) =>
        d.exec(`INSERT INTO workspaces (id, project_id, name, mode, path, repos, created_at)
                VALUES ('w', 'missing-project', 'x', 'worktree', '/x', '[]', '2026-01-01')`),
    };
    expect(() => migrate(db, [...migrations, orphan])).toThrow(/broken references/);
    expect(currentVersion(db)).toBe(latestVersion());
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('refuses a database from a newer build', () => {
    const db = new Database(':memory:');
    migrate(db);
    db.prepare("INSERT INTO schema_version VALUES (99, 'future', '2030-01-01')").run();
    expect(() => migrate(db)).toThrow(/newer version/);
  });

  it('rejects a migration list with gaps', () => {
    const db = new Database(':memory:');
    const gap: Migration = { version: latestVersion() + 2, name: 'gap', up: () => {} };
    expect(() => migrate(db, [...migrations, gap])).toThrow(/out of order/);
  });
});

describe('openStore', () => {
  it('creates the parent folder and reports the schema version', () => {
    const file = join(tmp.dir, 'nested', 'dir', 'agentdeck.db');
    const store = openStore(file);
    expect(store.schemaVersion()).toBe(latestVersion());
    store.close();

    const db = new Database(file);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    db.close();
  });
});

describe('migration 2 · sessions (SE1, TC-55)', () => {
  /** 用迁移 1 建一个旧库，写进项目、工作区、终端记录和白板。 */
  function oldDatabase(file: string, state: BoardState | string): void {
    const db = new Database(file);
    migrate(db, migrations.slice(0, 1));
    const p = project();
    const w = workspace();
    db.prepare(
      `INSERT INTO projects (id, name, kind, path, repos, worktree_root, copy_into_worktrees, setup_command, missing, last_used_at)
       VALUES (?, ?, ?, ?, '[]', ?, '[]', NULL, 0, ?)`,
    ).run(p.id, p.name, p.kind, p.path, p.worktreeRoot, p.lastUsedAt);
    db.prepare(
      `INSERT INTO workspaces (id, project_id, name, mode, path, branch, repos, created_at, missing)
       VALUES (?, ?, ?, ?, ?, ?, '[]', ?, 0)`,
    ).run(w.id, w.projectId, w.name, w.mode, w.path, w.branch, w.createdAt);
    const term = db.prepare(
      `INSERT INTO terminals (terminal_id, window_id, workspace_id, agent, cmd, args, cwd, session_id, start_command, last_status, exit_code, updated_at)
       VALUES (?, NULL, 'w1', ?, ?, '[]', '/w', ?, NULL, 'idle', NULL, '2026-10-20T10:00:00.000Z')`,
    );
    term.run('t-lead', 'claude', 'claude', 'conv-lead');
    term.run('t-api', 'codex', 'codex', null);
    term.run('t-old', 'claude', 'claude', 'conv-old'); // 白板上没有它的窗口
    db.prepare("INSERT INTO board (id, state, saved_at) VALUES (1, ?, '2026-10-20T10:00:00.000Z')").run(
      typeof state === 'string' ? state : JSON.stringify(state),
    );
    db.close();
  }

  function termWindow(id: string, data: Partial<TerminalWindowData>, over: Partial<WindowNode> = {}): WindowNode {
    return {
      id: id as WindowNode['id'],
      type: 'terminal',
      workspaceId: 'w1' as WindowNode['workspaceId'],
      rect: { x: 0, y: 0, w: 600, h: 400 },
      z: 1,
      title: null,
      restoreRect: null,
      data: { terminalId: null, agent: 'claude', cmd: 'claude', args: [], cwd: '/w', sessionId: null, startCommand: null, ...data },
      ...over,
    };
  }
  const group = (role: 'lead' | 'member', label: string | null = null): WindowGroupRef => ({
    id: 'g1' as WindowGroupRef['id'],
    role,
    label,
  });

  const oldBoard = (): BoardState =>
    board({
      windows: [
        termWindow('lead', { terminalId: 't-lead' as TerminalId, sessionId: 'conv-lead' as AgentSessionId }, { group: group('lead') }),
        termWindow('api', { terminalId: 't-api' as TerminalId, agent: 'codex', cmd: 'codex' }, { group: group('member', 'api') }),
        termWindow('ui', { agent: 'codex', cmd: 'codex' }, { group: group('member', 'ui') }),
        termWindow('loose', { agent: 'shell', cmd: '/bin/zsh' }, { workspaceId: null, title: 'dev server' }),
        termWindow('gone-ws', {}, { workspaceId: 'w-deleted' as WindowNode['workspaceId'] }),
        board().windows[1]!, // 网页窗口
      ],
    });

  it('creates a Session for every terminal window, turns the group into parent links and writes data.session back', async () => {
    const file = join(tmp.dir, 'old.db');
    oldDatabase(file, oldBoard());
    const store = openStore(file);
    expect(store.schemaVersion()).toBe(latestVersion());

    const saved = await store.board.load();
    const byWindow = new Map(saved.windows.map((w) => [w.id as string, w]));
    const sessionOf = (id: string) => (byWindow.get(id)!.data as TerminalWindowData).session!;
    for (const id of ['lead', 'api', 'ui', 'loose', 'gone-ws']) expect(sessionOf(id)).toEqual(expect.any(String));
    expect((byWindow.get('win2')!.data as { session?: unknown }).session).toBeUndefined();
    // 窗口组留在白板上，侧边栏照旧用它
    expect(byWindow.get('api')!.group).toEqual(group('member', 'api'));

    const all = store.sessions.list();
    expect(all).toHaveLength(5);
    const lead = store.sessions.get(sessionOf('lead'))!;
    expect(lead).toMatchObject({
      agent: 'claude',
      workspaceId: 'w1',
      cwd: '/w',
      parentId: null,
      origin: { kind: 'user' },
      terminalId: 't-lead',
      state: 'running',
    });
    expect(lead.agentSessions.map((s) => [s.id, s.reason])).toEqual([['conv-lead', 'unknown']]);
    expect(store.sessions.findByAgentSession('claude', 'conv-lead' as AgentSessionId)?.id).toBe(lead.id);

    const kids = store.sessions.listByParent(lead.id);
    expect(kids.map((k) => [k.label, k.agent, k.origin, k.state])).toEqual([
      ['api', 'codex', { kind: 'spawn', tool: 'open_terminals' }, 'running'],
      ['ui', 'codex', { kind: 'spawn', tool: 'open_terminals' }, 'stopped'],
    ]);
    expect(store.sessions.get(sessionOf('loose'))).toMatchObject({ workspaceId: null, label: 'dev server', parentId: null, agentSessions: [] });
    // 工作区已经不在库里：Session 当散放的
    expect(store.sessions.get(sessionOf('gone-ws'))?.workspaceId).toBeNull();

    // 终端记录：原来的 agent 会话 id 还在，session 指向新建的那条；白板上没有的记录不动（进程还在不在由启动时的 prune 决定）
    expect(store.terminals.get('t-lead' as TerminalId)).toMatchObject({ sessionId: 'conv-lead', session: lead.id });
    expect(store.terminals.get('t-api' as TerminalId)?.session).toBe(sessionOf('api'));
    expect(store.terminals.get('t-old' as TerminalId)).toMatchObject({ sessionId: 'conv-old', session: null });
    store.close();

    // 再开一次不会重复补
    const again = openStore(file);
    expect(again.sessions.list()).toHaveLength(5);
    again.close();
  });

  it('keeps a session the window already has, and never links to a session that is not in the database', async () => {
    const file = join(tmp.dir, 'partial.db');
    const b = oldBoard();
    (b.windows[0]!.data as TerminalWindowData).session = 'ses-existing' as SessionId;
    oldDatabase(file, b);
    const store = openStore(file);
    const saved = await store.board.load();
    expect((saved.windows[0]!.data as TerminalWindowData).session).toBe('ses-existing');
    expect(store.sessions.list()).toHaveLength(4);
    // 那条 Session 不在库里，外键不能断：子 session 不挂父
    expect(store.sessions.list().every((s) => s.parentId === null)).toBe(true);
    store.close();
  });

  it('upgrades even when the saved board cannot be read', () => {
    const file = join(tmp.dir, 'broken.db');
    oldDatabase(file, '{not json');
    const store = openStore(file);
    expect(store.schemaVersion()).toBe(latestVersion());
    expect(store.sessions.list()).toEqual([]);
    expect(store.terminals.get('t-lead' as TerminalId)?.sessionId).toBe('conv-lead');
    store.close();
  });
});
