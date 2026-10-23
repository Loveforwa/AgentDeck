// WorkspaceService 的假实现：worktree 通过 FakeGitService 建和删，项目信息来自 FakeProjectService。

import type {
  AbsPath,
  CreateWorkspaceRequest,
  CreateWorkspaceResult,
  RemoveWorkspaceRequest,
  RepoRef,
  Workspace,
  WorkspaceId,
  WorkspaceRepo,
  WorkspaceService,
} from '@agentdeck/contracts';
import { FakeEventBus } from './bus.ts';
import { FakeGitService } from './git-service.ts';
import { FakeProjectService } from './project-service.ts';
import { clone, fail, idGenerator, nowIso, slug } from './util.ts';

export interface FakeWorkspaceServiceOptions {
  bus?: FakeEventBus;
  projects: FakeProjectService;
  git?: FakeGitService;
}

export class FakeWorkspaceService implements WorkspaceService {
  readonly bus: FakeEventBus;
  private readonly projects: FakeProjectService;
  private readonly git: FakeGitService;
  private readonly workspaces = new Map<WorkspaceId, Workspace>();
  private readonly nextId = idGenerator();

  constructor(opts: FakeWorkspaceServiceOptions) {
    this.bus = opts.bus ?? opts.projects.bus;
    this.projects = opts.projects;
    this.git = opts.git ?? opts.projects.git;
    // 项目被移除时它的工作区一起从白板移除（不删文件夹）
    this.bus.on('project.removed', ({ id }) => {
      for (const ws of [...this.workspaces.values()]) {
        if (ws.projectId !== id) continue;
        this.workspaces.delete(ws.id);
        this.bus.emit({ type: 'workspace.removed', id: ws.id });
      }
    });
  }

  async create(req: CreateWorkspaceRequest): Promise<CreateWorkspaceResult> {
    const project = this.projects.get(req.projectId);
    if (project.missing) fail('not-found', `Folder not found: ${project.path}`);
    const repos = this.pickRepos(project.repos, req.repos);

    if (req.mode === 'main-folder') {
      if ([...this.workspaces.values()].some((w) => w.projectId === project.id && w.mode === 'main-folder')) {
        fail('invalid-argument', 'This project already has a main folder workspace');
      }
      const wsRepos: WorkspaceRepo[] = [];
      for (const r of repos) wsRepos.push({ name: r.name, path: r.path, branch: (await this.git.status(r.path)).branch });
      const branches = new Set(wsRepos.map((r) => r.branch));
      const ws = this.insert({
        projectId: project.id,
        name: req.name ?? project.name,
        mode: 'main-folder',
        path: project.path,
        branch: branches.size === 1 ? (wsRepos[0]?.branch ?? null) : null,
        repos: wsRepos,
      });
      return { workspace: ws, setup: null };
    }

    if (project.kind === 'plain') fail('invalid-argument', 'A folder without git can only use the main folder');
    const branch = req.branch;
    if (!branch) fail('invalid-argument', 'Choose a branch for the new worktree');
    const dir = `${project.worktreeRoot}/${slug(branch.name)}`;
    const multi = project.kind === 'multi-repo';
    const created: { repo: RepoRef; path: AbsPath }[] = [];
    try {
      for (const r of repos) {
        const path = multi ? `${dir}/${r.name}` : dir;
        this.progress(project.id, 'worktree', `Creating worktree for ${r.name === '.' ? project.name : r.name}`, r.name);
        await this.git.addWorktree(
          r.path,
          path,
          branch.kind === 'new' ? { name: branch.name, create: true, from: branch.from } : { name: branch.name, create: false },
        );
        created.push({ repo: r, path });
      }
    } catch (err) {
      // 多仓库时任何一个失败，已经建好的全部回滚
      for (const c of created.reverse()) {
        await this.git.removeWorktree(c.repo.path, c.path, { force: true }).catch(() => undefined);
        if (branch.kind === 'new') {
          try {
            this.git.deleteBranch(c.repo.path, branch.name);
          } catch {
            // 回滚尽力而为
          }
        }
      }
      throw err;
    }
    if (project.copyIntoWorktrees.length > 0) {
      this.progress(project.id, 'copy-files', `Copying ${project.copyIntoWorktrees.join(', ')}`);
    }
    const ws = this.insert({
      projectId: project.id,
      name: req.name ?? branch.name,
      mode: 'worktree',
      path: dir,
      branch: branch.name,
      repos: created.map((c) => ({ name: c.repo.name, path: c.path, branch: branch.name })),
    });
    this.progress(project.id, 'done', `Workspace ${ws.name} is ready`);
    return { workspace: ws, setup: project.setupCommand ? { command: project.setupCommand, cwd: ws.path } : null };
  }

  async list(): Promise<Workspace[]> {
    return [...this.workspaces.values()].map((w) => clone(w));
  }

  async rename(id: WorkspaceId, name: string): Promise<Workspace> {
    const ws = this.require(id);
    if (!name.trim()) fail('invalid-argument', 'Workspace name is empty');
    ws.name = name.trim();
    this.emitChanged(ws);
    return clone(ws);
  }

  async remove(req: RemoveWorkspaceRequest): Promise<void> {
    const ws = this.require(req.id);
    if (req.deleteFolder && ws.mode === 'worktree') {
      const project = this.projects.get(ws.projectId);
      for (const r of ws.repos) {
        const repoPath = project.repos.find((p) => p.name === r.name)?.path ?? r.path;
        // 界面已经确认过，所以带 force，见 CONTRACT_NOTES.md
        await this.git.removeWorktree(repoPath, r.path, { force: true });
      }
    }
    this.workspaces.delete(ws.id);
    this.bus.emit({ type: 'workspace.removed', id: ws.id });
  }

  // ---- 假实现专用 ----

  /** 直接放进一个工作区（预置数据用），不发事件，也不建 worktree。 */
  seed(ws: Workspace): void {
    this.workspaces.set(ws.id, clone(ws));
  }

  setMissing(id: WorkspaceId, missing: boolean): void {
    const ws = this.require(id);
    ws.missing = missing;
    this.emitChanged(ws);
  }

  get(id: WorkspaceId): Readonly<Workspace> {
    return this.require(id);
  }

  // ---- 内部 ----

  private require(id: WorkspaceId): Workspace {
    const ws = this.workspaces.get(id);
    if (!ws) fail('not-found', `Workspace ${id} not found`);
    return ws;
  }

  private pickRepos(all: RepoRef[], names: string[] | undefined): RepoRef[] {
    if (!names) return all;
    if (names.length === 0) fail('invalid-argument', 'Choose at least one repository');
    return names.map((n) => {
      const r = all.find((x) => x.name === n);
      if (!r) fail('invalid-argument', `No repository named ${n}`);
      return r;
    });
  }

  private insert(init: Omit<Workspace, 'id' | 'createdAt' | 'missing'>): Workspace {
    const ws: Workspace = { id: this.nextId<WorkspaceId>('ws'), ...init, createdAt: nowIso(), missing: false };
    this.workspaces.set(ws.id, ws);
    this.projects.touch(ws.projectId);
    this.emitChanged(ws);
    return clone(ws);
  }

  private progress(projectId: Workspace['projectId'], step: 'worktree' | 'copy-files' | 'done', message: string, repo?: string): void {
    this.bus.emit(
      repo === undefined
        ? { type: 'workspace.progress', projectId, step, message }
        : { type: 'workspace.progress', projectId, step, repo, message },
    );
  }

  private emitChanged(ws: Workspace): void {
    this.bus.emit({ type: 'workspace.changed', workspace: clone(ws) });
  }
}
