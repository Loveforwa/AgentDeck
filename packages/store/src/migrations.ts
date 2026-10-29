// 版本化迁移：schema_version 表记下已经跑过的迁移，启动时按序号把没跑过的依次跑完。
// 规则：已经发布的迁移不再修改，改表结构只能追加新的迁移。

import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { AgentDeckError } from '@agentdeck/contracts';

export interface Migration {
  /** 从 1 开始连续递增。 */
  version: number;
  name: string;
  up(db: Database): void;
}

export interface MigrateResult {
  from: number;
  to: number;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'initial',
    up(db) {
      db.exec(`
        -- 白板：只有一行，整份 BoardState 存成 JSON。
        CREATE TABLE board (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          state TEXT NOT NULL,
          saved_at TEXT NOT NULL
        );

        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          kind TEXT NOT NULL,
          path TEXT NOT NULL UNIQUE,
          repos TEXT NOT NULL,               -- JSON RepoRef[]
          worktree_root TEXT NOT NULL,
          copy_into_worktrees TEXT NOT NULL, -- JSON string[]
          setup_command TEXT,
          missing INTEGER NOT NULL DEFAULT 0,
          last_used_at TEXT NOT NULL
        );
        CREATE INDEX projects_last_used_at ON projects (last_used_at DESC);

        CREATE TABLE workspaces (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          mode TEXT NOT NULL,
          path TEXT NOT NULL,
          branch TEXT,
          repos TEXT NOT NULL,               -- JSON WorkspaceRepo[]
          created_at TEXT NOT NULL,
          missing INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX workspaces_project_id ON workspaces (project_id);
        -- 每个项目最多一个主目录工作区。
        CREATE UNIQUE INDEX workspaces_one_main_folder ON workspaces (project_id) WHERE mode = 'main-folder';

        -- 终端的恢复信息。一个白板窗口同一时间只对应一个终端。
        CREATE TABLE terminals (
          terminal_id TEXT PRIMARY KEY,
          window_id TEXT UNIQUE,
          workspace_id TEXT REFERENCES workspaces (id) ON DELETE CASCADE,
          agent TEXT NOT NULL,
          cmd TEXT NOT NULL,
          args TEXT NOT NULL,                -- JSON string[]
          cwd TEXT NOT NULL,
          session_id TEXT,
          start_command TEXT,
          last_status TEXT NOT NULL,
          exit_code INTEGER,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX terminals_workspace_id ON terminals (workspace_id);

        -- 批准记录（P1）。只追加，不改。
        CREATE TABLE approval_history (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          request_id TEXT NOT NULL,
          terminal_id TEXT NOT NULL,
          workspace_id TEXT REFERENCES workspaces (id) ON DELETE CASCADE,
          agent TEXT NOT NULL,
          kind TEXT NOT NULL,
          summary TEXT NOT NULL,
          command TEXT,
          destructive INTEGER NOT NULL,
          requested_at TEXT NOT NULL,
          by TEXT NOT NULL,
          at TEXT NOT NULL
        );
        CREATE INDEX approval_history_workspace_at ON approval_history (workspace_id, at DESC);
      `);
    },
  },
  {
    // M9 · SE1：AgentDeck 自己的 Session。terminals.session_id 原来存的是 agent 的会话 id，改名 agent_session_id，
    // session_id 改存 SessionId。白板上已有的终端窗口每个补一条 Session（见 sessionsFromBoard）。
    version: 2,
    name: 'sessions',
    up(db) {
      db.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          agent TEXT NOT NULL,
          -- 工作区删掉后 Session 留着（散放），父子关系不断
          workspace_id TEXT REFERENCES workspaces (id) ON DELETE SET NULL,
          cwd TEXT NOT NULL,
          parent_id TEXT REFERENCES sessions (id) ON DELETE SET NULL,
          origin TEXT NOT NULL,              -- JSON SessionOrigin
          label TEXT,
          title TEXT,
          terminal_id TEXT,                  -- 停了为 null
          state TEXT NOT NULL,
          handed_off_to TEXT REFERENCES sessions (id) ON DELETE SET NULL,
          handoff_note TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX sessions_parent_id ON sessions (parent_id, created_at);
        CREATE INDEX sessions_created_at ON sessions (created_at DESC);
        CREATE INDEX sessions_terminal_id ON sessions (terminal_id) WHERE terminal_id IS NOT NULL;

        -- 一条 Session 下面按先后挂的 agent 会话 id（/clear、compact、resume 各算一段）。
        CREATE TABLE session_agent_ids (
          session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
          seq INTEGER NOT NULL,
          agent_session_id TEXT NOT NULL,
          started_at TEXT NOT NULL,
          reason TEXT NOT NULL,
          PRIMARY KEY (session_id, seq)
        );
        CREATE INDEX session_agent_ids_agent_session_id ON session_agent_ids (agent_session_id);

        ALTER TABLE terminals RENAME COLUMN session_id TO agent_session_id;
        ALTER TABLE terminals ADD COLUMN session_id TEXT REFERENCES sessions (id) ON DELETE SET NULL;
      `);
      sessionsFromBoard(db, new Date().toISOString());
    },
  },
  {
    // M15 · DC2：文档里代码引用的核对结果缓存和“核对过”的记录（doc-service 的 CodeAnchorService）。
    // 文档按绝对路径记（每个 worktree 一份），不往仓库里写任何东西（TC-106）。
    version: 3,
    name: 'doc-anchors',
    up(db) {
      db.exec(`
        -- 上次核对的结果：按（文档、引用、基准、目标文件现在的哈希）。只留每篇文档最近一次用到的。
        CREATE TABLE doc_anchor_cache (
          doc_path TEXT NOT NULL,
          ref_key TEXT NOT NULL,             -- 路径、起止行、符号、钉住的版本
          baseline TEXT NOT NULL,            -- pinned:<rev> / verified:<blob> / blame:<commit> / worktree
          target_hash TEXT NOT NULL,         -- 工作区里被引用文件的 sha1
          result TEXT NOT NULL,              -- JSON：state、now、detail、text……
          checked_at TEXT NOT NULL,
          PRIMARY KEY (doc_path, ref_key, baseline, target_hash)
        );

        -- Mark as checked：以那时的文件内容为基准。blob 是 git 的 blob id（内容的哈希），全文在 doc_anchor_blobs。
        CREATE TABLE doc_anchor_verified (
          doc_path TEXT NOT NULL,
          ref_key TEXT NOT NULL,
          path TEXT NOT NULL,                -- 核对时被引用文件的路径（相对仓库根）
          start_line INTEGER NOT NULL,       -- 核对时在那个版本里的行号
          end_line INTEGER NOT NULL,
          blob TEXT NOT NULL REFERENCES doc_anchor_blobs (blob),
          lines_hash TEXT NOT NULL,          -- 这几行原文的 sha1
          verified_at TEXT NOT NULL,
          PRIMARY KEY (doc_path, ref_key)
        );
        CREATE INDEX doc_anchor_verified_blob ON doc_anchor_verified (blob);

        CREATE TABLE doc_anchor_blobs (
          blob TEXT PRIMARY KEY,
          text TEXT NOT NULL
        );
      `);
    },
  },
];

/**
 * 迁移 2 的升级部分：白板上每个还没有 session 的终端窗口补一条 Session，写回 TerminalWindowData.session；
 * WindowNode.group 转成父子：member 的 parentId 是同一组 lead 的那条，origin 记 spawn · open_terminals。
 * group 本身留在白板上（N2 侧边栏照旧用它停靠）。名字取 group.label，没有再取窗口的 Rename。
 * 有 terminalId 的记成 running（进程还在不在要等应用启动时对 tmux 才知道，SE2 对不上的改 stopped），没有的 stopped。
 * 窗口记着的 agent 会话 id 记成第一段，原因 unknown。白板读不出来时不动它，不让整个迁移失败。
 * 只用 SQL，不调仓储：仓储以后会改，已经发布的迁移不能跟着变。
 */
function sessionsFromBoard(db: Database, now: string): void {
  const row = db.prepare<[], { state: string }>('SELECT state FROM board WHERE id = 1').get();
  if (!row) return;
  let board: { version?: unknown; windows?: unknown };
  try {
    board = JSON.parse(row.state) as typeof board;
  } catch {
    return;
  }
  if (board.version !== 1 || !Array.isArray(board.windows)) return;

  type Obj = Record<string, unknown>;
  const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

  const workspaceExists = db.prepare<[string], { id: string }>('SELECT id FROM workspaces WHERE id = ?');
  const sessionExists = db.prepare<[string], { id: string }>('SELECT id FROM sessions WHERE id = ?');
  const insert = db.prepare(`
    INSERT INTO sessions (id, agent, workspace_id, cwd, parent_id, origin, label, title, terminal_id, state, handed_off_to, handoff_note, created_at, updated_at)
    VALUES (@id, @agent, @workspaceId, @cwd, NULL, @origin, @label, NULL, @terminalId, @state, NULL, NULL, @now, @now)
  `);
  const setParent = db.prepare<[string, string]>('UPDATE sessions SET parent_id = ? WHERE id = ?');
  const insertSegment = db.prepare(`
    INSERT INTO session_agent_ids (session_id, seq, agent_session_id, started_at, reason) VALUES (?, 1, ?, ?, 'unknown')
  `);
  const linkTerminal = db.prepare<[string, string]>('UPDATE terminals SET session_id = ? WHERE terminal_id = ?');

  interface Made {
    id: string;
    group: { id: string; role: string } | null;
    existing: boolean;
  }
  const made: Made[] = [];
  for (const w of board.windows) {
    if (!isObj(w) || w.type !== 'terminal' || !isObj(w.data)) continue;
    const data = w.data;
    const g = isObj(w.group) ? w.group : null;
    const group = g && str(g.id) ? { id: g.id as string, role: g.role === 'lead' ? 'lead' : 'member' } : null;
    const existing = str(data.session);
    if (existing) {
      // 已经有 session 的窗口不再补；库里真有那条时，它可以是别的窗口的 lead
      if (sessionExists.get(existing)) made.push({ id: existing, group, existing: true });
      continue;
    }
    const agent = str(data.agent);
    const cwd = str(data.cwd);
    if (!agent || !cwd) continue;
    const ws = str(w.workspaceId);
    const terminalId = str(data.terminalId);
    const id = randomUUID();
    insert.run({
      id,
      agent,
      workspaceId: ws && workspaceExists.get(ws) ? ws : null,
      cwd,
      origin: JSON.stringify(group?.role === 'member' ? { kind: 'spawn', tool: 'open_terminals' } : { kind: 'user' }),
      label: (g ? str(g.label) : null) ?? str(w.title),
      terminalId,
      state: terminalId ? 'running' : 'stopped',
      now,
    });
    const agentSessionId = str(data.sessionId);
    if (agentSessionId) insertSegment.run(id, agentSessionId, now);
    if (terminalId) linkTerminal.run(id, terminalId);
    data.session = id;
    made.push({ id, group, existing: false });
  }
  if (!made.some((m) => !m.existing)) return;

  const leads = new Map<string, string>();
  for (const m of made) if (m.group?.role === 'lead' && !leads.has(m.group.id)) leads.set(m.group.id, m.id);
  for (const m of made) {
    if (m.existing || m.group?.role !== 'member') continue;
    const lead = leads.get(m.group.id);
    if (lead) setParent.run(lead, m.id);
  }
  db.prepare<[string]>('UPDATE board SET state = ? WHERE id = 1').run(JSON.stringify(board));
}

export function latestVersion(list: readonly Migration[] = migrations): number {
  return list.length === 0 ? 0 : list[list.length - 1]!.version;
}

export function currentVersion(db: Database): number {
  ensureVersionTable(db);
  const row = db.prepare<[], { v: number | null }>('SELECT MAX(version) AS v FROM schema_version').get();
  return row?.v ?? 0;
}

/**
 * 把数据库升级到 list 里的最新版本。每个迁移单独一个事务，失败时这一步整个回滚并抛错，
 * 之前成功的步骤保留。
 */
export function migrate(db: Database, list: readonly Migration[] = migrations): MigrateResult {
  checkList(list);
  const from = currentVersion(db);
  const to = latestVersion(list);
  if (from > to) {
    throw new AgentDeckError({
      code: 'unsupported',
      message: 'The database was created by a newer version of AgentDeck.',
      detail: `schema version ${from}, this build knows up to ${to}`,
    });
  }
  if (from === to) return { from, to };

  // 迁移里可能要重建表（SQLite 改列只能建新表再拷数据），期间外键检查要关掉，
  // 跑完再整体查一遍。foreign_keys 在事务里改不了，所以放在事务外面。
  const fkWasOn = db.pragma('foreign_keys', { simple: true }) === 1;
  db.pragma('foreign_keys = OFF');
  try {
    const record = db.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)');
    for (const m of list) {
      if (m.version <= from) continue;
      db.transaction(() => {
        m.up(db);
        const broken = db.pragma('foreign_key_check') as unknown[];
        if (broken.length > 0) {
          throw new AgentDeckError({
            code: 'internal',
            message: 'Database migration left broken references.',
            detail: `migration ${m.version} (${m.name}): ${JSON.stringify(broken)}`,
          });
        }
        record.run(m.version, m.name, new Date().toISOString());
      })();
    }
  } finally {
    if (fkWasOn) db.pragma('foreign_keys = ON');
  }
  return { from, to };
}

function ensureVersionTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
}

function checkList(list: readonly Migration[]): void {
  list.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new AgentDeckError({
        code: 'internal',
        message: 'Database migrations are out of order.',
        detail: `expected version ${i + 1}, got ${m.version} (${m.name})`,
      });
    }
  });
}
