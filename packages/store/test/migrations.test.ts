import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { currentVersion, latestVersion, migrate, migrations, openStore } from '../src/index.ts';
import type { Migration } from '../src/index.ts';
import { project, tempDir } from './fixtures.ts';

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
    expect(tables(db)).toEqual(['approval_history', 'board', 'projects', 'schema_version', 'terminals', 'workspaces']);
    expect(currentVersion(db)).toBe(migrations.length);
  });

  it('does nothing the second time', () => {
    const db = new Database(':memory:');
    migrate(db);
    expect(migrate(db)).toEqual({ from: 1, to: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM schema_version').get()).toEqual({ n: 1 });
  });

  it('upgrades an existing file and keeps the data', () => {
    const file = join(tmp.dir, 'a.db');
    const store = openStore(file);
    store.projects.put(project());
    store.close();

    const v2: Migration = {
      version: 2,
      name: 'add-color',
      up: (db) => db.exec("ALTER TABLE projects ADD COLUMN color TEXT NOT NULL DEFAULT 'gray'"),
    };
    const db = new Database(file);
    expect(migrate(db, [...migrations, v2])).toEqual({ from: 1, to: 2 });
    expect(db.prepare('SELECT name, color FROM projects').get()).toEqual({ name: 'web', color: 'gray' });
    db.close();
  });

  it('rolls back a failing step and keeps the earlier ones', () => {
    const db = new Database(':memory:');
    const broken: Migration = {
      version: 2,
      name: 'broken',
      up(d) {
        d.exec('CREATE TABLE half_done (x INTEGER)');
        throw new Error('boom');
      },
    };
    expect(() => migrate(db, [...migrations, broken])).toThrow('boom');
    expect(currentVersion(db)).toBe(1);
    expect(tables(db)).not.toContain('half_done');
  });

  it('refuses a step that leaves broken foreign keys', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    const orphan: Migration = {
      version: 2,
      name: 'orphan',
      up: (d) =>
        d.exec(`INSERT INTO workspaces (id, project_id, name, mode, path, repos, created_at)
                VALUES ('w', 'missing-project', 'x', 'worktree', '/x', '[]', '2026-01-01')`),
    };
    expect(() => migrate(db, [...migrations, orphan])).toThrow(/broken references/);
    expect(currentVersion(db)).toBe(1);
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
    const gap: Migration = { version: 3, name: 'gap', up: () => {} };
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
