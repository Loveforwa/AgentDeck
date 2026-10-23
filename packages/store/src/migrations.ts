// 版本化迁移：schema_version 表记下已经跑过的迁移，启动时按序号把没跑过的依次跑完。
// 规则：已经发布的迁移不再修改，改表结构只能追加新的迁移。

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
];

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
