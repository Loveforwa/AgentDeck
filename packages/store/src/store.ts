// openStore：打开（或新建）数据库，升级结构，返回白板和各个仓储。

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { createApprovalRepository } from './approvals.ts';
import { createBoardStore } from './board.ts';
import { currentVersion, migrate } from './migrations.ts';
import { createProjectRepository } from './projects.ts';
import { createTerminalRepository } from './terminals.ts';
import type { Store } from './types.ts';
import { createWorkspaceRepository } from './workspaces.ts';

/**
 * @param path 数据库文件路径，由调用方决定（应用里是 ~/.agentdeck/agentdeck.db）。
 *   ':memory:' 开内存库，测试用。文件所在的文件夹不存在时会建出来。
 */
export function openStore(path: string): Store {
  const inMemory = path === ':memory:' || path === '';
  if (!inMemory) mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  try {
    if (!inMemory) {
      // WAL：写的时候不挡读，掉电也不会写坏。
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
    }
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
    migrate(db);
  } catch (e) {
    db.close();
    throw e;
  }

  return {
    board: createBoardStore(db),
    projects: createProjectRepository(db),
    workspaces: createWorkspaceRepository(db),
    terminals: createTerminalRepository(db),
    approvals: createApprovalRepository(db),
    transaction: (fn) => db.transaction(fn)(),
    schemaVersion: () => currentVersion(db),
    close: () => db.close(),
  };
}
