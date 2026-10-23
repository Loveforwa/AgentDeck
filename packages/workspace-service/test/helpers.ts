import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Project, ProjectEvent, ProjectId, Workspace, WorkspaceEvent, WorkspaceId } from '@agentdeck/contracts';
import { createGitService } from '@agentdeck/git-service';
import { createWorkspaceServices, type ProjectRepository, type WorkspaceRepository } from '../src/index.ts';

/** 内存里的仓储，行为和 packages/store 一致：path 唯一、删项目级联删工作区、每个项目最多一个主目录工作区。 */
export function memoryRepos(): { projects: ProjectRepository; workspaces: WorkspaceRepository } {
  const projects = new Map<ProjectId, Project>();
  const workspaces = new Map<WorkspaceId, Workspace>();
  const clone = <T>(v: T): T => structuredClone(v);
  return {
    projects: {
      list: () => [...projects.values()].sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt)).map(clone),
      get: (id) => clone(projects.get(id) ?? null),
      findByPath: (path) => clone([...projects.values()].find((p) => p.path === path) ?? null),
      put(p) {
        if ([...projects.values()].some((o) => o.path === p.path && o.id !== p.id)) throw new Error('UNIQUE constraint failed: projects.path');
        projects.set(p.id, clone(p));
      },
      touch(id, at) {
        const p = projects.get(id);
        if (p) p.lastUsedAt = at;
        return !!p;
      },
      remove(id) {
        for (const w of [...workspaces.values()]) if (w.projectId === id) workspaces.delete(w.id);
        return projects.delete(id);
      },
    },
    workspaces: {
      list: () => [...workspaces.values()].map(clone),
      listByProject: (id) => [...workspaces.values()].filter((w) => w.projectId === id).map(clone),
      get: (id) => clone(workspaces.get(id) ?? null),
      put(w) {
        if (!projects.has(w.projectId)) throw new Error('FOREIGN KEY constraint failed');
        if (w.mode === 'main-folder' && [...workspaces.values()].some((o) => o.projectId === w.projectId && o.mode === 'main-folder' && o.id !== w.id))
          throw new Error('UNIQUE constraint failed: workspaces.project_id');
        workspaces.set(w.id, clone(w));
      },
      remove: (id) => workspaces.delete(id),
    },
  };
}

export const TEST_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'AgentDeck Test',
  GIT_AUTHOR_EMAIL: 'test@agentdeck.invalid',
  GIT_COMMITTER_NAME: 'AgentDeck Test',
  GIT_COMMITTER_EMAIL: 'test@agentdeck.invalid',
};

export function tempDir(prefix = 'agentdeck-ws-'): { path: string; cleanup: () => void } {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

export function setup(homeDir: string) {
  const events: (ProjectEvent | WorkspaceEvent)[] = [];
  const trashed: string[] = [];
  const git = createGitService({ env: TEST_ENV, moveToTrash: async (p) => void trashed.push(p) });
  const repos = memoryRepos();
  let n = 0;
  const services = createWorkspaceServices({
    git,
    ...repos,
    emit: (e) => events.push(e),
    homeDir,
    newId: () => `id-${++n}`,
  });
  return { ...services, git, repos, events, trashed };
}
