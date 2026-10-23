import type { Database } from 'better-sqlite3';
import type { ProjectId, Workspace, WorkspaceId, WorkspaceMode, WorkspaceRepo } from '@agentdeck/contracts';
import type { WorkspaceRepository } from './types.ts';

interface WorkspaceRow {
  id: string;
  project_id: string;
  name: string;
  mode: string;
  path: string;
  branch: string | null;
  repos: string;
  created_at: string;
  missing: number;
}

type WorkspaceParams = Record<string, string | number | null>;

export function createWorkspaceRepository(db: Database): WorkspaceRepository {
  const list = db.prepare<[], WorkspaceRow>('SELECT * FROM workspaces ORDER BY created_at, id');
  const byProject = db.prepare<[string], WorkspaceRow>(
    'SELECT * FROM workspaces WHERE project_id = ? ORDER BY created_at, id',
  );
  const get = db.prepare<[string], WorkspaceRow>('SELECT * FROM workspaces WHERE id = ?');
  const put = db.prepare<WorkspaceParams>(`
    INSERT INTO workspaces (id, project_id, name, mode, path, branch, repos, created_at, missing)
    VALUES (@id, @projectId, @name, @mode, @path, @branch, @repos, @createdAt, @missing)
    ON CONFLICT (id) DO UPDATE SET
      project_id = excluded.project_id,
      name = excluded.name,
      mode = excluded.mode,
      path = excluded.path,
      branch = excluded.branch,
      repos = excluded.repos,
      created_at = excluded.created_at,
      missing = excluded.missing
  `);
  const remove = db.prepare<[string]>('DELETE FROM workspaces WHERE id = ?');

  return {
    list: () => list.all().map(toWorkspace),
    listByProject: (projectId) => byProject.all(projectId).map(toWorkspace),
    get(id) {
      const row = get.get(id);
      return row ? toWorkspace(row) : null;
    },
    put(w) {
      put.run({
        id: w.id,
        projectId: w.projectId,
        name: w.name,
        mode: w.mode,
        path: w.path,
        branch: w.branch,
        repos: JSON.stringify(w.repos),
        createdAt: w.createdAt,
        missing: w.missing ? 1 : 0,
      });
    },
    remove: (id) => remove.run(id).changes > 0,
  };
}

function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id as WorkspaceId,
    projectId: row.project_id as ProjectId,
    name: row.name,
    mode: row.mode as WorkspaceMode,
    path: row.path,
    branch: row.branch,
    repos: JSON.parse(row.repos) as WorkspaceRepo[],
    createdAt: row.created_at,
    missing: row.missing !== 0,
  };
}
