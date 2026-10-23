import type { Database } from 'better-sqlite3';
import type { AbsPath, IsoTime, Project, ProjectId, ProjectKind, RepoRef } from '@agentdeck/contracts';
import type { ProjectRepository } from './types.ts';

interface ProjectRow {
  id: string;
  name: string;
  kind: string;
  path: string;
  repos: string;
  worktree_root: string;
  copy_into_worktrees: string;
  setup_command: string | null;
  missing: number;
  last_used_at: string;
}

type ProjectParams = Record<string, string | number | null>;

export function createProjectRepository(db: Database): ProjectRepository {
  const list = db.prepare<[], ProjectRow>('SELECT * FROM projects ORDER BY last_used_at DESC, name');
  const get = db.prepare<[string], ProjectRow>('SELECT * FROM projects WHERE id = ?');
  const byPath = db.prepare<[string], ProjectRow>('SELECT * FROM projects WHERE path = ?');
  // 不能用 INSERT OR REPLACE：它会先删旧行，把工作区级联删掉。
  const put = db.prepare<ProjectParams>(`
    INSERT INTO projects (id, name, kind, path, repos, worktree_root, copy_into_worktrees, setup_command, missing, last_used_at)
    VALUES (@id, @name, @kind, @path, @repos, @worktreeRoot, @copyIntoWorktrees, @setupCommand, @missing, @lastUsedAt)
    ON CONFLICT (id) DO UPDATE SET
      name = excluded.name,
      kind = excluded.kind,
      path = excluded.path,
      repos = excluded.repos,
      worktree_root = excluded.worktree_root,
      copy_into_worktrees = excluded.copy_into_worktrees,
      setup_command = excluded.setup_command,
      missing = excluded.missing,
      last_used_at = excluded.last_used_at
  `);
  const touch = db.prepare<[string, string]>('UPDATE projects SET last_used_at = ? WHERE id = ?');
  const remove = db.prepare<[string]>('DELETE FROM projects WHERE id = ?');

  return {
    list: () => list.all().map(toProject),
    get: (id) => nullable(get.get(id)),
    findByPath: (path: AbsPath) => nullable(byPath.get(path)),
    put(p) {
      put.run({
        id: p.id,
        name: p.name,
        kind: p.kind,
        path: p.path,
        repos: JSON.stringify(p.repos),
        worktreeRoot: p.worktreeRoot,
        copyIntoWorktrees: JSON.stringify(p.copyIntoWorktrees),
        setupCommand: p.setupCommand,
        missing: p.missing ? 1 : 0,
        lastUsedAt: p.lastUsedAt,
      });
    },
    touch: (id, at: IsoTime) => touch.run(at, id).changes > 0,
    remove: (id) => remove.run(id).changes > 0,
  };
}

function nullable(row: ProjectRow | undefined): Project | null {
  return row ? toProject(row) : null;
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id as ProjectId,
    name: row.name,
    kind: row.kind as ProjectKind,
    path: row.path,
    repos: JSON.parse(row.repos) as RepoRef[],
    worktreeRoot: row.worktree_root,
    copyIntoWorktrees: JSON.parse(row.copy_into_worktrees) as string[],
    setupCommand: row.setup_command,
    missing: row.missing !== 0,
    lastUsedAt: row.last_used_at,
  };
}
